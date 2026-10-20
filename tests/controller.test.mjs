import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createController } from '../extension/controller.js';

function event() { const callbacks = []; return { addListener(fn) { callbacks.push(fn); }, emit(...args) { for (const fn of callbacks) fn(...args); } }; }
function fixture() {
  const calls = [];
  const notices = [];
  const tabs = new Map([[9, { id: 9, windowId: 1, groupId: -1, title: 'Demo', url: 'http://localhost:8000/', active: true }]]);
  const groups = new Map();
  let groupSerial = 100;
  let stored = {};
  let blocked = false;
  let modalOnClick = false;
  let customNodes;
  let binding;
  const api = { storage: { session: { get: async () => structuredClone(stored), set: async value => { stored = structuredClone(value); } } },
    tabGroups: { get: async id => { if (!groups.has(id)) throw new Error('Unknown group'); return groups.get(id); },
      update: async (id, args) => { Object.assign(groups.get(id), args); calls.push({ method: 'tabGroups.update', id, args }); } },
    action: {
      setBadgeText: async args => { calls.push({ method: 'badge', args }); },
      setBadgeBackgroundColor: async () => {}, setTitle: async () => {},
    }, tabs: { get: async id => tabs.get(id), query: async () => [...tabs.values()], onRemoved: event(), onUpdated: event(),
      create: async args => { calls.push({ method: 'tabs.create', args }); const tab = { id: 10, windowId: 1, title: '', ...args }; tabs.set(tab.id, tab); return tab; },
      update: async (id, args) => { calls.push({ method: 'tabs.update', id, args }); Object.assign(tabs.get(id), args); return tabs.get(id); },
      remove: async id => { calls.push({ method: 'tabs.remove', id }); tabs.delete(id); api.tabs.onRemoved.emit(id); },
      group: async ({ tabIds, groupId = ++groupSerial }) => { for (const id of tabIds) tabs.get(id).groupId = groupId;
        if (!groups.has(groupId)) groups.set(groupId, { id: groupId, windowId: 1 });
        calls.push({ method: 'tabs.group', tabIds, groupId }); return groupId; },
      ungroup: async id => { if (tabs.has(id)) tabs.get(id).groupId = -1; calls.push({ method: 'tabs.ungroup', id }); },
    }, windows: { update: async (id, args) => { calls.push({ method: 'windows.update', id, args }); } },
    debugger: { onDetach: event(), onEvent: event(),
      attach: async (target, version) => { calls.push({ method: 'attach', target, version }); },
      detach: async target => { calls.push({ method: 'detach', target }); api.debugger.onDetach.emit(target); },
      sendCommand: async (target, method, args) => {
        calls.push({ method, args, target });
        if (method === 'Runtime.addBinding') binding = args.name;
        if (method === 'Input.dispatchKeyEvent' && args.type === 'rawKeyDown') {
          api.debugger.onEvent.emit(target, 'Runtime.bindingCalled', { name: binding, executionContextId: 42, payload: '{"delivered":true}' });
        }
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 42 };
        if (method === 'Page.navigate') {
          tabs.get(9).url = args.url; tabs.get(9).title = 'Destination';
          api.debugger.onEvent.emit(target, 'Page.frameNavigated', { frame: { id: 'main' } });
          api.debugger.onEvent.emit(target, 'Page.lifecycleEvent', { frameId: 'main', loaderId: 'new', name: 'DOMContentLoaded' });
          return { frameId: 'main', loaderId: 'new' };
        }
        if (method === 'Input.dispatchMouseEvent' && args.type === 'mouseReleased' && !modalOnClick) {
          api.debugger.onEvent.emit(target, 'Runtime.bindingCalled', { name: binding, executionContextId: 42, payload: JSON.stringify({ matched: true }) });
        }
        if (modalOnClick && method === 'Input.dispatchMouseEvent' && args.type === 'mouseReleased') {
          api.debugger.onEvent.emit(target, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Modal' });
          return await new Promise(() => {});
        }
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', url: tabs.get(9).url } } };
        if (method === 'Accessibility.getFullAXTree' && args.frameId === 'remote') throw new Error('Frame is in another process');
        if (method === 'Accessibility.getFullAXTree') return { nodes: customNodes || [
          { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Demo' }, childIds: ['2', '3'] },
          { nodeId: '2', backendDOMNodeId: 12, role: { value: 'button' }, name: { value: 'Submit' } },
          { nodeId: '3', backendDOMNodeId: 13, role: { value: 'textbox' }, name: { value: 'Name' } },
        ] };
        if (method === 'DOM.describeNode') return { node: { frameId: 'remote', attributes: ['src', 'https://frame.test/'] } };
        if (method === 'DOM.resolveNode') return { object: { objectId: `object-${args.backendNodeId}` } };
        if (method === 'DOM.getContentQuads') return { quads: [[10, 10, 100, 10, 100, 50, 10, 50]] };
        if (method === 'DOM.getNodeForLocation') return { backendNodeId: 12, frameId: 'main' };
        if (method === 'Runtime.evaluate' && args.expression.includes('function installKeyReceipt')) return { result: { objectId: 'key-guard' } };
        if (method === 'Runtime.evaluate' && args.expression.includes('title: document.title')) return { result: { value: { title: tabs.get(9).title, url: tabs.get(9).url } } };
        if (method === 'Runtime.evaluate') return { result: { value: { width: 1024, height: 768, scroll_x: 0, scroll_y: 0, device_pixel_ratio: 1 } } };
        if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function installGuard')) return { result: { objectId: 'guard' } };
        if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function checkClickable')) return { result: { value: { x: 10, y: 10, width: 90, height: 40 } } };
        if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes("input.type !== 'file'")) return { result: { objectId: 'file-input' } };
        if (method === 'Runtime.callFunctionOn') return { result: { value: !blocked } };
        if (method === 'Page.getLayoutMetrics') return { cssContentSize: { width: 1024, height: 1800 } };
        if (method === 'Page.captureScreenshot') return { data: 'image-data' };
        return {};
      } } };
  const controller = createController(api, data => notices.push(data));
  const exec = (command, args = {}, owner = 'one') => controller.execute(owner, command, { tab_id: 9, tab_handle: 'handle-one', ...args });
  const claim = () => exec('claim_tab', { expected_title: 'Demo', expected_url: 'http://localhost:8000/' });
  const ref = snapshot => snapshot.snapshot.match(/\[([^\]]+)\] button/)[1];
  return { controller, exec, claim, ref, calls, api, notices, tabs, block: () => { blocked = true; }, modal: () => { modalOnClick = true; }, nodes: value => { customNodes = value; } };
}

