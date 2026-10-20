const BUSY = 'Browser UI may be capturing input (a tab drag or native menu). Finish that interaction, then observe the page before deciding whether to try again. Never replay an unknown outcome automatically.';

export function inputMode(args) {
  const mode = args.mode ?? 'native';
  if (!['native', 'dom'].includes(mode)) throw new Error('mode must be native or dom');
  return mode;
}

async function bounded(operation, message, ms = 5000) {
  let timer;
  try { return await Promise.race([operation, new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${message} Outcome is unknown. ${BUSY}`)), ms);
  })]); }
  finally { clearTimeout(timer); }
}

export function createInput(cdp, value) {
  const pending = new Map();
  function event(tabId, method, params) {
    const operation = pending.get(tabId);
    if (!operation) return;
    if (method === 'Page.javascriptDialogOpening') {
      operation.reject(new Error('The key action opened a JavaScript dialog. It may already have executed; use browser_snapshot and browser_handle_dialog before continuing.'));
    }
    if (method !== 'Runtime.bindingCalled' || params.name !== operation.name || !operation.contexts.has(params.executionContextId)) return;
    try { if (JSON.parse(params.payload).delivered === true) operation.resolve(); }
    catch (error) { operation.reject(error); }
  }
  function cancel(tabId) { pending.get(tabId)?.reject(new Error('Tab detached during keyboard input; outcome is unknown. Observe before retrying.')); }

  async function pressKey(tabId, chord) {
    const { params, text } = keyParameters(chord);
    const name = `__attachKey_${crypto.randomUUID().replaceAll('-', '')}`;
    const contexts = new Set(), guards = [], omittedFrames = [];
    const receipt = new Promise((resolve, reject) => pending.set(tabId, { name, contexts, resolve, reject }));
    receipt.catch(() => {});
    try {
      const { frameTree } = await cdp(tabId, 'Page.getFrameTree');
      const frames = [];
      const collect = tree => { frames.push(tree.frame.id); (tree.childFrames || []).forEach(collect); };
      collect(frameTree);
      // Tab may move focus between frames. Listen in every available frame;
      // the bindings remain in isolated worlds, inaccessible to page scripts.
      for (const frameId of frames) {
        let contextId;
        try {
          const { executionContextId } = await cdp(tabId, 'Page.createIsolatedWorld', { frameId, worldName: 'browser-attach-input' });
          if (!executionContextId) throw new Error('Could not create keyboard verification context; no input was dispatched.');
          contextId = executionContextId;
          contexts.add(executionContextId);
          await cdp(tabId, 'Runtime.addBinding', { name, executionContextId });
          const installed = await cdp(tabId, 'Runtime.evaluate', {
            contextId: executionContextId, expression: `(${installKeyReceipt.toString()})(${JSON.stringify(name)},${JSON.stringify(params)})`,
            objectGroup: 'browser-attach',
          });
          if (installed.exceptionDetails) value(installed);
          if (!installed.result?.objectId) throw new Error('Could not install keyboard verification; no input was dispatched.');
          guards.push(installed.result.objectId);
        } catch (error) {
          if (frameId === frameTree.frame.id) throw error;
          // An inaccessible or concurrently reloading child must not prevent
          // keys in the main document. Such a child cannot verify delivery.
          contexts.delete(contextId);
          omittedFrames.push({ frame_id: frameId, reason: error.message });
        }
      }
      // Queue the complete chord before waiting for acknowledgements. Always
      // enqueue keyUp, even if keyDown fails or opens a modal.
      const commands = [cdp(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params })];
      if (text != null) commands.push(cdp(tabId, 'Input.dispatchKeyEvent', { type: 'char', text, unmodifiedText: text, ...params }));
      commands.push(cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...params }));
      await bounded(Promise.all([Promise.all(commands), receipt]), 'Keyboard input did not finish with verified delivery within 5 seconds.');
      return { sent: chord, method: 'native', delivery_verified: true, application_result: 'not_checked',
        ...(omittedFrames.length ? { verification_omitted_frames: omittedFrames } : {}), observe_again: true };
    } finally {
      pending.delete(tabId);
      const cleanup = [cdp(tabId, 'Runtime.removeBinding', { name }), ...guards.map(objectId =>
        cdp(tabId, 'Runtime.callFunctionOn', { objectId, functionDeclaration: 'function() { this.stop(); }' }))];
      await bounded(Promise.allSettled(cleanup), 'Keyboard verification cleanup timed out.', 250).catch(() => {});
    }
  }

  async function fill(tabId, node, args) {
    if (!node || typeof args.text !== 'string') throw new Error('fill requires a fresh ref and text');
    const mode = inputMode(args);
    value(await cdp(tabId, 'Runtime.callFunctionOn', { objectId: node.objectId, returnByValue: true,
      functionDeclaration: prepareFill.toString(), arguments: [{ value: mode }, { value: args.text }] }));
    if (mode === 'native') await bounded(cdp(tabId, 'Input.insertText', { text: args.text }), 'Text input did not finish within 5 seconds.');
    const matches = value(await cdp(tabId, 'Runtime.callFunctionOn', { objectId: node.objectId, returnByValue: true,
      functionDeclaration: verifyFill.toString(), arguments: [{ value: args.text }] }));
    if (matches !== true) throw new Error(`Fill did not retain the requested text. Input may have been swallowed, focus may have moved, or the page may have reformatted it. Outcome is unknown. ${BUSY}`);
    return { filled: true, method: mode, value_verified: true, ...(mode === 'dom' ? { events_trusted: false } : {}), observe_again: true };
  }

  async function domClick(tabId, node, args) {
    if (!node || args.x != null || args.y != null) throw new Error('DOM click requires a fresh ref; coordinates are unsupported.');
    const result = value(await cdp(tabId, 'Runtime.callFunctionOn', { objectId: node.objectId, returnByValue: true,
      functionDeclaration: clickElement.toString() }));
    return { ...result, method: 'dom', events_trusted: false, application_result: 'not_checked', observe_again: true };
  }
  return { pressKey, fill, domClick, event, cancel };
}

function installKeyReceipt(name, params) {
  const report = globalThis[name];
  function listener(event) {
    const modifiers = (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
    if (event.isTrusted && event.code === params.code && event.key === params.key && modifiers === params.modifiers) {
      report(JSON.stringify({ delivered: true })); stop();
    }
  }
  let expiry;
  function stop() { clearTimeout(expiry); globalThis.removeEventListener('keydown', listener, true); delete globalThis[name]; }
  globalThis.addEventListener('keydown', listener, true);
  expiry = setTimeout(stop, 10000);
  return { stop };
}

function keyParameters(chord) {
  if (typeof chord !== 'string') throw new Error('key must be a string');
  const modifiers = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Shift: 8 };
  const named = { Enter: [13, 'Enter'], Tab: [9, 'Tab'], Escape: [27, 'Escape'], Backspace: [8, 'Backspace'],
    Delete: [46, 'Delete'], ArrowLeft: [37, 'ArrowLeft'], ArrowRight: [39, 'ArrowRight'], ArrowUp: [38, 'ArrowUp'], ArrowDown: [40, 'ArrowDown'],
    Home: [36, 'Home'], End: [35, 'End'], PageUp: [33, 'PageUp'], PageDown: [34, 'PageDown'], Space: [32, 'Space'] };
  const parts = chord.split('+'), last = parts.pop();
  let mask = 0;
  for (const part of parts) { if (!modifiers[part]) throw new Error(`Unknown modifier: ${part}`); mask |= modifiers[part]; }
  let key = last, entry = named[key];
  if (!entry && /^[a-zA-Z0-9]$/.test(key)) {
    entry = [key.toUpperCase().charCodeAt(0), /^[0-9]$/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`];
    key = mask & 8 ? key.toUpperCase() : key.toLowerCase();
  }
  if (!entry) throw new Error('Unsupported key. Use a named navigation key or an ASCII letter/digit chord.');
  const params = { key: last === 'Space' ? ' ' : key, code: entry[1], windowsVirtualKeyCode: entry[0], nativeVirtualKeyCode: entry[0], modifiers: mask };
  let text;
  if (mask === 0 && ['Enter', 'Tab', 'Space'].includes(last)) text = { Enter: '\r', Tab: '\t', Space: ' ' }[last];
  else if ((mask & ~8) === 0 && /^[a-zA-Z0-9]$/.test(last)) text = key;
  return { params, text };
}

function prepareFill(mode, text) {
  const tag = this.tagName?.toLowerCase();
  if (!this.isConnected) throw new Error('Field is detached');
  if (this.disabled || this.readOnly || this.closest('[inert]')) throw new Error('Field is disabled, read-only or inert');
  if (!['input', 'textarea'].includes(tag) && !this.isContentEditable) throw new Error('Ref is not an editable field');
  if (tag === 'input' && !['text', 'search', 'email', 'password', 'tel', 'url', ''].includes(this.type)) throw new Error('Input type cannot be filled with text');
  if (mode === 'dom') {
    const win = this.ownerDocument.defaultView;
    if (this.isContentEditable) this.textContent = text;
    else {
      const prototype = tag === 'textarea' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(this, text);
    }
    this.dispatchEvent(new win.InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText', data: text }));
    this.dispatchEvent(new win.Event('change', { bubbles: true }));
  } else {
    this.focus();
    const active = this.getRootNode().activeElement;
    if (active !== this && !this.contains(active)) throw new Error('Field did not receive focus');
    if (this.isContentEditable) {
      const range = this.ownerDocument.createRange(); range.selectNodeContents(this);
      const selection = this.ownerDocument.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    } else this.select();
  }
  return true;
}

function verifyFill(text) {
  // Native editing may represent line breaks using nested blocks or <br>.
  return this.isConnected && (this.isContentEditable ? this.textContent === text || this.innerText === text : this.value === text);
}

function clickElement() {
  const element = this.nodeType === 3 ? this.parentElement : this;
  if (!element?.isConnected) throw new Error('Element is detached');
  if (element.matches(':disabled') || element.closest('[inert]')) throw new Error('Element is disabled or inert');
  const win = element.ownerDocument.defaultView, rect = element.getBoundingClientRect(), style = win.getComputedStyle(element);
  if (style.visibility !== 'visible' || !rect.width || !rect.height) throw new Error('Element is not visible');
  if (!(element instanceof win.HTMLElement)) throw new Error('DOM click supports HTML elements only; use native input for this ref.');
  win.HTMLElement.prototype.click.call(element);
  return { clicked: true };
}
