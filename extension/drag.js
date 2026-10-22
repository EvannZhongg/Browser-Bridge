import { deadline, delivery } from './actionability.js';
import { targetOptions } from './locator.js';
import { offsetOption, timingOption, pause, trajectoryOption, dragPath } from './motion.js';

export function dragOptions(args) {
  if (!args.source || !args.destination) throw new Error('drag requires source and destination');
  for (const target of [args.source, args.destination]) {
    targetOptions(target, { coordinates: true });
    offsetOption(target);
    if (target.coordinate_space === 'document' && (target.x < 0 || target.y < 0)) throw new Error('Document coordinates must be finite and nonnegative');
  }
  if (!['pointer', 'html5'].includes(args.mode ?? 'pointer')) throw new Error('drag mode must be pointer or html5');
  if (!Number.isInteger(args.steps ?? 20) || (args.steps ?? 20) < 2 || (args.steps ?? 20) > 100) throw new Error('steps must be 2..100');
  timingOption(args.settle_ms ?? 0, 'settle_ms');
  trajectoryOption(args.trajectory);
}

export function createDrag(cdp, value, mouse, viewport) {
  const pending = new Map();
  function event(tabId, method, params, sessionId) {
    const operation = pending.get(tabId);
    if (!operation) return;
    if (['DOM.documentUpdated', 'Page.frameNavigated', 'Page.frameDetached', 'Page.navigatedWithinDocument'].includes(method)) {
      const frameId = params.frame?.id || params.frameId;
      if ([...operation.frames].some(key => { const [session, frame] = JSON.parse(key); return session === (sessionId ?? null) && (!frameId || frame === frameId); })) {
        operation.error = new Error('Drag document/frame changed; outcome is unknown. Observe before continuing.');
        operation.reject(operation.error);
      }
    }
    if (method === 'Page.javascriptDialogOpening') { operation.error = new Error('Drag opened a JavaScript dialog; outcome is unknown. Observe and handle the dialog.'); operation.reject(operation.error); }
    if (method === 'Input.dragIntercepted' && !sessionId) operation.intercept(params.data);
    if (method !== 'Runtime.bindingCalled' || params.name !== operation.name || !operation.contexts.has(JSON.stringify([sessionId, params.executionContextId]))) return;
    try {
      const { type, rejected } = JSON.parse(params.payload);
      if (rejected) { operation.error = new Error('Drag target changed during dispatch; outcome is unknown. Observe before continuing.'); operation.reject(operation.error); }
      operation.seen.add(type);
      const required = operation.html5 ? ['mousedown', 'dragstart', 'drop', 'dragend'] : ['pointerdown', 'pointermove', 'pointerup'];
      if (required.every(type => operation.seen.has(type))) operation.resolve();
    } catch (error) { operation.reject(error); }
  }
  function cancel(tabId) { const operation = pending.get(tabId); if (operation) { operation.error = new Error('Tab detached during drag; outcome is unknown.'); operation.reject(operation.error); } }
  async function drag(tabId, args, resolve, assertCurrent = () => {}) {
    dragOptions(args);
    const budget = args.budget || deadline(args.timeout_ms ?? 5000), html5 = args.mode === 'html5', steps = args.steps ?? 20;
    await mouse.assertReady(tabId, budget);
    if (args.source.coordinate_space === 'document' && args.destination.coordinate_space === 'document') {
      const view = await budget.run(() => viewport(tabId)), a = args.source, b = args.destination;
      // Keep both endpoints in one viewport when possible. Centering them
      // independently can erase the requested delta before interpolation.
      if (Math.abs(a.x - b.x) < view.width && Math.abs(a.y - b.y) < view.height) {
        const left = Math.min(a.x, b.x) < view.scroll_x || Math.max(a.x, b.x) >= view.scroll_x + view.width
          ? Math.max(0, (a.x + b.x - view.width) / 2) : view.scroll_x;
        const top = Math.min(a.y, b.y) < view.scroll_y || Math.max(a.y, b.y) >= view.scroll_y + view.height
          ? Math.max(0, (a.y + b.y - view.height) / 2) : view.scroll_y;
        if (left !== view.scroll_x || top !== view.scroll_y) value(await budget.run(() => cdp(tabId, 'Runtime.evaluate', {
          expression: `scrollTo({left:${left},top:${top},behavior:'instant'})`, returnByValue: true,
        })));
      }
    }
    const source = await mouse.prepare(tabId, await resolve(args.source, budget), { ...args.source, budget });
    const name = `__attachDrag_${crypto.randomUUID().replaceAll('-', '')}`, contexts = new Set(), guards = [], frames = new Set();
    let intercept; const intercepted = new Promise(resolve => { intercept = resolve; });
    const receipt = new Promise((resolve, reject) => pending.set(tabId, { name, contexts, frames, html5, seen: new Set(), resolve, reject, intercept }));
    receipt.catch(() => {});
    let pressed = false, releaseQueued = false, interceptEnabled = false, point = source.point;
    const check = () => { assertCurrent(); const error = pending.get(tabId)?.error; if (error) throw error; };
    const send = (method, params) => budget.run(() => {
      check();
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') pressed = true;
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') releaseQueued = true;
      return delivery(cdp(tabId, method, params));
    });
    const move = p => send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p, button: pressed ? 'left' : 'none', buttons: pressed ? 1 : 0 });
    async function guard(prepared, stage) {
      for (const item of [prepared, ...prepared.boundaries]) {
        const { target, frameId, backendNodeId } = item;
        frames.add(JSON.stringify([target.sessionId ?? null, frameId]));
        check();
        const call = (method, params) => budget.run(() => cdp(target, method, params));
        const { executionContextId } = await call('Page.createIsolatedWorld', { frameId, worldName: 'browser-attach-input' });
        contexts.add(JSON.stringify([target.sessionId, executionContextId]));
        await call('Runtime.addBinding', { name, executionContextId });
        const isolated = await call('DOM.resolveNode', { backendNodeId, executionContextId, objectGroup: 'browser-attach' });
        const installed = await call('Runtime.callFunctionOn', { objectId: isolated.object.objectId, functionDeclaration: installDragReceipt.toString(),
          arguments: [{ value: name }, { value: item === prepared ? stage : `${stage}_boundary` }, { value: html5 }, { value: budget.remaining() + 500 }], objectGroup: 'browser-attach' });
        value(installed);
        if (!installed.result?.objectId) throw new Error('Could not install drag receipt; observe before continuing');
        guards.push({ target, objectId: installed.result.objectId });
      }
    }
    try {
      await guard(source, 'source');
      if (html5) { interceptEnabled = true; await send('Input.setInterceptDrags', { enabled: true }); }
      await pause(budget, args.settle_ms);
      await mouse.assertReady(tabId, budget);
      budget.dispatch();
      await move(point);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
      // Cross Chromium's drag threshold before scrolling to an offscreen destination.
      const initial = { x: point.x + (point.x > 20 ? -12 : 12), y: point.y };
      await move(initial); point = initial;
      const data = html5 ? await budget.run(() => delivery(intercepted)) : null;
      // Preparation scrolls the destination into view while the button remains held,
      // including nested containers, then rechecks frame boundaries and occlusion.
      const destination = await mouse.prepare(tabId, await resolve(args.destination, budget), { ...args.destination, budget });
      await guard(destination, 'destination');
      const from = point;
      const path = dragPath(from, destination.point, steps, args.trajectory);
      if (args.trajectory) {
        const view = await budget.run(() => viewport(tabId));
        if (path.some(({ point }) => point.x < 0 || point.y < 0 || point.x >= view.width || point.y >= view.height)) {
          throw new Error('Drag trajectory leaves the viewport. Outcome is unknown; observe before continuing.');
        }
      }
      if (html5) await send('Input.dispatchDragEvent', { type: 'dragEnter', ...point, data });
      for (const sample of path) {
        point = sample.point;
        if (html5) await send('Input.dispatchDragEvent', { type: 'dragOver', ...point, data });
        else await move(point);
        await budget.run(() => new Promise(resolve => setTimeout(resolve, sample.dt)));
      }
      if (html5) await send('Input.dispatchDragEvent', { type: 'drop', ...point, data });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 });
      pressed = false;
      await budget.run(() => delivery(receipt));
      return { dragged: true, method: html5 ? 'native_html5' : 'native_pointer', events_trusted: true, delivery_verified: true,
        steps, from: source.point, to: point, application_result: 'not_checked', observe_again: true };
    } finally {
      pending.delete(tabId);
      // Cancel/release only this gesture; cleanup is never a replay of the action.
      const cleanup = [];
      if (pressed && !releaseQueued) {
        if (html5) cleanup.push(cdp(tabId, 'Input.cancelDragging'));
        cleanup.push(cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 }));
      }
      if (interceptEnabled) cleanup.push(cdp(tabId, 'Input.setInterceptDrags', { enabled: false }));
      for (const { target, objectId } of guards) {
        cleanup.push(cdp(target, 'Runtime.callFunctionOn', { objectId, functionDeclaration: 'function() { this.stop(); }' }));
        cleanup.push(cdp(target, 'Runtime.removeBinding', { name }));
      }
      await delivery(Promise.allSettled(cleanup), 250).catch(() => {});
    }
  }
  return { drag, event, cancel };
}

