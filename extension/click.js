// Native mouse dispatch stays in protocol order without serial compositor acknowledgments.
export function createClick(cdp, value, viewport, position) {
  const pending = new Map();
  function event(tabId, method, params) {
    const operation = pending.get(tabId);
    if (operation && method === 'Page.javascriptDialogOpening') {
      operation.reject(new Error('The action opened a JavaScript dialog. It may already have executed; use browser_snapshot and browser_handle_dialog before continuing.'));
      return;
    }
    if (method !== 'Runtime.bindingCalled' || !operation || params.name !== operation.name || params.executionContextId !== operation.contextId) return;
    try {
      const receipt = JSON.parse(params.payload);
      if (receipt.matched === true) operation.resolve();
      else operation.reject(new Error('Click target changed or became covered during mouse dispatch. Incorrect target input was blocked; observe again before retrying.'));
    } catch (error) { operation.reject(error); }
  }
  function cancel(tabId) { pending.get(tabId)?.reject(new Error('Tab detached during click; outcome is unknown. Observe before retrying.')); }
  async function click(tabId, node, args) {
    if ((args.ref != null) === (args.x != null || args.y != null)) throw new Error('Provide either ref or x/y');
    let point, view;
    if (node) {
      await cdp(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: node.backendNodeId });
      // Extension timers also run for hidden documents; page requestAnimationFrame does not.
      let previous;
      for (let attempt = 0; attempt < 10; attempt++) {
        const bounds = value(await cdp(tabId, 'Runtime.callFunctionOn', { objectId: node.objectId,
          functionDeclaration: checkClickable.toString(), returnByValue: true }));
        if (previous && JSON.stringify(bounds) === JSON.stringify(previous)) break;
        if (attempt === 9) throw new Error('Element is moving; no stable click point. Observe again.');
        previous = bounds;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const { quads } = await cdp(tabId, 'DOM.getContentQuads', { backendNodeId: node.backendNodeId });
      view = await viewport(tabId);
      for (const quad of quads || []) {
        point = clippedPoint(quad, view);
        if (point) break;
      }
      if (!point) throw new Error('Element has no visible click point. Inspect a screenshot.');
    } else { view = await viewport(tabId); point = position(view, args.x, args.y); }
    // DOM hit testing uses document CSS coordinates; Input uses viewport CSS coordinates.
    const { backendNodeId, frameId } = await cdp(tabId, 'DOM.getNodeForLocation', {
      x: Math.floor(point.x + view.scroll_x), y: Math.floor(point.y + view.scroll_y), includeUserAgentShadowDOM: true,
    });
    const hit = await cdp(tabId, 'DOM.resolveNode', { backendNodeId, objectGroup: 'browser-bridge' });
    if (node) {
      const unblocked = value(await cdp(tabId, 'Runtime.callFunctionOn', {
        objectId: node.objectId, functionDeclaration: 'function(hit) { for (let e = hit; e; e = e.parentNode || e.host) if (e === this) return true; return false; }',
        arguments: [{ objectId: hit.object.objectId }], returnByValue: true,
      }));
      if (!unblocked) throw new Error('Another element covers this ref. Inspect a new snapshot or screenshot.');
    }
    const name = `__bridgeClick_${crypto.randomUUID().replaceAll('-', '')}`;
    let timer, guard;
    const receipt = new Promise((resolve, reject) => pending.set(tabId, { name, resolve, reject }));
    // Mark handled before any setup can fail.
    receipt.catch(() => {});
    try {
      const frame = node?.frameId || frameId;
      const { executionContextId } = await cdp(tabId, 'Page.createIsolatedWorld', { frameId: frame, worldName: 'browser-bridge-input' });
      if (!executionContextId) throw new Error('Could not create an isolated click verification context; no input was dispatched.');
      pending.get(tabId).contextId = executionContextId;
      await cdp(tabId, 'Runtime.addBinding', { name, executionContextId });
      const isolated = await cdp(tabId, 'DOM.resolveNode', { backendNodeId: node?.backendNodeId || backendNodeId,
        executionContextId, objectGroup: 'browser-bridge' });
      const installed = await cdp(tabId, 'Runtime.callFunctionOn', {
        objectId: isolated.object.objectId, functionDeclaration: installGuard.toString(),
        arguments: [{ value: name }], objectGroup: 'browser-bridge',
      });
      if (installed.exceptionDetails) value(installed);
      guard = installed.result?.objectId;
      if (!guard) throw new Error('Could not install click target verification; no input was dispatched.');
      const deadline = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Click did not finish with verified delivery within 5 seconds. Outcome is unknown; observe before retrying.')), 5000); });
      const sent = Promise.all([
        cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'none', buttons: 0, ...point }),
        cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...point }),
        cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, ...point }),
      ]);
      // Both protocol delivery and a trusted DOM event must be confirmed. Deadline frees the queue.
      const outcomes = await Promise.race([Promise.allSettled([sent, receipt]), deadline]);
      for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
      return { clicked: point, target_verified: true, application_result: 'not_checked', coordinate_space: 'viewport_css_pixels', observe_again: true };
    } finally {
      clearTimeout(timer); pending.delete(tabId);
      // A page handler may have opened a modal. Renderer cleanup can finish after
      // it is dismissed, but must not keep the tab queue locked until then.
      const cleanup = [cdp(tabId, 'Runtime.removeBinding', { name })];
      if (guard) cleanup.push(cdp(tabId, 'Runtime.callFunctionOn', { objectId: guard,
        functionDeclaration: 'function() { this.stop(); }' }));
      let cleanupTimer;
      try { await Promise.race([Promise.allSettled(cleanup),
        new Promise(resolve => { cleanupTimer = setTimeout(resolve, 250); })]); }
      finally { clearTimeout(cleanupTimer); }
    }
  }
  return { click, event, cancel };
}

