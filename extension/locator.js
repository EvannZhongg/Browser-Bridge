// Selectors are reusable queries, never identities inferred from old AX text.
export function targetOptions(args, { coordinates = false } = {}) {
  const hasRef = args.ref != null, hasSelector = args.selector != null;
  const hasPoint = args.x != null || args.y != null;
  if (Number(hasRef) + Number(hasSelector) + Number(hasPoint) !== 1 ||
      (hasPoint && (!coordinates || !Number.isFinite(args.x) || !Number.isFinite(args.y)))) {
    throw new Error(coordinates ? 'Provide exactly one of ref, selector, or both finite x and y' : 'Provide exactly one of ref or selector');
  }
  if (hasRef && (typeof args.ref !== 'string' || !args.ref)) throw new Error('ref must be nonempty');
  if (hasSelector && (typeof args.selector !== 'string' || !args.selector.trim() || args.selector.length > 10000)) throw new Error('selector must contain 1..10000 characters');
  if (args.selector_type != null && !['css', 'xpath'].includes(args.selector_type)) throw new Error('selector_type must be css or xpath');
  frameOptions(args);
  if (!hasSelector && (args.frame_id != null || args.frame != null || args.selector_type != null)) throw new Error('frame_id and selector_type require selector');
  if (args.nth != null && (!hasSelector || !Number.isSafeInteger(args.nth) || args.nth < 0)) throw new Error('nth requires selector and must be a nonnegative safe integer (zero-based)');
  if (args.coordinate_space != null && (!hasPoint || !['viewport', 'document'].includes(args.coordinate_space))) throw new Error('coordinate_space must be viewport or document and applies to coordinate clicks only');
}