function installDragReceipt(name, stage, html5, expiryMs) {
  const target = this, win = target.ownerDocument.defaultView, report = win[name];
  // Cancelling pointerdown suppresses compatibility mouse down/up, but does
  // not prevent a pointer-based control from receiving the drag.
  const down = html5 ? 'mousedown' : 'pointerdown';
  const types = stage === 'source' ? (html5 ? ['mousedown', 'dragstart', 'dragend'] : ['pointerdown', 'pointermove', 'pointerup'])
    : stage === 'source_boundary' ? [down] : (html5 ? ['drop'] : ['pointerup']);
  const listeners = [];
  function listener(event, expected) {
    if (!event.isTrusted) return;
    const hit = event.composedPath().includes(expected);
    if ((event.type === down || event.type === 'drop') && (!hit || !target.isConnected)) {
      event.preventDefault(); event.stopImmediatePropagation(); report(JSON.stringify({ rejected: true })); return;
    }
    if (stage.endsWith('_boundary') || expected !== target) return;
    if (['dragstart', 'dragend'].includes(event.type) && !hit) return;
    if (event.type === 'pointermove' && event.buttons !== 1) return;
    if (html5 && !['mousedown', 'dragstart', 'drop', 'dragend'].includes(event.type)) return;
    report(JSON.stringify({ type: event.type }));
  }
  let expected = target;
  while (true) {
    const root = expected.getRootNode(), receiver = root.host ? root : win;
    const local = expected, callback = event => listener(event, local);
    listeners.push({ receiver, callback, types });
    for (const type of types) receiver.addEventListener(type, callback, { capture: true, passive: false });
    if (!root.host) break;
    expected = root.host;
  }
  if (stage === 'source' && html5) {
    const callback = event => listener(event, target), types = ['dragend'];
    listeners.push({ receiver: target, callback, types });
    target.addEventListener('dragend', callback, true);
  }
  // Pointer capture and movement can leave the source's closed shadow root.
  if (stage === 'source' && target.getRootNode().host && !html5) {
    const callback = event => listener(event, target), types = ['pointermove', 'pointerup'];
    listeners.push({ receiver: win, callback, types });
    for (const type of types) win.addEventListener(type, callback, { capture: true, passive: false });
  }
  let timer;
  function stop() {
    clearTimeout(timer);
    for (const { receiver, callback, types } of listeners) for (const type of types) receiver.removeEventListener(type, callback, true);
    delete win[name];
  }
  timer = win.setTimeout(stop, expiryMs);
  return { stop };
}