function checkClickable() {
  const element = this.nodeType === 3 ? this.parentElement : this;
  if (!element?.isConnected) throw new Error('Element is detached');
  if (element.matches(':disabled') || element.closest('[inert]')) throw new Error('Element is disabled or inert');
  const rect = element.getBoundingClientRect(), style = element.ownerDocument.defaultView.getComputedStyle(element);
  if (style.visibility !== 'visible' || !rect.width || !rect.height) throw new Error('Element is not visible');
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function installGuard(name) {
  const target = this.nodeType === 3 ? this.parentElement : this;
  const win = target.ownerDocument.defaultView, report = win[name];
  let rejected = false;
  const types = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
  const listeners = [];
  function listener(event, expected) {
    if (!event.isTrusted) return;
    const element = target.nodeType === 3 ? target.parentElement : target;
    const matched = !rejected && target.isConnected && !element.matches(':disabled') && !element.closest('[inert]') &&
      event.composedPath().some(node => node === expected);
    if (!matched) {
      rejected = true; event.preventDefault(); event.stopImmediatePropagation();
      report(JSON.stringify({ matched: false }));
    } else if (event.type === 'click' && expected === target) report(JSON.stringify({ matched: true }));
    if (event.type === 'click' && (!matched || expected === target)) stop();
  }
  let expiry;
  function stop() {
    clearTimeout(expiry);
    for (const [root, callback] of listeners) for (const type of types) root.removeEventListener(type, callback, true);
    delete win[name];
  }
  // Window listeners see a closed shadow host, not its internal target. Check
  // each boundary in its own root so closed components remain controllable.
  let expected = target;
  while (true) {
    const root = expected.getRootNode(), receiver = root.host ? root : win;
    const localTarget = expected, callback = event => listener(event, localTarget);
    listeners.push([receiver, callback]);
    for (const type of types) receiver.addEventListener(type, callback, { capture: true, passive: false });
    if (!root.host) break;
    expected = root.host;
  }
  expiry = win.setTimeout(stop, 10000);
  return { stop };
}

export function clippedPoint(quad, view) {
  let polygon = Array.from({ length: 4 }, (_, i) => ({ x: quad[i * 2], y: quad[i * 2 + 1] }));
  for (const [axis, bound, lower] of [['x', 0, true], ['x', view.width - 0.01, false], ['y', 0, true], ['y', view.height - 0.01, false]]) {
    const input = polygon; polygon = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[i], b = input[(i + 1) % input.length];
      const insideA = lower ? a[axis] >= bound : a[axis] <= bound;
      const insideB = lower ? b[axis] >= bound : b[axis] <= bound;
      if (insideA) polygon.push(a);
      if (insideA !== insideB) {
        const t = (bound - a[axis]) / (b[axis] - a[axis]);
        polygon.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
      }
    }
  }
  const twiceArea = polygon.reduce((sum, a, i) => {
    const b = polygon[(i + 1) % polygon.length]; return sum + a.x * b.y - b.x * a.y;
  }, 0);
  if (Math.abs(twiceArea) < 2) return null;
  const point = { x: 0, y: 0 };
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length], cross = a.x * b.y - b.x * a.y;
    point.x += (a.x + b.x) * cross; point.y += (a.y + b.y) * cross;
  }
  return { x: point.x / (3 * twiceArea), y: point.y / (3 * twiceArea) };
}
