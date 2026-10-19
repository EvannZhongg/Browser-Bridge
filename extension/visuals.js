// Runs in a dedicated isolated world. Websites cannot call this control object.
function installIndicator() {
  if (window !== window.top || globalThis.__localBrowserBridgeVisual) return;
  let host;
  let pointer;
  let ring;
  let lease;
  let clickTimer;
  let hidden = false;
  const styles = (element, css) => { element.style.cssText = css; return element; };
  const svg = (path, color, size) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    node.setAttribute('viewBox', '0 0 24 24');
    node.setAttribute('width', String(size)); node.setAttribute('height', String(size));
    const shape = document.createElementNS(node.namespaceURI, 'path');
    shape.setAttribute('d', path); shape.setAttribute('fill', color);
    shape.setAttribute('stroke', '#fff'); shape.setAttribute('stroke-width', '1.3');
    node.append(shape); return node;
  };
  function mount() {
    if (host?.isConnected || !document.documentElement) return;
    host = styles(document.createElement('div'), 'position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;contain:layout style!important;');
    host.setAttribute('data-local-browser-bridge', '');
    host.setAttribute('aria-hidden', 'true');
    host.inert = true;
    const shadow = host.attachShadow({ mode: 'closed' });
    const badge = styles(document.createElement('div'), 'position:absolute;top:14px;right:16px;display:flex;align-items:center;gap:7px;padding:8px 11px;border-radius:999px;color:#fff;background:#12634f;box-shadow:0 2px 12px #0003;font:12px system-ui,sans-serif;pointer-events:none;');
    badge.append(svg('M8 4h8v3h3v12H5V7h3V4Zm1 6v3h2v-3H9Zm4 0v3h2v-3h-2ZM9 16h6v1H9v-1Z', '#fff', 18));
    badge.append(document.createTextNode('Agent 已接管'));
    ring = styles(document.createElement('div'), 'display:none;position:absolute;width:26px;height:26px;border:2px solid #e95c3b;border-radius:50%;background:#e95c3b22;box-sizing:border-box;transform:translate(-50%,-50%);pointer-events:none;');
    pointer = styles(document.createElement('div'), 'display:none;position:absolute;width:28px;height:32px;filter:drop-shadow(0 1px 2px #0008);pointer-events:none;');
    pointer.append(svg('M4 2v17l4-4 4 7 4-2-4-7h6L4 2Z', '#e95c3b', 28));
    shadow.append(badge, ring, pointer);
    document.documentElement.append(host);
    host.style.visibility = hidden ? 'hidden' : 'visible';
  }
  function renew() {
    mount(); clearTimeout(lease);
    // Detaching the debugger externally cannot run cleanup code. Let its badge expire.
    lease = setTimeout(remove, 9000);
    return { visible: !!host?.isConnected && !hidden };
  }
  function remove() {
    clearTimeout(lease); clearTimeout(clickTimer);
    host?.remove(); host = null;
  }
  function click(x, y) {
    renew();
    if (!host) return;
    ring.style.left = `${x}px`; ring.style.top = `${y}px`; ring.style.display = 'block';
    pointer.style.left = `${x}px`; pointer.style.top = `${y}px`; pointer.style.display = 'block';
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => { ring.style.display = 'none'; pointer.style.display = 'none'; }, 1200);
  }
  function visible(show) {
    hidden = !show;
    if (host) host.style.visibility = show ? 'visible' : 'hidden';
  }
  globalThis.__localBrowserBridgeVisual = { renew, click, visible, remove };
  if (document.documentElement) renew();
  else document.addEventListener('DOMContentLoaded', renew, { once: true });
}

export function createVisuals(api) {
  const records = new Map();
  const source = `(${installIndicator.toString()})()`;
  const send = (tabId, method, params = {}) => api.debugger.sendCommand({ tabId }, method, params);
  async function evaluate(tabId, expression) {
    const record = records.get(tabId);
    if (!record) return;
    if (!record.context) {
      const { frameTree } = await send(tabId, 'Page.getFrameTree');
      const result = await send(tabId, 'Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'local-browser-bridge-visual' });
      record.context = result.executionContextId;
    }
    const result = await send(tabId, 'Runtime.evaluate', { expression, contextId: record.context, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Indicator injection failed');
    return result.result?.value;
  }
  async function install(tabId) {
    const result = await send(tabId, 'Page.addScriptToEvaluateOnNewDocument', { source, worldName: 'local-browser-bridge-visual' });
    records.set(tabId, { script: result.identifier, context: null });
    await evaluate(tabId, `${source};globalThis.__localBrowserBridgeVisual?.renew()`);
    await api.action.setBadgeText({ tabId, text: 'RUN' });
    await api.action.setBadgeBackgroundColor({ tabId, color: '#12634f' });
    await api.action.setTitle({ tabId, title: 'Agent 正在接管此标签页' });
  }
  async function remove(tabId, skipDOM = false) {
    const record = records.get(tabId);
    if (!record) return;
    try {
      await send(tabId, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: record.script });
      if (!skipDOM) await evaluate(tabId, 'globalThis.__localBrowserBridgeVisual?.remove()');
    } finally {
      forget(tabId);
    }
  }
  function forget(tabId) {
    records.delete(tabId);
    api.action.setBadgeText({ tabId, text: '' }).catch(() => {});
    api.action.setTitle({ tabId, title: 'Local Browser Bridge' }).catch(() => {});
  }
  async function update(tabId, expression) {
    try { await evaluate(tabId, expression); return null; }
    catch (error) { return error.message; }
  }
  return {
    install, remove, forget,
    navigated(tabId) { const record = records.get(tabId); if (record) record.context = null; },
    renew: tabId => update(tabId, 'globalThis.__localBrowserBridgeVisual?.renew()'),
    click: (tabId, x, y) => update(tabId, `globalThis.__localBrowserBridgeVisual?.click(${JSON.stringify(x)},${JSON.stringify(y)})`),
    visible: (tabId, show) => update(tabId, `globalThis.__localBrowserBridgeVisual?.visible(${!!show})`),
  };
}