test('claim verifies title and URL before attaching; ownership is enforced', async () => {
  const f = fixture();
  await assert.rejects(f.exec('claim_tab', { expected_title: 'Wrong', expected_url: 'http://localhost:8000/' }), /changed/);
  assert.equal(f.calls.length, 0);
  await f.claim();
  await assert.rejects(f.exec('read_text', {}, 'two'), /not claimed/);
  assert.equal(f.controller.claimedCount(), 1);
});

test('fresh AX refs are consumed after input and old refs cannot click again', async () => {
  const f = fixture(); await f.claim();
  const ref = f.ref(await f.exec('snapshot'));
  await f.exec('click', { ref });
  assert.equal(f.calls.filter(call => call.method === 'Input.dispatchMouseEvent').length, 3);
  await assert.rejects(f.exec('click', { ref }), /stale/);
});

test('a new snapshot and navigation invalidate earlier element refs', async () => {
  const f = fixture(); await f.claim();
  const ref = f.ref(await f.exec('snapshot'));
  await f.exec('snapshot');
  await assert.rejects(f.exec('fill', { ref, text: 'test' }), /stale/);
  const current = f.ref(await f.exec('snapshot'));
  f.api.debugger.onEvent.emit({ tabId: 9 }, 'DOM.documentUpdated');
  await assert.rejects(f.exec('click', { ref: current }), /stale/);
});

test('covered elements are refused before input is dispatched', async () => {
  const f = fixture(); await f.claim(); f.block();
  const ref = f.ref(await f.exec('snapshot'));
  await assert.rejects(f.exec('click', { ref }), /covers/);
  assert.equal(f.calls.filter(call => call.method === 'Input.dispatchMouseEvent').length, 0);
});

test('coordinate actions are bounded by the viewport', async () => {
  const f = fixture(); await f.claim();
  await assert.rejects(f.exec('click', { x: -1, y: 0 }), /viewport/);
  await assert.rejects(f.exec('click', { x: 1024, y: 0 }), /viewport/);
  await f.exec('click', { x: 500, y: 300 });
  await f.exec('scroll', { delta_y: 300 });
});

test('scrolled-page hit testing uses document coordinates while native input keeps viewport coordinates', async () => {
  const f = fixture(); await f.claim();
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Runtime.evaluate' && args.expression.includes('scroll_x: scrollX')) result.result.value.scroll_y = 500;
    return result;
  };
  await f.exec('click', { ref: f.ref(await f.exec('snapshot')) });
  assert.equal(f.calls.find(call => call.method === 'DOM.getNodeForLocation').args.y, 530);
  assert.equal(f.calls.find(call => call.method === 'Input.dispatchMouseEvent').args.y, 30);
});

