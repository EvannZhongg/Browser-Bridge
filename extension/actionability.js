// One deadline covers preparation, waiting, dispatch and verification. Only
// preparation is retried; once input is sent its outcome must be observed.
export function deadline(timeout_ms = 5000, phase = 'input') {
  if (!Number.isInteger(timeout_ms) || timeout_ms < 100 || timeout_ms > 30000) throw new Error('timeout_ms must be 100..30000');
  const end = Date.now() + timeout_ms;
  let dispatched = false;
  function error() {
    if (phase === 'observation') return new Error(`Navigation observation timed out within ${timeout_ms} ms; navigation already succeeded. Take a new snapshot.`);
    return new Error(dispatched
      ? `Input did not finish with verified delivery within ${timeout_ms} ms. Outcome is unknown. Browser UI may be capturing input. Observe before retrying; never automatically replay or fall back.`
      : `Target did not become actionable within ${timeout_ms} ms; no input was dispatched.`);
  }
  async function run(operation) {
    const remaining = end - Date.now();
    if (remaining <= 0) throw error();
    let timer;
    try { return await Promise.race([Promise.resolve().then(operation), new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(error()), remaining);
    })]); } finally { clearTimeout(timer); }
  }
  return { run, dispatch() { if (Date.now() >= end) throw error(); dispatched = true; }, remaining: () => Math.max(0, end - Date.now()) };
}

export async function waitForTarget(cdp, value, target, node, budget, { editable = false } = {}) {
  let previous;
  while (true) {
    const bounds = value(await budget.run(() => cdp(target, 'Runtime.callFunctionOn', {
      objectId: node.objectId, functionDeclaration: inspectTarget.toString(), arguments: [{ value: editable }], returnByValue: true,
    })));
    if (bounds?.detached) throw new Error('Element is detached; take a new snapshot. No input was dispatched.');
    if (bounds?.unsupported) throw new Error('Ref is not a supported editable field; no input was dispatched.');
    if (bounds?.ready && previous && JSON.stringify(bounds) === JSON.stringify(previous)) return;
    previous = bounds?.ready ? bounds : null;
    await budget.run(() => new Promise(resolve => setTimeout(resolve, 20)));
  }
}

export function inspectTarget(editable) {
  let element = this?.nodeType === 3 ? this.parentElement : this;
  if (!element?.isConnected) return { detached: true };
  const tag = element.tagName?.toLowerCase();
  if (editable && ((!['input', 'textarea'].includes(tag) && !element.isContentEditable) ||
      (tag === 'input' && !['text', 'search', 'email', 'password', 'tel', 'url', ''].includes(element.type)))) return { unsupported: true };
  // Walk across shadow boundaries as inert can be inherited from a host.
  for (let parent = element; parent; parent = parent.parentElement || parent.getRootNode().host) {
    if (parent.matches(':disabled') || parent.hasAttribute('inert')) return { ready: false };
  }
  const rect = element.getBoundingClientRect(), style = element.ownerDocument.defaultView.getComputedStyle(element);
  return { ready: style.visibility === 'visible' && rect.width > 0 && rect.height > 0 && (!editable || !element.readOnly),
    x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}
