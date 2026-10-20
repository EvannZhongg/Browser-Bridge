import { CONNECTION } from './config.generated.js';
import { createController } from './controller.js';

let socket;
let connecting = false;
let keepAlive;
let reconnect;
let status = 'disconnected';
let identity;
const controller = createController(chrome, event => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
});

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
          status = 'connected';
          await chrome.action.setBadgeText({ text: 'ON' });
          await chrome.action.setBadgeBackgroundColor({ color: '#13755b' });
          return;
        }
        if (!request.id) return;
        const result = await controller.execute(request.owner, request.command, request.arguments || {});
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: request.id, result }));
      } catch (error) {
        if (request?.id && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ id: request.id, error: error.message || String(error) }));
        }
      }
    };
    ws.onclose = async () => {
      clearInterval(keepAlive);
      status = 'disconnected';
      connecting = false;
      await controller.releaseAll();
      await chrome.action.setBadgeText({ text: 'OFF' });
      clearTimeout(reconnect);
      reconnect = setTimeout(connect, 2000);
    };
    ws.onerror = () => ws.close();
  } catch (error) {
    connecting = false;
    status = error.message;
  }
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
    controller.releaseAll().then(() => respond({ ok: true }));
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
setInterval(() => controller.refreshVisuals(), 3000);
connect();