test('fill uses a resolved node and text input; no arbitrary script operation exists', async () => {
  const f = fixture(); await f.claim();
  const snapshot = await f.exec('snapshot');
  const ref = snapshot.snapshot.match(/\[([^\]]+)\] textbox/)[1];
  await f.exec('fill', { ref, text: '中文 hello' });
  assert.deepEqual(f.calls.find(call => call.method === 'Input.insertText').args, { text: '中文 hello' });
  await assert.rejects(f.exec('evaluate', { expression: 'fetch("https://evil.test")' }), /Unknown operation/);
});

test('DOM fill bypasses native input and focus, notifies the page and verifies the retained value', async () => {
  const f = fixture(); await f.claim();
  const events = [];
  class Input { set value(text) { this.stored = text; } get value() { return this.stored; } }
  const field = new Input();
  Object.assign(field, { tagName: 'INPUT', type: 'text', isConnected: true, closest: () => null,
    focus() { throw new Error('DOM fill must not focus'); }, dispatchEvent(event) { events.push(event); } });
  field.ownerDocument = { defaultView: { HTMLInputElement: Input, Event: class { constructor(type) { this.type = type; } },
    InputEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } } } };
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Runtime.callFunctionOn' && /function (prepareFill|verifyFill)/.test(args.functionDeclaration)) {
      return { result: { value: vm.runInNewContext(`(${args.functionDeclaration})`).call(field, ...args.arguments.map(arg => arg.value)) } };
    }
    return send(target, method, args);
  };
  const snap = await f.exec('snapshot'), ref = snap.snapshot.match(/\[([^\]]+)\] textbox/)[1];
  const result = await f.exec('fill', { ref, text: '中文 test', mode: 'dom' });
  assert.equal(field.value, '中文 test'); assert.equal(result.value_verified, true); assert.equal(result.events_trusted, false);
  assert.deepEqual(events.map(event => event.type), ['input', 'change']);
  assert.equal(f.calls.filter(call => call.method.startsWith('Input.')).length, 0);
  await assert.rejects(f.exec('fill', { ref, text: 'again', mode: 'dom' }), /stale/);
});

test('native fill detects swallowed or reformatted text and never falls back or replays', async () => {
  const f = fixture(); await f.claim();
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function verifyFill')) result.result.value = false;
    return result;
  };
  const snapshot = await f.exec('snapshot'), ref = snapshot.snapshot.match(/\[([^\]]+)\] textbox/)[1];
  await assert.rejects(f.exec('fill', { ref, text: 'lost' }), /did not retain.*Outcome is unknown/);
  assert.equal(f.calls.filter(call => call.method === 'Input.insertText').length, 1);
  assert.ok((await f.exec('snapshot')).snapshot);
});

test('DOM click invokes HTML activation once without native input, rejects coordinates and disabled targets', async () => {
  const f = fixture(); await f.claim();
  let clicks = 0, disabled = false;
  class Element { click() { clicks++; } }
  const element = new Element();
  Object.assign(element, { isConnected: true, matches: () => disabled, closest: () => null,
    getBoundingClientRect: () => ({ width: 20, height: 20 }),
    ownerDocument: { defaultView: { HTMLElement: Element, getComputedStyle: () => ({ visibility: 'visible' }) } } });
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function clickElement')) {
      return { result: { value: vm.runInNewContext(`(${args.functionDeclaration})`).call(element) } };
    }
    return send(target, method, args);
  };
  const result = await f.exec('click', { ref: f.ref(await f.exec('snapshot')), mode: 'dom' });
  assert.equal(clicks, 1); assert.equal(result.events_trusted, false); assert.equal(result.target_verified, undefined);
  assert.equal(f.calls.filter(call => call.method.startsWith('Input.')).length, 0);
  await assert.rejects(f.exec('click', { x: 5, y: 5, mode: 'dom' }), /requires a fresh ref/);
  await assert.rejects(f.exec('click', { ref: f.ref(await f.exec('snapshot')), mode: 'typo' }), /mode must/);
  disabled = true;
  await assert.rejects(f.exec('click', { ref: f.ref(await f.exec('snapshot')), mode: 'dom' }), /disabled/);
  assert.equal(clicks, 1);
});

test('swallowed keyboard events and forged page-world receipts cannot report delivery; timeout preserves the queue', async () => {
  const f = fixture(); await f.claim();
  const emit = f.api.debugger.onEvent.emit;
  f.api.debugger.onEvent.emit = (target, method, params) => emit(target, method,
    method === 'Runtime.bindingCalled' ? { ...params, executionContextId: 999 } : params);
  await assert.rejects(f.exec('press_key', { key: 'Z' }), /verified delivery within 5 seconds.*Browser UI/);
  const keys = f.calls.filter(call => call.method === 'Input.dispatchKeyEvent');
  assert.deepEqual(keys.map(call => call.args.type), ['rawKeyDown', 'char', 'keyUp']);
  assert.equal(f.calls.filter(call => call.method === 'Runtime.removeBinding').length, 1);
  assert.ok((await f.exec('snapshot')).snapshot);
  await f.exec('release_tab');
});

