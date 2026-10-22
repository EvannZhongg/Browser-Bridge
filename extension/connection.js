import { compareVersions } from './version.js';

export function createConnection(chrome, CONNECTION, controller) {
  let socket;
  let connecting = false;
  let keepAlive;
  let reconnect;
  let status = 'disconnected';
  let identity;
  let maintenance = false;
  let cleanup = Promise.resolve();

  async function release() {
    const result = await controller.releaseAll();
    if (result.errors?.length) throw new Error(`Extension cleanup failed: ${result.errors.join('; ')}`);
  }

  async function prepareReload(version) {
    const current = chrome.runtime.getManifest().version;
    if (compareVersions(version, current) <= 0) throw new Error('Reload target must be newer than the running extension');
    const response = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
    if (!response.ok || (await response.json()).version !== version) throw new Error('Extension files do not match the Hub; reload was not attempted');
    const previous = (await chrome.storage.local.get('reloadAttempt')).reloadAttempt;
    if (previous?.from === current && previous.target === version) throw new Error('Extension reload did not apply the update; reload manually after checking the extension directory');
    maintenance = true;
    await release();
    await chrome.storage.local.set({ reloadAttempt: { from: current, target: version } });
  }

  async function getIdentity() {
    const local = await chrome.storage.local.get(['instanceId', 'profileName']);
    const session = await chrome.storage.session.get('runId');
    const instanceId = local.instanceId || crypto.randomUUID();
    const runId = session.runId || crypto.randomUUID();
    if (!local.instanceId) await chrome.storage.local.set({ instanceId });
    if (!session.runId) await chrome.storage.session.set({ runId });
    const family = /Edg\//.test(navigator.userAgent) ? 'edge' : 'chrome';
    return { instance_id: instanceId, run_id: runId, family,
      profile_name: local.profileName || (family === 'edge' ? 'Edge' : 'Chrome'),
      user_agent: navigator.userAgent, extension_id: chrome.runtime.id, extension_version: chrome.runtime.getManifest().version };
  }

  async function connect() {
    if (connecting || socket?.readyState === WebSocket.OPEN) return;
    connecting = true;
    try {
      await cleanup;
      await release();
      identity = await getIdentity();
      const ws = new WebSocket(CONNECTION.url);
      socket = ws;
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'hello', token: CONNECTION.token, browser: identity }));
        keepAlive = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
        }, 20000);
      };
      ws.onmessage = async event => {
        let request;
        try {
          request = JSON.parse(event.data);
          if (request.type === 'connected') {
            maintenance = false;
            status = 'connected';
            await chrome.storage.local.remove('reloadAttempt');
            await chrome.action.setBadgeText({ text: 'ON' });
            await chrome.action.setBadgeBackgroundColor({ color: '#13755b' });
            return;
          }
          if (!request.id) return;
          let result;
          if (request.command === 'prepare_upgrade') {
            maintenance = true;
            await release();
            result = { prepared: true };
          } else if (request.command === 'resume') {
            maintenance = false;
            result = { resumed: true };
          } else if (request.command === 'reload_extension') {
            await prepareReload(request.arguments?.version);
            if (ws.readyState !== WebSocket.OPEN) return;
            ws.send(JSON.stringify({ id: request.id, result: { reloading: true } }));
            chrome.runtime.reload();
            return;
          } else {
            if (maintenance) throw new Error('Extension is preparing an upgrade');
            result = await controller.execute(request.owner, request.command, request.arguments || {});
          }
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: request.id, result }));
        } catch (error) {
          if (request?.id && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ id: request.id, error: error.message || String(error) }));
          }
        }
      };
      ws.onclose = () => {
        clearInterval(keepAlive);
        status = 'disconnected';
        connecting = false;
        cleanup = release().catch(error => { status = error.message; });
        chrome.action.setBadgeText({ text: 'OFF' }).catch(() => {});
        scheduleReconnect();
      };
      ws.onerror = () => ws.close();
    } catch (error) {
      connecting = false;
      status = error.message;
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    clearTimeout(reconnect);
    reconnect = setTimeout(connect, 2000);
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message.type === 'status') {
      getIdentity().then(browser => respond({ status, browser, claims: controller.claimedCount() }));
      return true;
    }
    if (message.type === 'reconnect') {
      if (socket?.readyState === WebSocket.OPEN) socket.close();
      else connect();
      respond({ ok: true });
    }
    if (message.type === 'release_all') {
      release().then(() => respond({ ok: true }), error => respond({ ok: false, error: error.message }));
      return true;
    }
  });
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'connect') connect(); });
  chrome.runtime.onStartup.addListener(connect);
  chrome.runtime.onInstalled.addListener(async () => {
    await chrome.alarms.create('connect', { periodInMinutes: 0.5 });
    connect();
  });
  chrome.alarms.create('connect', { periodInMinutes: 0.5 });
  connect();
  return { send(event) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event)); } };
}
