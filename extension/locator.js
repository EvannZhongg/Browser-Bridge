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
  if (!hasSelector && (args.frame_id != null || args.selector_type != null)) throw new Error('frame_id and selector_type require selector');
  if (args.nth != null && (!hasSelector || !Number.isSafeInteger(args.nth) || args.nth < 0)) throw new Error('nth requires selector and must be a nonnegative safe integer (zero-based)');
  if (args.coordinate_space != null && (!hasPoint || !['viewport', 'document'].includes(args.coordinate_space))) throw new Error('coordinate_space must be viewport or document and applies to coordinate clicks only');
}

export function queryElement(selector, type = 'css', nth, waitForMatch = false) {
  if (nth != null && (!Number.isSafeInteger(nth) || nth < 0)) throw new Error('nth must be a nonnegative safe integer (zero-based)');
  let element, count;
  if (type === 'xpath') {
    const result = document.evaluate(selector, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    count = result.snapshotLength; element = result.snapshotItem(nth ?? 0);
  } else {
    const elements = document.querySelectorAll(selector);
    count = elements.length; element = elements[nth ?? 0];
  }
  if (waitForMatch && (count === 0 || (nth != null && nth >= count))) return null;
  if (nth == null && count !== 1) throw new Error(`Selector must match exactly one element; matched ${count}. Scope the selector or provide an explicit zero-based nth.`);
  if (nth != null && nth >= count) throw new Error(`Selector nth=${nth} is out of range; matched ${count}`);
  if (element.nodeType !== 1) throw new Error('Selector must resolve to an element');
  return element;
}

export async function resolveSelector(cdp, value, sessions, tabId, args, budget) {
  const frames = await budget.run(() => sessions.frames(tabId));
  const frameId = args.frame_id ?? frames[0].id;
  if (!frames.some(frame => frame.id === frameId)) throw new Error('frame_id is unknown; take a new snapshot');
  const target = sessions.target(tabId, frameId);
  const send = (method, params) => budget.run(() => cdp(target, method, params));
  const { executionContextId } = await send('Page.createIsolatedWorld', { frameId, worldName: 'browser-attach-locator' });
  let result;
  while (true) {
    result = await send('Runtime.evaluate', { contextId: executionContextId, objectGroup: 'browser-attach',
      expression: `(${queryElement.toString()})(${JSON.stringify(args.selector)},${JSON.stringify(args.selector_type ?? 'css')},${args.nth ?? 'undefined'},true)` });
    value(result);
    if (result.result?.subtype !== 'null') break;
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