test('keyboard dispatch always queues keyUp after a failed down acknowledgement', async () => {
  const f = fixture(); await f.claim();
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Input.dispatchKeyEvent' && args.type === 'rawKeyDown') throw new Error('Input blocked');
    return result;
  };
  await assert.rejects(f.exec('press_key', { key: 'Control+A' }), /Input blocked/);
  assert.deepEqual(f.calls.filter(call => call.method === 'Input.dispatchKeyEvent').map(call => call.args.type), ['rawKeyDown', 'keyUp']);
});

test('an inaccessible child frame does not prevent verified keyboard input in the main document', async () => {
  const f = fixture(); await f.claim();
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' }, childFrames: [{ frame: { id: 'remote' } }] } };
    if (method === 'Page.createIsolatedWorld' && args.frameId === 'remote') throw new Error('Frame belongs to another process');
    return send(target, method, args);
  };
  const result = await f.exec('press_key', { key: 'Enter' });
  assert.equal(result.delivery_verified, true);
  assert.equal(result.verification_omitted_frames[0].frame_id, 'remote');
});

test('a keyboard action opening a modal fails promptly and leaves dialog handling usable', async () => {
  const f = fixture(); await f.claim();
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = (target, method, args) => {
    if (method === 'Input.dispatchKeyEvent' && args.type === 'char') {
      f.api.debugger.onEvent.emit(target, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Confirm key action' });
      return new Promise(() => {});
    }
    return send(target, method, args);
  };
  await assert.rejects(f.exec('press_key', { key: 'Enter' }), /opened a JavaScript dialog/);
  assert.equal((await f.exec('snapshot')).dialog.message, 'Confirm key action');
  assert.equal((await f.exec('handle_dialog', { accept: false })).handled, true);
});

test('keyboard validates chords and emits key up; non-http navigation is refused', async () => {
  const f = fixture(); await f.claim();
  await f.exec('press_key', { key: 'Control+Shift+ArrowLeft' });
  const events = f.calls.filter(call => call.method === 'Input.dispatchKeyEvent');
  assert.equal(events[0].args.modifiers, 10);
  assert.equal(events[1].args.type, 'keyUp');
  await assert.rejects(f.exec('navigate', { url: 'javascript:alert(1)' }), /http/);
});

test('release still works if the user navigates to a browser internal page', async () => {
  const f = fixture(); await f.claim();
  f.tabs.get(9).url = 'chrome://settings/';
  await f.exec('release_tab');
  assert.equal(f.controller.claimedCount(), 0);
  assert.ok(f.notices.some(notice => notice.type === 'detached'));
});

test('owner disconnect releases only that owner and debugger detach expires claims', async () => {
  const f = fixture(); await f.claim();
  await f.exec('release_owner', {}, 'two');
  assert.equal(f.controller.claimedCount(), 1);
  await f.exec('release_owner');
  assert.equal(f.controller.claimedCount(), 0);
  await f.claim();
  f.api.debugger.onDetach.emit({ tabId: 9 });
  await assert.rejects(f.exec('read_text'), /not claimed/);
});

test('PNG capture supports viewport and bounded full-page screenshots', async () => {
  const f = fixture(); await f.claim();
  assert.equal((await f.exec('screenshot')).data, 'image-data');
  const full = await f.exec('screenshot', { full_page: true, include_indicators: true });
  assert.equal(full.capture.agent_indicators_included, true);
  const calls = f.calls.filter(call => call.method === 'Page.captureScreenshot');
  assert.equal(calls[1].args.clip.height, 1800);
  assert.ok(!f.calls.some(call => call.method === 'Runtime.evaluate' && call.args.expression.includes('__localBrowserAttachVisual')));
});

test('a hidden-page screenshot timeout leaves the native group marker and tab queue usable', async () => {
  const f = fixture(); await f.claim();
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = (target, method, args) => method === 'Page.captureScreenshot'
    ? new Promise(() => {}) : send(target, method, args);
  await assert.rejects(f.exec('screenshot'), /Screenshot did not finish within 5 seconds/);
  assert.ok(f.tabs.get(9).groupId >= 0);
  assert.ok((await f.exec('snapshot')).snapshot);
  await f.exec('release_tab');
  assert.equal(f.controller.claimedCount(), 0);
});

test('JavaScript dialogs are observed without hanging AX and can be dismissed', async () => {
  const f = fixture(); await f.claim();
  f.api.debugger.onEvent.emit({ tabId: 9 }, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Continue?' });
  assert.equal((await f.exec('snapshot')).dialog.message, 'Continue?');
  await assert.rejects(f.exec('click', { x: 1, y: 1 }), /dialog is open/);
  await f.exec('handle_dialog', { accept: false });
  assert.ok(f.calls.some(call => call.method === 'Page.handleJavaScriptDialog' && call.args.accept === false));
});

test('a modal that blocks an input response does not block the next tool', async () => {
  const f = fixture(); await f.claim(); f.modal();
  await assert.rejects(f.exec('click', { x: 10, y: 10 }), /opened a JavaScript dialog/);
  assert.equal((await f.exec('snapshot')).dialog.message, 'Modal');
  await f.exec('handle_dialog', { accept: false });
  await f.exec('release_tab');
});

test('claim shows a native tab-group marker; clicks retain only transient feedback without activation', async () => {
  const f = fixture(); await f.claim();
  assert.ok(f.calls.some(call => call.method === 'badge' && call.args.text === 'RUN' && call.args.tabId === 9));
  assert.ok(f.calls.some(call => call.method === 'tabGroups.update' && call.args.title === '🔴' && call.args.color === 'red'));
  assert.ok(!f.calls.some(call => call.method === 'Runtime.evaluate' && call.args.expression.includes('__localBrowserAttachClickVisual')));
  await f.exec('click', { x: 20, y: 30 });
  assert.ok(!f.calls.some(call => call.method === 'Page.addScriptToEvaluateOnNewDocument'));
  assert.ok(!f.calls.some(call => call.method === 'Runtime.evaluate' && call.args.expression.includes('__localBrowserAttachVisual')));
  assert.ok(f.calls.some(call => call.method === 'Runtime.evaluate' && call.args.expression.includes('__localBrowserAttachClickVisual.click(20,30)')));
  assert.ok(!f.calls.some(call => call.method === 'Page.bringToFront'));
  await f.exec('release_tab');
  assert.ok(f.calls.some(call => call.method === 'tabs.ungroup'));
  assert.ok(f.calls.some(call => call.method === 'badge' && call.args.text === ''));
});

test('a screenshot after click hides transient feedback before capture and then restores visibility', async () => {
  const f = fixture(); await f.claim();
  await f.exec('click', { x: 20, y: 30 });
  const result = await f.exec('screenshot');
  assert.equal(result.capture.agent_indicators_included, false);
  const hidden = f.calls.findIndex(call => call.method === 'Runtime.evaluate' && call.args.expression.includes('?.visible(false)'));
  const capture = f.calls.findIndex(call => call.method === 'Page.captureScreenshot');
  assert.ok(hidden >= 0 && hidden < capture);
  assert.ok(f.calls.slice(capture + 1).some(call => call.method === 'Runtime.evaluate' && call.args.expression.includes('?.visible(true)')));
});

test('user debugger detach restores the marker group without page cleanup access', async () => {
  const f = fixture(); await f.claim();
  assert.ok(f.tabs.get(9).groupId >= 0);
  f.api.debugger.onDetach.emit({ tabId: 9 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.tabs.get(9).groupId, -1);
  assert.equal(f.controller.claimedCount(), 0);
});

test('stalled click feedback cannot block release or draw a late marker after detach', async () => {
  const f = fixture(); await f.claim();
  const send = f.api.debugger.sendCommand;
  let finishSetup;
  f.api.debugger.sendCommand = (target, method, args) => {
    if (method === 'Page.createIsolatedWorld' && args.worldName === 'local-browser-attach-click-visual') {
      return new Promise(resolve => { finishSetup = resolve; });
    }
    return send(target, method, args);
  };
  await f.exec('click', { x: 20, y: 30 });
  await f.exec('release_tab');
  assert.equal(f.controller.claimedCount(), 0);
  finishSetup({ executionContextId: 43 });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(!f.calls.some(call => call.method === 'Runtime.evaluate' && call.args.expression.includes('__localBrowserAttachClickVisual.click(')));
});

test('AX iframe owners expose remote frame coverage when the frame tree omits them', async () => {
  const f = fixture(); await f.claim();
  f.nodes([{ nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2'] },
    { nodeId: '2', role: { value: 'Iframe' }, backendDOMNodeId: 22, name: { value: 'Remote' } }]);
  const snapshot = await f.exec('snapshot');
  assert.equal(snapshot.omitted_frames[0].url, 'https://frame.test/');
  assert.match(snapshot.omitted_frames[0].reason, /another process/);
});

test('long AX names can be continued without loss, with stable refs and configurable budgets', async () => {
  const f = fixture(); await f.claim();
  const nodes = [{ nodeId: 'root', role: { value: 'RootWebArea' }, childIds: [] }];
  for (let i = 0; i < 80; i++) {
    nodes[0].childIds.push(String(i));
    nodes.push({ nodeId: String(i), role: { value: 'button' }, backendDOMNodeId: i + 1, name: { value: '长文本"\\'.repeat(200) } });
  }
  f.nodes(nodes);
  const snapshot = await f.exec('snapshot', { max_nodes: 3000, max_chars: 14000 });
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.truncation_reason, 'text_budget');
  assert.ok(JSON.stringify(snapshot).length < 16000);
  let page = snapshot, count = snapshot.node_count;
  while (page.next_cursor) {
    page = await f.exec('snapshot', { cursor: page.next_cursor, max_nodes: 3000, max_chars: 14000 });
    assert.equal(page.snapshot_id, snapshot.snapshot_id);
    count += page.node_count;
  }
  assert.equal(count, 81);
  assert.equal(f.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length, 1);
  const stale = await f.exec('snapshot', { max_chars: 14000 });
  await f.exec('click', { ref: stale.snapshot.match(/\[([^\]]+)\] button/)[1] });
  await assert.rejects(f.exec('snapshot', { cursor: stale.next_cursor }), /stale/);
});

test('compact AX represents 200 list items without duplicate inline text or lost interactive children', async () => {
  const f = fixture(); await f.claim();
  const nodes = [{ nodeId: 'root', role: { value: 'RootWebArea' }, childIds: [] }];
  for (let i = 1; i <= 200; i++) {
    nodes[0].childIds.push(`li${i}`);
    nodes.push({ nodeId: `li${i}`, role: { value: 'listitem' }, backendDOMNodeId: i, childIds: [`text${i}`] },
      { nodeId: `text${i}`, role: { value: 'StaticText' }, name: { value: `Row ${i}: alpha beta gamma delta epsilon` }, childIds: [`inline${i}`] },
      { nodeId: `inline${i}`, role: { value: 'InlineTextBox' }, name: { value: `Row ${i}: alpha beta gamma delta epsilon` } });
  }
  nodes[0].childIds.push('button');
  nodes.push({ nodeId: 'button', backendDOMNodeId: 500, role: { value: 'button' }, name: { value: 'Go' }, childIds: ['label'] },
    { nodeId: 'label', role: { value: 'StaticText' }, name: { value: 'Go' } });
  f.nodes(nodes);
  const page = await f.exec('snapshot');
  assert.equal(page.truncated, false);
  assert.equal(page.node_count, 202);
  assert.equal((page.snapshot.match(/Row /g) || []).length, 200);
  assert.doesNotMatch(page.snapshot, /InlineTextBox|StaticText/);
  assert.match(page.snapshot, /button "Go"/);
});

test('mouse acknowledgments cannot serialize dispatch; mismatched events never report clicked', async () => {
  const f = fixture(); await f.claim();
  const send = f.api.debugger.sendCommand;
  let releaseMove;
  f.api.debugger.sendCommand = (target, method, args) => {
    if (method === 'Input.dispatchMouseEvent' && args.type === 'mouseMoved') {
      void send(target, method, args);
      return new Promise(resolve => { releaseMove = resolve; });
    }
    if (method === 'Input.dispatchMouseEvent' && args.type === 'mouseReleased') releaseMove({});
    return send(target, method, args);
  };
  const result = await f.exec('click', { x: 55, y: 30 });
  assert.equal(result.target_verified, true);
  assert.equal(result.application_result, 'not_checked');
  const inputs = f.calls.filter(call => call.method === 'Input.dispatchMouseEvent');
  assert.deepEqual(inputs.map(call => call.args.buttons), [0, 1, 0]);
  const listener = f.api.debugger.onEvent.emit;
  f.api.debugger.onEvent.emit = (target, method, args) => listener(target, method,
    method === 'Runtime.bindingCalled' ? { ...args, payload: '{"matched":false}' } : args);
  await assert.rejects(f.exec('click', { x: 55, y: 30 }), /target changed/);
  assert.ok((await f.exec('snapshot')).snapshot);
});

test('missing trusted click events time out explicitly and the tab remains usable', async () => {
  const f = fixture(); await f.claim();
  const emit = f.api.debugger.onEvent.emit;
  f.api.debugger.onEvent.emit = (target, method, args) => {
    if (method !== 'Runtime.bindingCalled') emit(target, method, args);
  };
  await assert.rejects(f.exec('click', { x: 55, y: 30 }), /Outcome is unknown/);
  assert.ok((await f.exec('snapshot')).snapshot);
});

test('navigate returns destination metadata and actionable snapshot in one operation', async () => {
  const f = fixture(); await f.claim();
  const old = f.ref(await f.exec('snapshot'));
  const result = await f.exec('navigate', { url: 'http://localhost:8000/destination' });
  assert.equal(result.title, 'Destination'); assert.equal(result.url, 'http://localhost:8000/destination');
  await assert.rejects(f.exec('click', { ref: old }), /stale/);
  await f.exec('click', { ref: f.ref(result) });
});

test('a document change during an AX read cannot resurrect invalidated refs and cursors', async () => {
  const f = fixture(); await f.claim();
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Accessibility.getFullAXTree') f.api.debugger.onEvent.emit(target, 'DOM.documentUpdated');
    return result;
  };
  await assert.rejects(f.exec('snapshot'), /Document changed/);
});

test('claim intercepts file choosers, click reports one, upload uses the native input and clears pending state', async () => {
  const f = fixture(); await f.claim();
  assert.ok(f.calls.some(call => call.method === 'Page.setInterceptFileChooserDialog' && call.args.enabled));
  f.api.debugger.onEvent.emit({ tabId: 9 }, 'Page.fileChooserOpened', { backendNodeId: 77, mode: 'selectMultiple', frameId: 'main' });
  assert.equal((await f.exec('snapshot')).file_chooser.mode, 'selectMultiple');
  const result = await f.exec('upload_file', { files: ['C:\\fixtures\\中文 file.txt', 'C:\\fixtures\\empty.txt'] });
  assert.equal(result.files_set, 2);
  assert.equal(result.file_chooser, undefined);
  assert.deepEqual(f.calls.find(call => call.method === 'DOM.setFileInputFiles').args,
    { objectId: 'file-input', files: ['C:\\fixtures\\中文 file.txt', 'C:\\fixtures\\empty.txt'] });
  await assert.rejects(f.exec('upload_file', { files: [] }), /No pending file chooser/);
});

test('direct upload consumes refs; [] clears and file chooser state expires on navigation and release', async () => {
  const f = fixture(); await f.claim();
  const ref = f.ref(await f.exec('snapshot'));
  assert.equal((await f.exec('upload_file', { ref, files: [] })).cleared, true);
  await assert.rejects(f.exec('upload_file', { ref, files: [] }), /stale/);
  f.api.debugger.onEvent.emit({ tabId: 9 }, 'Page.fileChooserOpened', { backendNodeId: 77, mode: 'selectSingle' });
  f.api.debugger.onEvent.emit({ tabId: 9 }, 'Page.frameNavigated', { frame: { id: 'main' } });
  await assert.rejects(f.exec('upload_file', { files: [] }), /No pending/);
  f.api.debugger.onEvent.emit({ tabId: 9 }, 'Page.fileChooserOpened', { backendNodeId: 77 });
  await f.exec('release_tab'); await f.claim();
  assert.equal((await f.exec('snapshot')).file_chooser, undefined);
});

test('upload validation failure never dispatches native file assignment', async () => {
  const f = fixture(); await f.claim();
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes("input.type !== 'file'"))
      return { exceptionDetails: { text: 'Single-file input cannot accept multiple files' } };
    return send(target, method, args);
  };
  const ref = f.ref(await f.exec('snapshot'));
  await assert.rejects(f.exec('upload_file', { ref, files: ['C:\\a', 'C:\\b'] }), /Single-file/);
  assert.ok(!f.calls.some(call => call.method === 'DOM.setFileInputFiles'));
});

