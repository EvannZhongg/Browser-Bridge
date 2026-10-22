import { deadline, waitForTarget, delivery } from './actionability.js';
import { offsetOption, timingOption, pause } from './motion.js';

// Native mouse dispatch stays in protocol order without serial compositor acknowledgments.
export function createClick(cdp, value, viewport, position, sessions, getTab, getWindow) {
  const pending = new Map();
  async function assertReady(tabId, budget) {
    const timeout = Math.min(500, budget.remaining());
    const guidance = 'Call browser_tab_control action=activate with this tab_handle, then browser_snapshot and retry the requested pointer action. If focus is still unavailable, restore/focus the browser window. No input was dispatched.';
    let timer;
    try {
      if (timeout <= 0) throw new Error('input deadline expired before the readiness check');
      return await Promise.race([
        (async () => {
          const tab = await getTab(tabId);
          if (!tab.active || tab.discarded || tab.frozen) throw new Error(`tab not active or renderer suspended (active=${tab.active}, discarded=${!!tab.discarded}, frozen=${!!tab.frozen})`);
          const window = await getWindow(tab.windowId);
          if (window.state === 'minimized') throw new Error('browser window is minimized');
          const state = value(await cdp(tabId, 'Runtime.evaluate', {
            expression: '({visibility_state: document.visibilityState, has_focus: document.hasFocus()})', returnByValue: true,
          }));
          if (typeof state?.visibility_state !== 'string' || typeof state.has_focus !== 'boolean') throw new Error('page readiness unavailable');
          // Occlusion can make an active renderer report hidden without
          // preventing CDP input. Focus/visibility are diagnostics; the isolated
          // event guard below verifies delivery to the intended element.
          return { ...state, window_focused: window.focused };
        })(),
        new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`readiness check did not respond within ${timeout} ms`)), timeout); }),
      ]);
    } catch (error) {
      throw new Error(`TAB_NOT_READY: Native pointer input not dispatched: ${error.message}. ${guidance}`);
    } finally { clearTimeout(timer); }
  }
  function event(tabId, method, params, sessionId) {
    const operation = pending.get(tabId);
    if (operation && method === 'Page.javascriptDialogOpening') {
      operation.reject(new Error('The action opened a JavaScript dialog. It may already have executed; use browser_snapshot and browser_handle_dialog before continuing.'));
      return;
    }
    if (method !== 'Runtime.bindingCalled' || !operation || params.name !== operation.name || !operation.contexts.has(JSON.stringify([sessionId, params.executionContextId]))) return;
    try {
      const receipt = JSON.parse(params.payload);
      if (receipt.matched === true) operation.resolve();
      else operation.reject(new Error('Click target changed or became covered during mouse dispatch. Incorrect target input was blocked; observe again before retrying.'));
    } catch (error) { operation.reject(error); }
  }
  function cancel(tabId) { pending.get(tabId)?.reject(new Error('Tab detached during click; outcome is unknown. Observe before retrying.')); }
  async function prepare(tabId, node, args) {
    offsetOption(args);
    if (!!node === (args.x != null || args.y != null)) throw new Error('Provide either ref/selector or x/y');
    if (args.coordinate_space != null && !['viewport', 'document'].includes(args.coordinate_space)) throw new Error('coordinate_space must be viewport or document');
    if (node && args.coordinate_space != null) throw new Error('coordinate_space applies to coordinate clicks only');
    const budget = args.budget || deadline(args.timeout_ms);
    const obstruction = detail => Object.assign(new Error(`${detail}. ${budget.has_dispatched()
      ? 'Input has already been dispatched. Outcome is unknown; observe before continuing. Do not replay automatically.'
      : 'No input was dispatched.'}`), { input_dispatched: budget.has_dispatched() });
    let target = node?.target || { tabId };
    const send = (method, params) => budget.run(() => cdp(target, method, params));
    let point, view;
    if (node) {
      await waitForTarget(cdp, value, target, node, budget);
      if (args.scroll !== false) await send('DOM.scrollIntoViewIfNeeded', { backendNodeId: node.backendNodeId });
      await waitForTarget(cdp, value, target, node, budget);
      const { quads } = await send('DOM.getContentQuads', { backendNodeId: node.backendNodeId });
      view = await budget.run(() => viewport(target));
      for (const quad of quads || []) {
        point = clippedPoint(quad, view, args.offset);
        if (point) break;
      }
      if (!point) throw new Error('Element has no visible click point. Inspect a screenshot.');
    } else {
      view = await budget.run(() => viewport(target));
      if (args.coordinate_space === 'document') {
        if (!Number.isFinite(args.x) || !Number.isFinite(args.y) || args.x < 0 || args.y < 0) throw new Error('Document coordinates must be finite and nonnegative');
        const x = args.x - view.scroll_x, y = args.y - view.scroll_y;
        if (args.scroll !== false && (x < 0 || y < 0 || x >= view.width || y >= view.height)) {
          const left = x < 0 || x >= view.width ? Math.max(0, args.x - view.width / 2) : view.scroll_x;
          const top = y < 0 || y >= view.height ? Math.max(0, args.y - view.height / 2) : view.scroll_y;
          value(await send('Runtime.evaluate', { returnByValue: true,
            expression: `scrollTo({left:${left},top:${top},behavior:'instant'})` }));
          view = await budget.run(() => viewport(target));
        }
        point = position(view, args.x - view.scroll_x, args.y - view.scroll_y);
      } else point = position(view, args.x, args.y);
    }
    // DOM hit testing uses document CSS coordinates; Input uses viewport CSS coordinates.
    let hitNode = await send('DOM.getNodeForLocation', {
      x: Math.floor(point.x + view.scroll_x), y: Math.floor(point.y + view.scroll_y), includeUserAgentShadowDOM: true,
    });
    // Coordinate input starts in the root viewport; descend into a remote frame
    // before resolving backend ids or installing isolated-world verification.
    const visited = new Set();
    while (!node) {
      const description = await send('DOM.describeNode', { backendNodeId: hitNode.backendNodeId, depth: 0 });
      const childId = description.node.frameId, child = childId && sessions.target(tabId, childId);
      if (!child?.sessionId || child.sessionId === target.sessionId) break;
      if (visited.has(child.sessionId)) throw new Error('Frame hit-test cycle; no input was dispatched.');
      visited.add(child.sessionId);
      const { model } = await send('DOM.getBoxModel', { backendNodeId: hitNode.backendNodeId });
      const childView = await budget.run(() => viewport(child));
      point = framePoint(point, model.content, childView, true);
      target = child; view = childView;
      hitNode = await send('DOM.getNodeForLocation', { x: Math.floor(point.x + view.scroll_x), y: Math.floor(point.y + view.scroll_y), includeUserAgentShadowDOM: true });
    }
    let { backendNodeId } = hitNode;
    const { frameId } = hitNode;
    let hit = await send('DOM.resolveNode', { backendNodeId, objectGroup: 'browser-attach' });
    const pseudo = hit.object.className === 'CSSPseudoElement';
    if (pseudo) {
      // Pseudo-elements are event targets through their originating element,
      // but their Runtime wrappers are not Elements and have no matches().
      const normalized = await send('Runtime.callFunctionOn', { objectId: hit.object.objectId,
        functionDeclaration: 'function() { if (this.element?.nodeType !== 1) throw new Error("Pseudo-element has no originating element; no input was dispatched."); return this.element; }', objectGroup: 'browser-attach' });
      value(normalized);
      if (!normalized.result?.objectId) throw new Error('Pseudo-element could not be resolved; no input was dispatched.');
      hit = { object: normalized.result };
      const { node: origin } = await send('DOM.describeNode', { objectId: hit.object.objectId });
      backendNodeId = origin.backendNodeId;
    }
    const hitTarget = value(await send('Runtime.callFunctionOn', { objectId: hit.object.objectId,
      functionDeclaration: describeHit.toString(), returnByValue: true }));
    if (pseudo) hitTarget.pseudo_element = true;
    if (node) {
      const unblocked = value(await send('Runtime.callFunctionOn', {
        objectId: node.objectId, functionDeclaration: 'function(hit) { for (let e = hit; e; e = e.parentNode || e.host) if (e === this) return true; return false; }',
        arguments: [{ objectId: hit.object.objectId }], returnByValue: true,
      }));
      if (!unblocked) throw obstruction(`Another element covers this ref. hit_target=${JSON.stringify(hitTarget)}; point=${JSON.stringify(point)}; frame_id=${JSON.stringify(node.frameId)}`);
    }
    // Dispatch through the root widget so overlays in ancestor documents cannot
    // be bypassed by sending directly to an OOPIF widget. Guard every boundary.
    const boundaries = [];
    let rootPoint = point, current = target, currentView = view;
    while (current.sessionId) {
      const parent = sessions.parent(tabId, current.sessionId);
      const owner = await budget.run(() => cdp(parent.target, 'DOM.getFrameOwner', { frameId: parent.frameId }));
      const { model } = await budget.run(() => cdp(parent.target, 'DOM.getBoxModel', { backendNodeId: owner.backendNodeId }));
      rootPoint = framePoint(rootPoint, model.content, currentView);
      const parentView = await budget.run(() => viewport(parent.target));
      position(parentView, rootPoint.x, rootPoint.y);
      const parentHit = await budget.run(() => cdp(parent.target, 'DOM.getNodeForLocation', {
        x: Math.floor(rootPoint.x + parentView.scroll_x), y: Math.floor(rootPoint.y + parentView.scroll_y), includeUserAgentShadowDOM: true,
      }));
      if (parentHit.backendNodeId !== owner.backendNodeId) {
        let blocker;
        try {
          const diagnostic = budget.child(200);
          const resolved = await diagnostic.run(() => cdp(parent.target, 'DOM.resolveNode', { backendNodeId: parentHit.backendNodeId, objectGroup: 'browser-attach' }));
          blocker = value(await diagnostic.run(() => cdp(parent.target, 'Runtime.callFunctionOn', { objectId: resolved.object.objectId,
            functionDeclaration: describeHit.toString(), returnByValue: true })));
        } catch { /* Preserve the obstruction error even if its node disappears. */ }
        throw obstruction(`Another element covers this frame. hit_target=${JSON.stringify(blocker ?? { backend_node_id: parentHit.backendNodeId })}; point=${JSON.stringify(rootPoint)}; blocked_frame_id=${JSON.stringify(parent.frameId)}`);
      }
      const ownerFrameId = parent.ownerFrameId || (await budget.run(() => cdp(parent.target, 'Page.getFrameTree'))).frameTree.frame.id;
      boundaries.push({ target: parent.target, backendNodeId: owner.backendNodeId, frameId: ownerFrameId });
      current = parent.target; currentView = parentView;
    }
    return { target, point: rootPoint, hitTarget, frameId: node?.frameId || frameId, backendNodeId: node?.backendNodeId || backendNodeId, boundaries };
  }
  async function click(tabId, node, args) {
    const options = { ...clickOptions(args), hover: args.hover === true };
    const budget = args.budget || deadline(args.timeout_ms);
    const prepared = await prepare(tabId, node, { ...args, budget });
    const { target, point: rootPoint, hitTarget, frameId, backendNodeId, boundaries } = prepared;
    if (!options.hover && hitTarget.native_select) throw new Error("Native select popup is unsupported. No input was dispatched. Use browser_select_option by label/value/index; press Esc if a native popup is already open.");
    const name = `__attachClick_${crypto.randomUUID().replaceAll('-', '')}`;
    const guards = [], contexts = new Set();
    let failure;
    const receipt = new Promise((resolve, reject) => pending.set(tabId, { name, contexts, resolve, reject(error) { failure = error; reject(error); } }));
    receipt.catch(() => {});
    try {
      const targets = [{ target, frameId: node?.frameId || frameId, backendNodeId: node?.backendNodeId || backendNodeId, leaf: true }, ...boundaries];
      for (const item of targets) {
        const sendTo = (method, params) => budget.run(() => cdp(item.target, method, params));
        const frame = item.frameId;
        const { executionContextId } = await sendTo('Page.createIsolatedWorld', { frameId: frame, worldName: 'browser-attach-input' });
        if (!executionContextId) throw new Error('Could not create an isolated click verification context; no input was dispatched.');
        contexts.add(JSON.stringify([item.target.sessionId, executionContextId]));
        await sendTo('Runtime.addBinding', { name, executionContextId });
        const isolated = await sendTo('DOM.resolveNode', { backendNodeId: item.backendNodeId, executionContextId, objectGroup: 'browser-attach' });
        const installed = await sendTo('Runtime.callFunctionOn', {
          objectId: isolated.object.objectId, functionDeclaration: installGuard.toString(),
          arguments: [{ value: name }, { value: options }, { value: budget.remaining() + 500 }, { value: item.leaf === true }], objectGroup: 'browser-attach',
        });
        if (installed.exceptionDetails) value(installed);
        if (!installed.result?.objectId) throw new Error('Could not install click target verification; no input was dispatched.');
        guards.push({ target: item.target, objectId: installed.result.objectId });
      }
      // Recheck the root page after target preparation: a user may have changed
      // tabs/focus while we resolved a frame or installed the event guards.
      await pause(budget, args.settle_ms);
      if (failure) throw failure;
      const pageState = await assertReady(tabId, budget);
      if (failure) throw failure;
      budget.dispatch();
      const dispatch = params => budget.run(() => cdp(tabId, 'Input.dispatchMouseEvent', { ...params, ...rootPoint }));
      const commands = [dispatch({ type: 'mouseMoved', button: 'none', buttons: 0, modifiers: options.modifiers })];
      for (let count = 1; !options.hover && count <= options.click_count; count++) {
        commands.push(dispatch({ type: 'mousePressed', button: options.button, buttons: options.buttons, clickCount: count, modifiers: options.modifiers }));
        commands.push(dispatch({ type: 'mouseReleased', button: options.button, buttons: 0, clickCount: count, modifiers: options.modifiers }));
      }
      await budget.run(() => delivery(Promise.all([Promise.all(commands), receipt])));
      if (options.hover) return { hovered: rootPoint, hit_target: hitTarget, page_state: pageState, target_verified: true, events_trusted: true, application_result: 'not_checked', observe_again: true };
      return { clicked: rootPoint, hit_target: hitTarget, page_state: pageState, target_verified: true, application_result: 'not_checked', coordinate_space: 'viewport_css_pixels', frame_id: node?.frameId || frameId, button: options.button, click_count: options.click_count, observe_again: true };
    } finally {
      pending.delete(tabId);
      // A page handler may have opened a modal. Renderer cleanup can finish after
      // it is dismissed, but must not keep the tab queue locked until then.
      const cleanup = guards.flatMap(({ target, objectId }) => [cdp(target, 'Runtime.removeBinding', { name }),
        cdp(target, 'Runtime.callFunctionOn', { objectId, functionDeclaration: 'function() { this.stop(); }' })]);
      let cleanupTimer;
      try { await Promise.race([Promise.allSettled(cleanup),
        new Promise(resolve => { cleanupTimer = setTimeout(resolve, 250); })]); }
      finally { clearTimeout(cleanupTimer); }
    }
  }
  return { assertReady, prepare, click, event, cancel };
}

