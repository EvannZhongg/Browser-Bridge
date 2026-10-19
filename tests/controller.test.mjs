import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../extension/controller.js';

function event() { const callbacks = []; return { addListener(fn) { callbacks.push(fn); }, emit(...args) { for (const fn of callbacks) fn(...args); } }; }
function fixture() {
  const calls = [];
  const notices = [];
  const tabs = new Map([[9, { id: 9, windowId: 1, title: 'Demo', url: 'http://localhost:8000/', active: true }]]);
  let blocked = false;
  let modalOnClick = false;
  let customNodes;
  const api = { action: {
      setBadgeText: async args => { calls.push({ method: 'badge', args }); },
      setBadgeBackgroundColor: async () => {}, setTitle: async () => {},
    }, tabs: { get: async id => tabs.get(id), query: async () => [...tabs.values()], onRemoved: event(), onUpdated: event() },
    debugger: { onDetach: event(), onEvent: event(),
      attach: async (target, version) => { calls.push({ method: 'attach', target, version }); },
      detach: async target => { calls.push({ method: 'detach', target }); api.debugger.onDetach.emit(target); },
      sendCommand: async (target, method, args) => {
        calls.push({ method, args, target });
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
        if (method === 'DOM.getNodeForLocation') return { backendNodeId: 12 };
        if (method === 'Runtime.evaluate') return { result: { value: { width: 1024, height: 768, scroll_x: 0, scroll_y: 0, device_pixel_ratio: 1 } } };
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

test('fill uses a resolved node and text input; no arbitrary script operation exists', async () => {
  const f = fixture(); await f.claim();
  const snapshot = await f.exec('snapshot');
  const ref = snapshot.snapshot.match(/\[([^\]]+)\] textbox/)[1];
  await f.exec('fill', { ref, text: '中文 hello' });
  assert.deepEqual(f.calls.find(call => call.method === 'Input.insertText').args, { text: '中文 hello' });
  await assert.rejects(f.exec('evaluate', { expression: 'fetch("https://evil.test")' }), /Unknown operation/);
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
  await f.exec('screenshot', { full_page: true });
  const calls = f.calls.filter(call => call.method === 'Page.captureScreenshot');
  assert.equal(calls[1].args.clip.height, 1800);
  const hide = f.calls.findIndex(call => call.method === 'Runtime.evaluate' && call.args.expression.includes('visible(false)'));
  const capture = f.calls.findIndex(call => call.method === 'Page.captureScreenshot');
  assert.ok(hide >= 0 && hide < capture);
});

test('a hidden-page screenshot timeout restores indicators and leaves the tab queue usable', async () => {
  const f = fixture(); await f.claim();
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = (target, method, args) => method === 'Page.captureScreenshot'
    ? new Promise(() => {}) : send(target, method, args);
  await assert.rejects(f.exec('screenshot'), /Screenshot did not finish within 5 seconds/);
  assert.ok(f.calls.some(call => call.method === 'Runtime.evaluate' && call.args.expression.includes('visible(true)')));
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

test('claim sets a per-tab badge; click draws in an isolated world without activating the tab', async () => {
  const f = fixture(); await f.claim();
  assert.ok(f.calls.some(call => call.method === 'badge' && call.args.text === 'RUN' && call.args.tabId === 9));
  assert.ok(f.calls.some(call => call.method === 'Page.addScriptToEvaluateOnNewDocument'));
  await f.exec('click', { x: 20, y: 30 });
  assert.ok(f.calls.some(call => call.method === 'Runtime.evaluate' && call.args.expression.includes('?.click(20,30)')));
  assert.ok(!f.calls.some(call => call.method === 'Page.bringToFront'));
  await f.exec('release_tab');
  assert.ok(f.calls.some(call => call.method === 'Page.removeScriptToEvaluateOnNewDocument'));
  assert.ok(f.calls.some(call => call.method === 'badge' && call.args.text === ''));
});

test('AX iframe owners expose remote frame coverage when the frame tree omits them', async () => {
  const f = fixture(); await f.claim();
  f.nodes([{ nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2'] },
    { nodeId: '2', role: { value: 'Iframe' }, backendDOMNodeId: 22, name: { value: 'Remote' } }]);
  const snapshot = await f.exec('snapshot');
  assert.equal(snapshot.omitted_frames[0].url, 'https://frame.test/');
  assert.match(snapshot.omitted_frames[0].reason, /another process/);
});

test('long AX names stop at an explicit serialized text budget', async () => {
  const f = fixture(); await f.claim();
  const nodes = [{ nodeId: 'root', role: { value: 'RootWebArea' }, childIds: [] }];
  for (let i = 0; i < 80; i++) {
    nodes[0].childIds.push(String(i));
    nodes.push({ nodeId: String(i), role: { value: 'button' }, backendDOMNodeId: i + 1, name: { value: '长文本"\\'.repeat(200) } });
  }
  f.nodes(nodes);
  const snapshot = await f.exec('snapshot', { max_nodes: 3000 });
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.truncation_reason, 'text_budget');
  assert.ok(JSON.stringify(snapshot).length < 16000);
});