function withChildFrames(f) {
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Page.getFrameTree') result.frameTree.childFrames = [{
      frame: { id: 'ad', parentId: 'main', url: 'http://localhost:8000/ad' },
      childFrames: [{ frame: { id: 'nested', parentId: 'ad', url: 'http://localhost:8000/nested' } }],
    }];
    if (method === 'Accessibility.getFullAXTree' && args.frameId !== 'main') result.nodes = [
      { nodeId: args.frameId, backendDOMNodeId: args.frameId === 'ad' ? 70 : 71,
        role: { value: 'button' }, name: { value: args.frameId } },
    ];
    return result;
  };
}

test('iframe navigation preserves main refs, invalidates descendant refs and scopes chooser cleanup', async () => {
  const f = fixture(); withChildFrames(f); await f.claim();
  const snap = await f.exec('snapshot'), mainRef = f.ref(snap);
  const adRef = snap.snapshot.match(/\[([^\]]+)\] button "ad"/)[1];
  const nestedRef = snap.snapshot.match(/\[([^\]]+)\] button "nested"/)[1];
  const emit = (method, params) => f.api.debugger.onEvent.emit({ tabId: 9 }, method, params);
  emit('Page.fileChooserOpened', { backendNodeId: 77, mode: 'selectSingle', frameId: 'main' });
  emit('Page.frameNavigated', { frame: { id: 'ad', parentId: 'main' } });
  f.api.tabs.onUpdated.emit(9, { status: 'loading' });
  f.api.tabs.onUpdated.emit(9, { status: 'complete' });
  await assert.rejects(f.exec('click', { ref: adRef }), /stale/);
  await assert.rejects(f.exec('click', { ref: nestedRef }), /stale/);
  assert.equal((await f.exec('click', { ref: mainRef })).file_chooser.pending, true);
  emit('Page.fileChooserOpened', { backendNodeId: 77, frameId: 'nested' });
  emit('Page.navigatedWithinDocument', { frameId: 'ad' });
  await assert.rejects(f.exec('upload_file', { files: [] }), /No pending/);
});