export function describeHit() {
  const element = this.nodeType === 3 ? this.parentElement : this;
  let clickable, disabled = false, nativeSelect = false;
  for (let parent = element; parent; parent = parent.assignedSlot || parent.parentElement || parent.getRootNode().host) {
    if (parent.tagName === 'SELECT' || parent.tagName === 'LABEL' && parent.control?.tagName === 'SELECT') nativeSelect = true;
    if (!clickable && parent.matches('button,a[href],input,select,textarea,summary,[role="button"],[role="link"],[onclick]')) clickable = parent;
    if (parent.matches(':disabled,[inert],[aria-disabled="true"]')) disabled = true;
  }
  return { tag: element.tagName?.toLowerCase(), text: (element.innerText || element.textContent || '').slice(0, 300),
    role: element.getAttribute('role'), disabled, clickable_hint: !!clickable,
    native_select: nativeSelect,
    clickable_target: clickable ? { tag: clickable.tagName.toLowerCase(), role: clickable.getAttribute('role'),
      text: (clickable.innerText || clickable.textContent || '').slice(0, 300) } : null };
}

function installGuard(name, options, expiryMs, verifyDelivery) {
  const target = this.nodeType === 3 ? this.parentElement : this;
  const win = target.ownerDocument.defaultView, report = win[name];
  let rejected = false, completed = 0;
  const types = options.hover ? ['mousemove'] : ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'auxclick', 'contextmenu', 'dblclick'];
  const listeners = [];
  function listener(event, expected) {
    if (!event.isTrusted) return;
    const element = target.nodeType === 3 ? target.parentElement : target;
    const modifiers = (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
    const matched = (options.hover || event.button === options.domButton) && modifiers === options.modifiers && !rejected && target.isConnected && !element.matches(':disabled') && !element.closest('[inert]') &&
      event.composedPath().some(node => node === expected);
    if (!matched) {
      rejected = true; event.preventDefault(); event.stopImmediatePropagation();
      report(JSON.stringify({ matched: false }));
    } else {
      const terminal = options.hover ? 'mousemove' : options.button === 'right' ? 'contextmenu' : options.button === 'middle' ? 'auxclick' : options.click_count === 2 ? 'dblclick' : 'click';
      if (verifyDelivery && event.type === terminal && expected === target) {
        completed++;
        if (options.button === 'left' || completed === options.click_count) report(JSON.stringify({ matched: true }));
      }
    }

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
  expiry = win.setTimeout(stop, expiryMs);
  return { stop };
}

export function clippedPoint(quad, view, offset) {
  if (offset) {
    const { x_ratio: x, y_ratio: y } = offset;
    const point = { x: (1 - y) * ((1 - x) * quad[0] + x * quad[2]) + y * ((1 - x) * quad[6] + x * quad[4]),
      y: (1 - y) * ((1 - x) * quad[1] + x * quad[3]) + y * ((1 - x) * quad[7] + x * quad[5]) };
    return point.x >= 0 && point.y >= 0 && point.x < view.width && point.y < view.height ? point : null;
  }
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

export function clickOptions(args) {
  offsetOption(args);
  if (args.settle_ms != null) {
    timingOption(args.settle_ms, 'settle_ms');
    if (args.mode === 'dom') throw new Error('settle_ms requires native pointer input');
  }
  const button = args.button ?? 'left', click_count = args.click_count ?? 1, modifiers = args.modifiers ?? [];
  const buttons = { left: [1, 0], middle: [4, 1], right: [2, 2] }, masks = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
  if (!Object.hasOwn(buttons, button)) throw new Error('button must be left, middle or right');
  if (![1, 2].includes(click_count)) throw new Error('click_count must be 1 or 2');
  if (!Array.isArray(modifiers) || modifiers.some(key => !Object.hasOwn(masks, key))) throw new Error('modifiers must contain Alt, Control, Meta or Shift');
  if (args.mode === 'dom' && (button !== 'left' || click_count !== 1 || modifiers.length)) throw new Error('DOM click supports only left single click without modifiers');
  return { button, click_count, modifiers: modifiers.reduce((mask, key) => mask | masks[key], 0), buttons: buttons[button][0], domButton: buttons[button][1] };
}

// Affine transforms cover translation, scale, rotation and skew. Reject
// perspective rather than silently clicking a wrongly transformed position.
export function framePoint(point, quad, view, inverse = false) {
  const [x, y, x1, y1, x2, y2, x3, y3] = quad;
  const ax = x1 - x, ay = y1 - y, bx = x3 - x, by = y3 - y;
  if (Math.abs(x2 - x1 - x3 + x) > 0.5 || Math.abs(y2 - y1 - y3 + y) > 0.5) throw new Error('Perspective iframe transforms are unsupported; no input was dispatched.');
  const determinant = ax * by - ay * bx;
  if (Math.abs(determinant) < 0.001) throw new Error('Frame has no visible content area; no input was dispatched.');
  if (inverse) {
    const dx = point.x - x, dy = point.y - y;
    return { x: (dx * by - dy * bx) / determinant * view.width, y: (dy * ax - dx * ay) / determinant * view.height };
  }
  return { x: x + point.x / view.width * ax + point.y / view.height * bx,
    y: y + point.x / view.width * ay + point.y / view.height * by };
}
