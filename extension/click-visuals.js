// Only transient click feedback is drawn in the page. Control status stays in
// the native tab strip; no badge or document-start script is installed.
function installClickVisual() {
  if (globalThis.__localBrowserAttachClickVisual) return;
  let host, ring, pointer, expiry;
  let hidden = false;
  const style = (node, css) => { node.style.cssText = css; return node; };
  function remove() { clearTimeout(expiry); host?.remove(); host = null; }
  function click(x, y) {
    remove();
    host = style(document.createElement('div'), 'position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;contain:layout style!important;');
    host.setAttribute('data-local-browser-attach-click', '');
    host.setAttribute('aria-hidden', 'true'); host.inert = true;
    const shadow = host.attachShadow({ mode: 'closed' });
    ring = style(document.createElement('div'), 'position:absolute;width:26px;height:26px;border:2px solid #e95c3b;border-radius:50%;background:#e95c3b22;box-sizing:border-box;transform:translate(-50%,-50%);pointer-events:none;');
    pointer = style(document.createElement('div'), 'position:absolute;width:28px;height:32px;filter:drop-shadow(0 1px 2px #0008);pointer-events:none;');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '28'); svg.setAttribute('height', '28');
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', 'M4 2v17l4-4 4 7 4-2-4-7h6L4 2Z');
    path.setAttribute('fill', '#e95c3b'); path.setAttribute('stroke', '#fff'); path.setAttribute('stroke-width', '1.3');
    svg.append(path); pointer.append(svg); shadow.append(ring, pointer);
    document.documentElement?.append(host);
    for (const node of [ring, pointer]) { node.style.left = `${x}px`; node.style.top = `${y}px`; }
    host.style.visibility = hidden ? 'hidden' : 'visible';
    expiry = setTimeout(remove, 1200);
  }
  function visible(show) { hidden = !show; if (host) host.style.visibility = show ? 'visible' : 'hidden'; }
  globalThis.__localBrowserAttachClickVisual = { click, visible, remove };
}

export function createClickVisuals(api) {
  const contexts = new Map();
  const pending = new Map();
  const versions = new Map();
  const send = (tabId, method, params = {}) => api.debugger.sendCommand({ tabId }, method, params);
  async function evaluate(tabId, expression) {
    const version = versions.get(tabId);
    let contextId = contexts.get(tabId);
    if (!contextId) {
      const { frameTree } = await send(tabId, 'Page.getFrameTree');
      ({ executionContextId: contextId } = await send(tabId, 'Page.createIsolatedWorld', {
        frameId: frameTree.frame.id, worldName: 'local-browser-attach-click-visual',
      }));
      if (version !== versions.get(tabId)) throw new Error('Click visual was cancelled');
      contexts.set(tabId, contextId);
    }
    const result = await send(tabId, 'Runtime.evaluate', { expression, contextId, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Click visual update failed');
  }
  async function visible(tabId, show) {
    await pending.get(tabId)?.catch(() => {});
    if (!contexts.has(tabId)) return null;
    try { await evaluate(tabId, `globalThis.__localBrowserAttachClickVisual?.visible(${!!show})`); return null; }
    catch (error) { return error.message; }
  }
  function forget(tabId) { versions.set(tabId, (versions.get(tabId) || 0) + 1); contexts.delete(tabId); pending.delete(tabId); }
  async function remove(tabId, skipDOM = false) {
    if (skipDOM) { forget(tabId); return; }
    if (!contexts.has(tabId) && !pending.has(tabId)) return;
    let timer;
    try {
      await Promise.race([
        (async () => {
          await pending.get(tabId)?.catch(() => {});
          if (contexts.has(tabId)) await evaluate(tabId, 'globalThis.__localBrowserAttachClickVisual?.remove()');
        })().catch(() => {}),
        new Promise(resolve => { timer = setTimeout(resolve, 250); }),
      ]);
    } finally { clearTimeout(timer); forget(tabId); }
  }
  function click(tabId, x, y) {
    const operation = evaluate(tabId, `(${installClickVisual.toString()})();globalThis.__localBrowserAttachClickVisual.click(${JSON.stringify(x)},${JSON.stringify(y)})`);
    pending.set(tabId, operation);
    const done = () => { if (pending.get(tabId) === operation) pending.delete(tabId); };
    operation.then(done, done);
    return operation;
  }
  return { visible, remove, forget, navigated: forget,
    click,
  };
}