test('iframe refresh during AX reading omits only its changed subtree and keeps main refs usable', async () => {
  const f = fixture(); withChildFrames(f); await f.claim();
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Accessibility.getFullAXTree' && args.frameId === 'nested') {
      f.api.debugger.onEvent.emit(target, 'Page.frameNavigated', { frame: { id: 'ad', parentId: 'main' } });
    }
    return result;
  };
  const snap = await f.exec('snapshot');
  assert.match(snap.snapshot, /button "Submit"/);
  assert.doesNotMatch(snap.snapshot, /button "ad"|button "nested"/);
  assert.deepEqual(snap.omitted_frames.map(frame => frame.frame_id), ['ad', 'nested']);
  await f.exec('click', { ref: f.ref(snap) });
});

test('iframe detach preserves cursor continuation and filters obsolete child entries', async () => {
  const f = fixture(); withChildFrames(f); await f.claim();
  f.nodes(Array.from({ length: 16 }, (_, i) => ({ nodeId: String(i), backendDOMNodeId: 100 + i,
    role: { value: 'button' }, name: { value: `Main ${i}` } })));
  const first = await f.exec('snapshot', { max_nodes: 10 });
  f.api.debugger.onEvent.emit({ tabId: 9 }, 'Page.frameDetached', { frameId: 'ad', reason: 'remove' });
  const next = await f.exec('snapshot', { cursor: first.next_cursor });
  assert.equal(next.total_node_count, 16);
  assert.equal(next.node_count, 6);
  assert.doesNotMatch(next.snapshot, /button "ad"|button "nested"/);
  await f.exec('click', { ref: f.ref(first) });
});