export function queryElement(selector, type = 'css', nth, waitForMatch = false) {
  if (nth != null && (!Number.isSafeInteger(nth) || nth < 0)) throw new Error('nth must be a nonnegative safe integer (zero-based)');
  let element, count, at;
  if (type === 'xpath') {
    const result = document.evaluate(selector, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    count = result.snapshotLength; at = index => result.snapshotItem(index);
  } else {
    const elements = document.querySelectorAll(selector);
    count = elements.length; at = index => elements[index];
  }
  if (waitForMatch && (count === 0 || (nth != null && nth >= count))) return null;
  if (nth == null && count !== 1) {
    const candidates = Array.from({ length: Math.min(count, 10) }, (_, nth) => {
      const node = at(nth), text = (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (node.nodeType !== 1) return { nth, node_type: node.nodeType, text };
      const rect = node.getBoundingClientRect(), style = node.ownerDocument.defaultView.getComputedStyle(node);
      return { nth, tag: node.tagName.toLowerCase(), text,
        disabled: node.matches(':disabled') || !!node.closest('[inert], [aria-disabled="true"]'),
        visible: rect.width > 0 && rect.height > 0 && style.visibility === 'visible' };
    });
    throw new Error(`Selector must match exactly one element; matched ${count}. Scope the selector or provide an explicit zero-based nth. Candidates: ${JSON.stringify(candidates)}${count > candidates.length ? ` (${count - candidates.length} more omitted)` : ''}`);
  }
  if (nth != null && nth >= count) throw new Error(`Selector nth=${nth} is out of range; matched ${count}`);
  element = at(nth ?? 0);
  if (element.nodeType !== 1) throw new Error('Selector must resolve to an element');
  return element;
}

export async function resolveSelector(cdp, value, sessions, tabId, args, budget) {
  const frameId = await resolveFrame(cdp, value, sessions, tabId, args, budget);
  const target = sessions.target(tabId, frameId);
  const send = (method, params) => budget.run(() => cdp(target, method, params));
  const { executionContextId } = await send('Page.createIsolatedWorld', { frameId, worldName: 'browser-attach-locator' });
  let result;
  while (true) {
    result = await send('Runtime.evaluate', { contextId: executionContextId, objectGroup: 'browser-attach',
      expression: `(${queryElement.toString()})(${JSON.stringify(args.selector)},${JSON.stringify(args.selector_type ?? 'css')},${args.nth ?? 'undefined'},true)` });
    value(result);
    if (result.result?.subtype !== 'null') break;
    budget.describe?.(`selector ${JSON.stringify(args.selector)}${args.nth == null ? '' : ` nth=${args.nth}`} to appear; current=no matching element`);
    await budget.run(() => new Promise(resolve => setTimeout(resolve, 20)));
  }
  if (!result.result?.objectId) throw new Error('Selector did not resolve to an element');
  const { node } = await send('DOM.describeNode', { objectId: result.result.objectId });
  // Hit-test refs resolve in the default world too. CDP forbids passing object
  // arguments between worlds, even when both wrappers refer to the same node.
  const resolved = await send('DOM.resolveNode', { backendNodeId: node.backendNodeId, objectGroup: 'browser-attach' });
  if (!resolved.object?.objectId) throw new Error('Selector target detached before resolution; no input was dispatched');
  return { target, frameId, objectId: resolved.object.objectId, backendNodeId: node.backendNodeId };
}

export function frameOptions(args) {
  if (args.frame_id != null && args.frame != null) throw new Error('Provide frame_id or frame, never both');
  const frame = args.frame;
  if (frame == null) return;
  if (typeof frame !== 'object' || Array.isArray(frame) || !Object.keys(frame).length || Object.keys(frame).some(key => !['url', 'title', 'path'].includes(key))) throw new Error('frame requires url, title or a CSS iframe path');
  for (const key of ['url', 'title']) if (frame[key] != null && (typeof frame[key] !== 'string' || !frame[key])) throw new Error(`frame.${key} must be nonempty`);
  if (frame.path != null && (!Array.isArray(frame.path) || frame.path.length < 1 || frame.path.length > 16 || frame.path.some(s => typeof s !== 'string' || !s.trim() || s.length > 10000))) throw new Error('frame.path must contain 1..16 CSS iframe selectors');
}

async function resolveFrameOnce(cdp, value, sessions, tabId, args, budget) {
  frameOptions(args);
  const frames = await budget.run(() => sessions.frames(tabId));
  if (args.frame_id != null) {
    if (!frames.some(f => f.id === args.frame_id)) throw new Error('frame_id is unknown; take a new snapshot');
    return args.frame_id;
  }
  if (!args.frame) return frames[0].id;
  const scope = args.frame;
  let frameId = frames[0].id;
  for (const selector of scope.path || []) {
    const target = sessions.target(tabId, frameId);
    const send = (method, params) => budget.run(() => cdp(target, method, params));
    const { executionContextId } = await send('Page.createIsolatedWorld', { frameId, worldName: 'browser-attach-locator' });
    const result = await send('Runtime.evaluate', { contextId: executionContextId, expression: `(${queryElement.toString()})(${JSON.stringify(selector)},"css")`, objectGroup: 'browser-attach-frame' });
    value(result);
    try {
      const { node } = await send('DOM.describeNode', { objectId: result.result.objectId });
      if (!['IFRAME', 'FRAME'].includes(node.nodeName)) throw new Error('frame.path must resolve to iframe/frame elements');
      frameId = node.frameId || node.contentDocument?.frameId;
      if (!frameId) throw new Error('Frame document is not available yet');
    } finally { await send('Runtime.releaseObjectGroup', { objectGroup: 'browser-attach-frame' }); }
  }
  const candidates = scope.path ? frames.filter(f => f.id === frameId) : frames.filter(f => f.id !== frames[0].id);
  const matches = [];
  for (const frame of candidates) {
    if (scope.url != null && frame.url !== scope.url) continue;
    if (scope.title != null) {
      const target = sessions.target(tabId, frame.id);
      const { executionContextId } = await budget.run(() => cdp(target, 'Page.createIsolatedWorld', { frameId: frame.id, worldName: 'browser-attach-locator' }));
      const title = value(await budget.run(() => cdp(target, 'Runtime.evaluate', { contextId: executionContextId, expression: 'document.title', returnByValue: true })));
      if (title !== scope.title) continue;
    }
    matches.push(frame.id);
  }
  if (matches.length !== 1) throw new Error(`Frame locator must match exactly once; matched ${matches.length}`);
  return matches[0];
}

export async function resolveFrame(cdp, value, sessions, tabId, args, budget) {
  while (true) {
    try { return await resolveFrameOnce(cdp, value, sessions, tabId, args, budget); }
    catch (error) {
      if (!/Frame locator.*matched 0|Frame document.*not available|Selector.*matched 0|context.*destroyed|cannot find context/i.test(error.message)) throw error;
      budget.describe?.(`frame ${JSON.stringify(args.frame)}; current=${error.message}`);
      await budget.run(() => new Promise(resolve => setTimeout(resolve, 20)));
    }
  }
}
