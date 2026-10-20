// Browser operations live here so the WebSocket transport cannot execute arbitrary CDP/JavaScript.
import { createVisuals } from './visuals.js';

export function createController(api, notify = () => {}) {
  const claims = new Map();
  const snapshots = new Map();
  const queues = new Map();
  const dialogs = new Map();
  const fileChoosers = new Map();
  const dialogWaiters = new Map();
  const visuals = createVisuals(api);

  function queued(tabId, operation) {
    const result = (queues.get(tabId) || Promise.resolve()).catch(() => {}).then(operation);
    queues.set(tabId, result);
    const done = () => { if (queues.get(tabId) === result) queues.delete(tabId); };
    result.then(done, done);
    return result;
  }

  function httpUrl(url) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('Only http(s) pages without URL credentials can be controlled');
    }
    return parsed.href;
  }

  async function cdp(tabId, method, params = {}) {
    if (!method.startsWith('Input.') && method !== 'Runtime.callFunctionOn' && method !== 'Page.navigate' && method !== 'DOM.setFileInputFiles') {
      return await api.debugger.sendCommand({ tabId }, method, params);
    }
    // Input handlers may open a modal and prevent the CDP response from returning.
    // Free the tab queue so the next tool can observe and resolve that modal.
    let rejectDialog;
    const dialog = new Promise((resolve, reject) => { rejectDialog = reject; });
    const waiters = dialogWaiters.get(tabId) || new Set();
    dialogWaiters.set(tabId, waiters);
    waiters.add(rejectDialog);
    try {
      return await Promise.race([api.debugger.sendCommand({ tabId }, method, params), dialog]);
    } finally {
      waiters.delete(rejectDialog);
      if (waiters.size === 0) dialogWaiters.delete(tabId);
    }
  }

  function value(result) {
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }

  async function getObject(tabId, ref) {
    const node = snapshots.get(tabId)?.get(ref);
    if (!node) throw new Error('Element ref is stale or unknown. Take a new browser_snapshot.');
    const resolved = await cdp(tabId, 'DOM.resolveNode', { backendNodeId: node.backendNodeId, objectGroup: 'browser-bridge' });
    if (!resolved.object?.objectId) throw new Error('Element no longer exists. Take a new browser_snapshot.');
    return { ...node, objectId: resolved.object.objectId };
  }

  async function viewport(tabId) {
    return value(await cdp(tabId, 'Runtime.evaluate', {
      expression: '({width: innerWidth, height: innerHeight, scroll_x: scrollX, scroll_y: scrollY, device_pixel_ratio: devicePixelRatio})', returnByValue: true,
    }));
  }

  function position(view, x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= view.width || y >= view.height) {
      throw new Error(`Position must be inside the viewport (${view.width} x ${view.height} CSS pixels)`);
    }
    return { x, y };
  }

  async function release(tabId) {
    if (!claims.has(tabId)) return;
    // Forget only after detach; a failed detach must not silently grant another owner.
    try { await visuals.remove(tabId, dialogs.has(tabId)); }
    finally { await api.debugger.detach({ tabId }); }
    claims.delete(tabId);
    snapshots.delete(tabId);
    dialogs.delete(tabId);
    fileChoosers.delete(tabId);
    notify({ type: 'detached', tab_id: tabId });
  }

  async function releaseMatching(predicate) {
    const targets = [...claims.entries()].filter(([, claim]) => predicate(claim));
    const outcomes = await Promise.allSettled(targets.map(([tabId]) => queued(tabId, () => release(tabId))));
    return { released: outcomes.filter(item => item.status === 'fulfilled').length,
      errors: outcomes.filter(item => item.status === 'rejected').map(item => String(item.reason)) };
  }

  function forget(tabId) {
    visuals.forget(tabId);
    claims.delete(tabId);
    snapshots.delete(tabId);
    dialogs.delete(tabId);
    fileChoosers.delete(tabId);
    notify({ type: 'detached', tab_id: tabId });
  }
  api.debugger.onDetach.addListener(source => forget(source.tabId));
  api.debugger.onEvent.addListener((source, method, params = {}) => {
    if (method === 'DOM.documentUpdated' || method === 'Page.frameNavigated') {
      snapshots.delete(source.tabId);
      fileChoosers.delete(source.tabId);
    }
    if (method === 'Page.fileChooserOpened' && claims.has(source.tabId)) {
      if (params.backendNodeId) fileChoosers.set(source.tabId, {
        backendNodeId: params.backendNodeId, mode: params.mode, frame_id: params.frameId,
      });
    }
    if (method === 'Page.frameNavigated' && !params.frame?.parentId) visuals.navigated(source.tabId);
    if (method === 'Page.javascriptDialogOpening') {
      dialogs.set(source.tabId, { type: params.type, message: params.message, default_prompt: params.defaultPrompt });
      snapshots.delete(source.tabId);
      for (const reject of dialogWaiters.get(source.tabId) || []) {
        reject(new Error('The action opened a JavaScript dialog. It may already have executed; use browser_snapshot and browser_handle_dialog before continuing.'));
      }
    }
    if (method === 'Page.javascriptDialogClosed') dialogs.delete(source.tabId);
  });
  api.tabs.onRemoved.addListener(forget);
  api.tabs.onUpdated.addListener((tabId, change) => {
    if (change.url || change.status === 'loading') { snapshots.delete(tabId); fileChoosers.delete(tabId); }
  });

  async function snapshot(tabId, maxNodes) {
    if (!Number.isInteger(maxNodes) || maxNodes < 10 || maxNodes > 3000) throw new Error('max_nodes must be 10..3000');
    snapshots.delete(tabId);
    await cdp(tabId, 'Runtime.releaseObjectGroup', { objectGroup: 'browser-bridge' });
    const { frameTree } = await cdp(tabId, 'Page.getFrameTree');
    const frames = [];
    const flatten = tree => { frames.push(tree.frame); (tree.childFrames || []).forEach(flatten); };
    flatten(frameTree);
    const knownFrames = new Set(frames.map(frame => frame.id));
    const token = crypto.randomUUID().slice(0, 8);
    const refs = new Map();
    const lines = [];
    const omittedFrames = [];
    let count = 0;
    let truncated = false;
    let serializedChars = 0;
    let truncationReason = null;
    const append = line => {
      // Leave room for MCP envelopes and JSON escaping in hosts with small tool budgets.
      const size = JSON.stringify(line).length;
      if (serializedChars + size > 14000) { truncated = true; truncationReason = 'text_budget'; return false; }
      serializedChars += size;
      lines.push(line); return true;
    };
    for (const frame of frames) {
      if (truncated || count >= maxNodes) {
        truncated = true; truncationReason ||= 'node_limit';
        omittedFrames.push({ frame_id: frame.id, url: frame.url, reason: 'snapshot_budget' });
        continue;
      }
      let nodes;
      try {
        ({ nodes } = await cdp(tabId, 'Accessibility.getFullAXTree', { frameId: frame.id }));
      } catch (error) {
        if (frame.id === frameTree.frame.id) throw error;
        omittedFrames.push({ frame_id: frame.id, url: frame.url, reason: error.message });
        continue;
      }
      // Out-of-process frames may be absent from Page.getFrameTree. Their AX
      // iframe owners still let us report coverage instead of silently omitting them.
      for (const node of nodes) {
        if (!/^iframe$/i.test(node.role?.value || '') || !node.backendDOMNodeId) continue;
        const { node: owner } = await cdp(tabId, 'DOM.describeNode', { backendNodeId: node.backendDOMNodeId, depth: 0 });
        const childId = owner.frameId || owner.contentDocument?.frameId;
        if (!childId || knownFrames.has(childId)) continue;
        const attributes = owner.attributes || [];
        const srcIndex = attributes.indexOf('src');
        const url = srcIndex >= 0 ? new URL(attributes[srcIndex + 1], frame.url).href : 'about:blank';
        knownFrames.add(childId);
        frames.push({ id: childId, url });
      }
      if (!append(`Frame ${frame.id} ${frame.url}`)) continue;
      const byId = new Map(nodes.map(node => [node.nodeId, node]));
      const visited = new Set();
      const render = (node, depth) => {
        if (!node || visited.has(node.nodeId)) return;
        visited.add(node.nodeId);
        if (truncated || count >= maxNodes) { truncated = true; truncationReason ||= 'node_limit'; return; }
        let nextDepth = depth;
        if (!node.ignored) {
          const ref = node.backendDOMNodeId ? `${token}:${refs.size + 1}` : null;
          const attributes = (node.properties || []).filter(prop =>
            ['disabled', 'focused', 'expanded', 'checked', 'selected', 'required'].includes(prop.name)
          ).map(prop => `${prop.name}=${JSON.stringify(prop.value?.value)}`).join(' ');
          if (!append(`${'  '.repeat(Math.min(depth, 24))}${ref ? `[${ref}] ` : ''}${node.role?.value || 'node'} ${JSON.stringify(String(node.name?.value || '').slice(0, 1000))}${attributes ? ' ' + attributes : ''}`)) return;
          if (ref) refs.set(ref, { backendNodeId: node.backendDOMNodeId });
          count++;
          nextDepth++;
        }
        for (const child of node.childIds || []) render(byId.get(child), nextDepth);
      };
      render(nodes[0], 0);
    }
    snapshots.set(tabId, refs);
    const tab = await api.tabs.get(tabId);
    return { title: tab.title, url: tab.url, snapshot_id: token, snapshot: lines.join('\n'), node_count: count, truncated,
      truncation_reason: truncationReason, viewport: await viewport(tabId),
      omitted_frames: omittedFrames,
      note: omittedFrames.length ? 'Some frames were not read; see omitted_frames for coverage and reasons. Screenshot coordinate actions remain available.' : 'Refs expire after actions, navigation or another snapshot.' };
  }

  const modifiers = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Shift: 8 };
  const namedKeys = {
    Enter: [13, 'Enter'], Tab: [9, 'Tab'], Escape: [27, 'Escape'], Backspace: [8, 'Backspace'],
    Delete: [46, 'Delete'], ArrowLeft: [37, 'ArrowLeft'], ArrowRight: [39, 'ArrowRight'],
    ArrowUp: [38, 'ArrowUp'], ArrowDown: [40, 'ArrowDown'], Home: [36, 'Home'], End: [35, 'End'],
    PageUp: [33, 'PageUp'], PageDown: [34, 'PageDown'], Space: [32, 'Space'],
  };
  async function pressKey(tabId, chord) {
    if (typeof chord !== 'string') throw new Error('key must be a string');
    const parts = chord.split('+');
    const last = parts.pop();
    let mask = 0;
    for (const part of parts) {
      if (!modifiers[part]) throw new Error(`Unknown modifier: ${part}`);
      mask |= modifiers[part];
    }
    let key = last;
    let entry = namedKeys[key];
    if (!entry && /^[a-zA-Z0-9]$/.test(key)) {
      entry = [key.toUpperCase().charCodeAt(0), /^[0-9]$/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`];
      key = mask & 8 ? key.toUpperCase() : key.toLowerCase();
    }
    if (!entry) throw new Error('Unsupported key. Use a named navigation key or an ASCII letter/digit chord.');
    const params = { key: last === 'Space' ? ' ' : key, code: entry[1], windowsVirtualKeyCode: entry[0],
      nativeVirtualKeyCode: entry[0], modifiers: mask };
    await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params });
    try {
      if (mask === 0 && ['Enter', 'Tab', 'Space'].includes(last)) {
        const text = { Enter: '\r', Tab: '\t', Space: ' ' }[last];
        await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'char', text, unmodifiedText: text, ...params });
      } else if ((mask & ~8) === 0 && /^[a-zA-Z0-9]$/.test(last)) {
        await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'char', text: key, unmodifiedText: key, ...params });
      }
    } finally {
      await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...params });
    }
  }

  async function action(tabId, command, args) {
    if (command === 'handle_dialog') {
      if (typeof args.accept !== 'boolean') throw new Error('accept must be a boolean');
      await cdp(tabId, 'Page.handleJavaScriptDialog', { accept: args.accept,
        ...(args.prompt_text != null ? { promptText: String(args.prompt_text) } : {}) });
      dialogs.delete(tabId);
      snapshots.delete(tabId);
      return { handled: true, observe_again: true };
    }
    if (dialogs.has(tabId)) {
      if (command === 'snapshot') return { dialog: dialogs.get(tabId), note: 'Use browser_handle_dialog to accept or dismiss this dialog.' };
      if (command !== 'release_tab') throw new Error('A JavaScript dialog is open. Observe browser_snapshot and use browser_handle_dialog.');
    }
    if (command === 'snapshot') return await snapshot(tabId, args.max_nodes ?? 600);
    if (command === 'read_text') {
      const limit = args.max_chars ?? 20000;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100000) throw new Error('max_chars must be 1..100000');
      return value(await cdp(tabId, 'Runtime.evaluate', { returnByValue: true,
        expression: `(() => { const text = document.body?.innerText || ''; return {title: document.title, url: location.href, text: text.slice(0, ${limit}), returned_chars: Math.min(text.length, ${limit}), truncated: text.length > ${limit}, scope: 'main_frame'}; })()` }));
    }
    if (command === 'screenshot') {
      const view = await viewport(tabId);
      const clip = args.full_page ? await fullPageClip(tabId) : null;
      const includeIndicators = args.include_indicators === true;
      const hiddenError = includeIndicators ? null : await visuals.visible(tabId, false);
      if (hiddenError) throw new Error(`Could not hide the agent indicator for a clean screenshot: ${hiddenError}`);
      try {
        // Render an explicit target surface without activating its tab or window.
        const captureClip = clip || { x: view.scroll_x, y: view.scroll_y, width: view.width, height: view.height, scale: 1 };
        let timer;
        let result;
        try {
          result = await Promise.race([
            cdp(tabId, 'Page.captureScreenshot', { format: 'png', fromSurface: true,
              captureBeyondViewport: true, optimizeForSpeed: true, clip: captureClip }),
            new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(
              'Screenshot did not finish within 5 seconds. An inactive or occluded Chromium page may not render. The bridge will not activate the tab; use DOM/AX, or explicitly view the page before requesting another screenshot.'
            )), 5000); }),
          ]);
        } finally { clearTimeout(timer); }
        return { ...result, capture: { scope: clip ? 'full_page' : 'viewport', viewport: view,
          css_width: clip?.width ?? view.width, css_height: clip?.height ?? view.height,
          image_origin_css: { x: clip ? 0 : view.scroll_x, y: clip ? 0 : view.scroll_y },
          click_coordinate_space: 'viewport_css_pixels', agent_indicators_included: includeIndicators } };
      } finally { await visuals.visible(tabId, true); }
    }
    if (command === 'release_tab') { await release(tabId); return { released: true }; }
    if (command === 'navigate') {
      const url = httpUrl(args.url);
      snapshots.delete(tabId);
      fileChoosers.delete(tabId);
      const result = await cdp(tabId, 'Page.navigate', { url });
      if (result.errorText) throw new Error(result.errorText);
      return { navigating_to: url, note: 'Navigation started. Read a fresh snapshot to observe its state.' };
    }
    // Resolve the ref before consuming it; every input invalidates the whole observation.
    const node = args.ref ? await getObject(tabId, args.ref) : null;
    snapshots.delete(tabId);
    if (command === 'upload_file') {
      if (!Array.isArray(args.files) || args.files.length > 100 || args.files.some(file => typeof file !== 'string' || !file || file.includes('\0'))) {
        throw new Error('files must contain at most 100 valid absolute file paths; [] clears selection');
      }
      const chooser = fileChoosers.get(tabId);
      let target = node;
      if (!target) {
        if (!chooser) throw new Error('No pending file chooser. Supply a fresh file-input/label ref, or click the upload button first.');
        const resolved = await cdp(tabId, 'DOM.resolveNode', { backendNodeId: chooser.backendNodeId, objectGroup: 'browser-bridge' });
        if (!resolved.object?.objectId) throw new Error('File chooser input no longer exists. Observe again.');
        target = { objectId: resolved.object.objectId };
      }
      const resolved = await cdp(tabId, 'Runtime.callFunctionOn', {
        objectId: target.objectId, arguments: [{ value: args.files.length }],
        functionDeclaration: `function(count) {
          const input = this.tagName === 'LABEL' ? this.control : this;
          if (!input || input.tagName !== 'INPUT' || input.type !== 'file') throw new Error('Ref is not a file input or associated label');
          if (!input.isConnected) throw new Error('File input is detached');
          if (input.matches(':disabled')) throw new Error('File input is disabled');
          if (input.webkitdirectory) throw new Error('Directory upload is unsupported; use a regular file input');
          if (count > 1 && !input.multiple) throw new Error('Single-file input cannot accept multiple files');
          return input;
        }`, objectGroup: 'browser-bridge',
      });
      if (resolved.exceptionDetails) value(resolved);
      if (!resolved.result?.objectId) throw new Error('Could not resolve the file input');
      if (args.files.length === 0) {
        // Chromium's native empty-path assignment does not emit input/change.
        // Like Playwright's empty payload path, explicitly clear and notify the app.
        value(await cdp(tabId, 'Runtime.callFunctionOn', { objectId: resolved.result.objectId, returnByValue: true,
          functionDeclaration: `function() {
            this.value = '';
            const Event = this.ownerDocument.defaultView.Event;
            this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            this.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }` }));
      } else {
        // Native CDP assignment emits input/change and preserves actual file metadata.
        await cdp(tabId, 'DOM.setFileInputFiles', { objectId: resolved.result.objectId, files: args.files });
      }
      fileChoosers.delete(tabId);
      return { files_set: args.files.length, cleared: args.files.length === 0, observe_again: true };
    }
    if (command === 'click') {
      if ((args.ref != null) === (args.x != null || args.y != null)) throw new Error('Provide either ref or x/y');
      let point;
      if (node) {
        await cdp(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: node.backendNodeId });
        const { quads } = await cdp(tabId, 'DOM.getContentQuads', { backendNodeId: node.backendNodeId });
        const view = await viewport(tabId);
        for (const quad of quads || []) {
          const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
          const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
          if (x >= 0 && y >= 0 && x < view.width && y < view.height) { point = position(view, x, y); break; }
        }
        if (!point) throw new Error('Element has no visible click point. Inspect a screenshot.');
        // Ref clicks must not accidentally activate an overlay covering the element.
        const { backendNodeId } = await cdp(tabId, 'DOM.getNodeForLocation', { x: Math.round(point.x), y: Math.round(point.y) });
        const hit = await cdp(tabId, 'DOM.resolveNode', { backendNodeId, objectGroup: 'browser-bridge' });
        const unblocked = value(await cdp(tabId, 'Runtime.callFunctionOn', {
          objectId: node.objectId, functionDeclaration: 'function(hit) { return this === hit || this.contains(hit); }',
          arguments: [{ objectId: hit.object.objectId }], returnByValue: true,
        }));
        if (!unblocked) throw new Error('Another element covers this ref. Inspect a new snapshot or screenshot.');
      } else point = position(await viewport(tabId), args.x, args.y);
      await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      let visualWarning = await visuals.click(tabId, point.x, point.y);
      await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
      await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
      visualWarning ||= await visuals.click(tabId, point.x, point.y);
      return { clicked: point, coordinate_space: 'viewport_css_pixels', observe_again: true,
        ...(visualWarning ? { visual_warning: visualWarning } : {}) };
    }
    if (command === 'fill') {
      if (!node || typeof args.text !== 'string') throw new Error('fill requires a fresh ref and text');
      value(await cdp(tabId, 'Runtime.callFunctionOn', { objectId: node.objectId, returnByValue: true,
        functionDeclaration: `function() {
          const tag = this.tagName?.toLowerCase();
          if (this.disabled || this.readOnly) throw new Error('Field is disabled or read-only');
          if (!['input', 'textarea'].includes(tag) && !this.isContentEditable) throw new Error('Ref is not an editable field');
          if (tag === 'input' && !['text','search','email','password','tel','url',''].includes(this.type)) throw new Error('Input type cannot be filled with text');
          this.focus();
          const active = this.getRootNode().activeElement;
          if (active !== this && !this.contains(active)) throw new Error('Field did not receive focus');
          if (this.isContentEditable) { const range = this.ownerDocument.createRange(); range.selectNodeContents(this); const selection = this.ownerDocument.getSelection(); selection.removeAllRanges(); selection.addRange(range); }
          else this.select();
          return true;
        }` }));
      await cdp(tabId, 'Input.insertText', { text: args.text });
      return { filled: true, observe_again: true };
    }
    if (command === 'press_key') { await pressKey(tabId, args.key); return { sent: args.key, observe_again: true }; }
    if (command === 'scroll') {
      const view = await viewport(tabId);
      const point = position(view, args.x ?? view.width / 2, args.y ?? view.height / 2);
      if (!Number.isFinite(args.delta_y) || !Number.isFinite(args.delta_x ?? 0)) throw new Error('Scroll deltas must be finite');
      // Native wheel acknowledgments can wait indefinitely for a hidden page's
      // compositor. Scroll the pointed container without changing browser focus.
      const result = value(await cdp(tabId, 'Runtime.evaluate', { returnByValue: true,
        expression: `(${scrollAtPoint.toString()})(${point.x},${point.y},${args.delta_x ?? 0},${args.delta_y})` }));
      return { ...result, observe_again: true };
    }
    throw new Error(`Unknown operation: ${command}`);
  }

  async function fullPageClip(tabId) {
    const { cssContentSize } = await cdp(tabId, 'Page.getLayoutMetrics');
    if (cssContentSize.width * cssContentSize.height > 40000000) throw new Error('Full-page capture exceeds 40 million pixels; use viewport capture');
    return { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 };
  }

  async function execute(owner, command, args) {
    if (command === 'list_tabs') {
      const tabs = await api.tabs.query({});
      return { tabs: tabs.map(tab => ({ tab_id: tab.id, window_id: tab.windowId, title: tab.title || '', url: tab.url || '',
        active: tab.active, group_id: tab.groupId, controllable: /^https?:\/\//.test(tab.url || '') })) };
    }
    if (command === 'release_owner') return await releaseMatching(claim => claim.owner === owner);
    const tabId = args.tab_id;
    if (!Number.isInteger(tabId)) throw new Error('Invalid tab ID');
    return await queued(tabId, async () => {
      if (command === 'claim_tab') {
        const tab = await api.tabs.get(tabId);
        if (tab.url !== args.expected_url || tab.title !== args.expected_title) throw new Error('Tab title/URL changed. List tabs again.');
        httpUrl(tab.url);
        const existing = claims.get(tabId);
        if (existing) {
          if (existing.owner === owner && existing.handle === args.tab_handle) return { claimed: true };
          throw new Error('Tab is already controlled by another session');
        }
        await api.debugger.attach({ tabId }, '1.3');
        try {
          await cdp(tabId, 'Page.enable');
          await cdp(tabId, 'Page.setInterceptFileChooserDialog', { enabled: true });
          await cdp(tabId, 'DOM.enable');
          await cdp(tabId, 'Accessibility.enable');
          claims.set(tabId, { owner, handle: args.tab_handle });
          let visualWarning;
          try { await visuals.install(tabId); }
          catch (error) { visualWarning = error.message; }
          return { claimed: true, activation_requested: false,
            ...(visualWarning ? { visual_warning: visualWarning } : {}) };
        } catch (error) {
          await api.debugger.detach({ tabId });
          throw error;
        }
      }
      const claim = claims.get(tabId);
      if (!claim || claim.owner !== owner || claim.handle !== args.tab_handle) throw new Error('Tab is not claimed by this connection');
      if (command === 'release_tab') return await action(tabId, command, args);
      httpUrl((await api.tabs.get(tabId)).url);
      const result = await action(tabId, command, args);
      const tab = await api.tabs.get(tabId);
      const chooser = fileChoosers.get(tabId);
      return { ...result, ...(chooser ? { file_chooser: { pending: true, mode: chooser.mode, frame_id: chooser.frame_id,
        note: 'Use browser_upload_file without ref; files: [] cancels the selection.' } } : {}),
        tab_id: tabId, title: result.title ?? tab.title, url: result.url ?? tab.url, active: tab.active };
    });
  }

  return { execute, releaseAll: () => releaseMatching(() => true), claimedCount: () => claims.size,
    async refreshVisuals() {
      await Promise.all([...claims.keys()].filter(tabId => !dialogs.has(tabId)).map(tabId => visuals.renew(tabId)));
    } };
}

function scrollAtPoint(x, y, dx, dy) {
  let doc = document;
  let element = doc.elementFromPoint(x, y);
  const enteredShadowHosts = new Set();
  while (element) {
    if (element.tagName === 'IFRAME') {
      const frame = element;
      const rect = frame.getBoundingClientRect();
      try { doc = frame.contentDocument; } catch { doc = null; }
      if (!doc) throw new Error('Cross-origin iframe scrolling is unavailable; scroll the outer page or use the website controls.');
      x -= rect.left + frame.clientLeft; y -= rect.top + frame.clientTop;
      element = doc.elementFromPoint(x, y);
      continue;
    }
    if (element.shadowRoot && !enteredShadowHosts.has(element)) {
      enteredShadowHosts.add(element);
      const inner = element.shadowRoot.elementFromPoint(x, y);
      if (inner && inner !== element) { element = inner; continue; }
    }
    const style = doc.defaultView.getComputedStyle(element);
    const canX = /auto|scroll|overlay/.test(style.overflowX) && element.scrollWidth > element.clientWidth &&
      ((dx > 0 && element.scrollLeft < element.scrollWidth - element.clientWidth) || (dx < 0 && element.scrollLeft > 0));
    const canY = /auto|scroll|overlay/.test(style.overflowY) && element.scrollHeight > element.clientHeight &&
      ((dy > 0 && element.scrollTop < element.scrollHeight - element.clientHeight) || (dy < 0 && element.scrollTop > 0));
    if (canX || canY) break;
    const parent = element.parentElement || element.getRootNode().host;
    if (!parent) { element = doc.scrollingElement; break; }
    element = parent;
  }
  if (!element) element = doc.scrollingElement;
  const before = { x: element.scrollLeft, y: element.scrollTop };
  element.scrollBy({ left: dx, top: dy, behavior: 'instant' });
  const after = { x: element.scrollLeft, y: element.scrollTop };
  return { scrolled: before.x !== after.x || before.y !== after.y, before, after,
    method: 'dom_scroll', scope: element === doc.scrollingElement ? 'document' : 'element' };
}