test('main-frame navigation and same-document navigation still invalidate the observation', async () => {
  for (const [method, params] of [
    ['Page.frameNavigated', { frame: { id: 'main' } }],
    ['Page.navigatedWithinDocument', { frameId: 'main' }],
  ]) {
    const f = fixture(); await f.claim(); const ref = f.ref(await f.exec('snapshot'));
    f.api.debugger.onEvent.emit({ tabId: 9 }, method, params);
    await assert.rejects(f.exec('click', { ref }), /stale/);
  }
});

test('continuously moving refs still dispatch a verified native click with current geometry', async () => {
  const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
  let sample = 0;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function checkClickable')) result.result.value.x = ++sample;
    return result;
  };
  const result = await f.exec('click', { ref: f.ref(await f.exec('snapshot')) });
  assert.ok(sample > 1);
  assert.equal(result.target_verified, true);
  assert.equal(f.calls.filter(call => call.method === 'Input.dispatchMouseEvent').length, 3);
});

test('tab lifecycle is explicit, HTTP(S)-only and requires ownership to activate or close', async () => {
  const f = fixture();
  await assert.rejects(f.exec('open_tab', { url: 'javascript:alert(1)' }), /http/);
  const opened = await f.exec('open_tab', { url: 'https://example.com/' });
  assert.equal(opened.tab_id, 10); assert.equal(opened.active, false);
  assert.equal(f.controller.claimedCount(), 0);
  assert.equal((await f.claim()).activation_requested, false);
  const snap = await f.exec('snapshot');
  await assert.rejects(f.exec('activate_tab', {}, 'two'), /not claimed/);
  await assert.rejects(f.exec('close_tab', {}, 'two'), /not claimed/);
  await f.exec('activate_tab', { focus_window: false });
  assert.ok(!f.calls.some(call => call.method === 'windows.update'));
  await f.exec('activate_tab');
  assert.deepEqual(f.calls.find(call => call.method === 'windows.update').args, { focused: true });
  await f.exec('click', { ref: f.ref(snap) });
  f.tabs.get(9).url = 'chrome://settings/';
  assert.equal((await f.exec('close_tab')).closed, true);
  assert.equal(f.controller.claimedCount(), 0);
  await assert.rejects(f.exec('read_text'), /not claimed/);
});
