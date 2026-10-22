// One deadline covers preparation, waiting, dispatch and verification. Only
// preparation is retried; once input is sent its outcome must be observed.
export function deadline(timeout_ms = 5000, phase = 'input', parentEnd = Infinity) {
  if (!Number.isInteger(timeout_ms) || timeout_ms < 100 || timeout_ms > 30000) throw new Error('timeout_ms must be 100..30000');
  const end = Math.min(Date.now() + timeout_ms, parentEnd);
  let dispatched = false, waiting;
  function error() {
    if (phase === 'evaluation') return Object.assign(new Error(dispatched ? 'JavaScript evaluation timed out. Page effects may already have occurred. Observe before continuing. Do not replay automatically.' : 'Evaluation preparation timed out; no expression was executed.'), { input_dispatched: dispatched });
    if (phase === 'fetch') return new Error(`Fetch did not finish within ${timeout_ms} ms; the temporary tab will be closed. Do not automatically replay the request.`);
    if (phase === 'wait') return Object.assign(new Error(`Condition was not satisfied within ${timeout_ms} ms`), { input_dispatched: false });
    if (phase === 'observation') return new Error(`Navigation observation timed out within ${timeout_ms} ms; navigation already succeeded. Take a new snapshot.`);
    const result = new Error(dispatched
      ? `Input did not finish with verified delivery within ${timeout_ms} ms. Outcome is unknown. Browser UI may be capturing input; press Esc to dismiss a native menu. Observe before retrying; never automatically replay or fall back.`
      : `Target did not become actionable within ${timeout_ms} ms${waiting ? `; waiting for ${waiting}` : ''}; no input was dispatched.`);
    result.input_dispatched = dispatched;
    return result;
  }
  async function run(operation) {
    const remaining = end - Date.now();
    if (remaining <= 0) throw error();
    let timer;
    try { return await Promise.race([Promise.resolve().then(operation), new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(error()), remaining);
    })]); } finally { clearTimeout(timer); }
  }
  return { run, has_dispatched: () => dispatched, child(ms, childPhase = phase) { return deadline(ms, childPhase, end); }, describe(detail) { waiting = detail; }, dispatch() { if (Date.now() >= end) throw error(); dispatched = true; }, remaining: () => Math.max(0, end - Date.now()) };
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
    budget.describe?.(`visible, enabled, stable target; current=${JSON.stringify(bounds)}`);
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
    if (parent.matches(':disabled') || parent.hasAttribute('inert')) return { ready: false, reason: parent.matches(':disabled') ? 'disabled' : 'inert' };
  }
  const rect = element.getBoundingClientRect(), style = element.ownerDocument.defaultView.getComputedStyle(element);
  if (style.visibility !== 'visible' || rect.width <= 0 || rect.height <= 0) return { ready: false, reason: 'hidden or zero size' };
  if (editable && element.readOnly) return { ready: false, reason: 'read-only' };
  return { ready: true,
    x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

// A lost native receipt must free the queue promptly even with a long preparation budget.
export async function delivery(operation, ms = 1250) {
  let timer;
  try { return await Promise.race([operation, new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Native input has no verified receipt. Outcome is unknown. Browser UI may be capturing input; press Esc to dismiss a native menu, then observe. Never automatically replay or fall back.')), ms);
  })]); } finally { clearTimeout(timer); }
}
