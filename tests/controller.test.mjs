import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createController } from '../extension/controller.js';
import { serializeEvaluation } from '../extension/evaluate.js';

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
  const axTrees = [];
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
    }, windows: { get: async id => ({ id, focused: true, state: 'normal' }), update: async (id, args) => { calls.push({ method: 'windows.update', id, args }); } },
    debugger: { onDetach: event(), onEvent: event(),
      attach: async (target, version) => { calls.push({ method: 'attach', target, version }); },
      detach: async target => { calls.push({ method: 'detach', target }); api.debugger.onDetach.emit(target); },
      sendCommand: async (target, method, args) => {
        calls.push({ method, args, target });
        if (method === 'Runtime.addBinding') binding = args.name;
        if (method === 'Input.dispatchKeyEvent' && ['rawKeyDown', 'keyDown'].includes(args.type)) {
          api.debugger.onEvent.emit(target, 'Runtime.bindingCalled', { name: binding, executionContextId: 42, payload: '{"delivered":true}' });
        }
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 42 };
        if (method === 'Page.navigate') {
          tabs.get(target.tabId).url = args.url; tabs.get(target.tabId).title = 'Destination';
          api.debugger.onEvent.emit(target, 'Page.frameNavigated', { frame: { id: 'main' } });
          api.debugger.onEvent.emit(target, 'Page.lifecycleEvent', { frameId: 'main', loaderId: 'new', name: 'DOMContentLoaded' });
          api.debugger.onEvent.emit(target, 'Page.lifecycleEvent', { frameId: 'main', loaderId: 'new', name: 'load' });
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
        if (method === 'Accessibility.getPartialAXTree') return { nodes: axTrees.filter(tree => tree.sessionId === target.sessionId).flatMap(tree => tree.result.nodes).filter(node => node.backendDOMNodeId === args.backendNodeId).slice(-1) };
        if (method === 'Accessibility.getFullAXTree') { const result = { nodes: customNodes || [
          { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Demo' }, childIds: ['2', '3'] },
          { nodeId: '2', backendDOMNodeId: 12, role: { value: 'button' }, name: { value: 'Submit' } },
          { nodeId: '3', backendDOMNodeId: 13, role: { value: 'textbox' }, name: { value: 'Name' } },
        ] }; axTrees.push({ sessionId: target.sessionId, result }); return result; }
        if (method === 'Runtime.evaluate' && args.expression.startsWith('(function queryElement')) return { result: { objectId: 'selector-node' } };
        if (method === 'DOM.describeNode' && args.objectId === 'selector-node') return { node: { backendNodeId: 12 } };
        if (method === 'DOM.describeNode' && args.objectId === 'focused') return { node: {} };
        if (method === 'Runtime.evaluate' && args.expression.includes('function activeElement')) return { result: { objectId: 'focused' } };
        if (method === 'DOM.describeNode') return { node: { frameId: 'remote', attributes: ['src', 'https://frame.test/'] } };
        if (method === 'DOM.resolveNode') return { object: { objectId: `object-${args.backendNodeId}` } };
        if (method === 'DOM.getContentQuads') return { quads: [[10, 10, 100, 10, 100, 50, 10, 50]] };
        if (method === 'DOM.getNodeForLocation') return { backendNodeId: 12, frameId: 'main' };
        if (method === 'Runtime.evaluate' && args.expression.includes('function installKeyReceipt')) return { result: { objectId: 'key-guard' } };
        if (method === 'Runtime.evaluate' && args.expression.includes('visibility_state: document.visibilityState')) return { result: { value: { visibility_state: 'visible', has_focus: true } } };
        if (method === 'Runtime.evaluate' && args.expression.includes('title: document.title')) return { result: { value: { title: tabs.get(9).title, url: tabs.get(9).url } } };
        if (method === 'Runtime.evaluate') return { result: { value: { width: 1024, height: 768, scroll_x: 0, scroll_y: 0, device_pixel_ratio: 1 } } };
        if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function installGuard')) return { result: { objectId: 'guard' } };
        if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function inspectTarget')) return { result: { value: { ready: true, x: 10, y: 10, width: 90, height: 40 } } };
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

test('tab_id claim tolerates title drift; explicitly supplied identity guards still fail', async () => {
  const f = fixture(); f.tabs.get(9).title = 'New title';
  await assert.rejects(f.claim(), /changed/);
  const claimed = await f.exec('claim_tab');
  assert.equal(claimed.title, 'New title');
  await assert.rejects(f.exec('click', { ref: 'old', selector: '#submit' }), /exactly one/);
  await assert.rejects(f.exec('click', { selector: '#submit', mode: 'dom', coordinate_space: 'document' }), /coordinate clicks only/);
});

test('background native click fails before renderer work, keeps refs and can recover after explicit activation', async () => {
  const f = fixture(); await f.claim(); const ref = f.ref(await f.exec('snapshot'));
  f.tabs.get(9).active = false;
  f.calls.length = 0;
  await assert.rejects(f.exec('click', { ref, timeout_ms: 30000 }), error => {
    assert.match(error.message, /TAB_NOT_READY.*tab not active.*browser_tab_control action=activate.*No input was dispatched/);
    assert.doesNotMatch(error.message, /unknown/i); return true;
  });
  assert.equal(f.calls.length, 0);
  await f.exec('activate_tab');
  assert.equal((await f.exec('click', { ref })).target_verified, true);
});

test('active occluded and unfocused native click verifies delivery without bringing the page forward', async () => {
  for (const state of [{ visibility_state: 'hidden', has_focus: false }, { visibility_state: 'visible', has_focus: false }]) {
    const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
    f.api.windows.get = async () => ({ focused: false, state: 'maximized' });
    f.api.debugger.sendCommand = async (target, method, args) => method === 'Runtime.evaluate' && args.expression.includes('visibility_state: document.visibilityState')
      ? { result: { value: state } } : send(target, method, args);
    const result = await f.exec('click', { x: 10, y: 10 });
    assert.equal(result.target_verified, true);
    assert.equal(result.page_state.visibility_state, state.visibility_state);
    assert.equal(result.page_state.window_focused, false);
    assert.ok(!f.calls.some(call => ['Page.bringToFront', 'tabs.update', 'windows.update'].includes(call.method)));
  }
  const f = fixture(); await f.claim(); f.calls.length = 0;
  f.api.windows.get = async () => ({ focused: false, state: 'minimized' });
  await assert.rejects(f.exec('click', { x: 10, y: 10 }), /TAB_NOT_READY.*minimized/);
  assert.equal(f.calls.length, 0);
  for (const property of ['discarded', 'frozen']) {
    const f = fixture(); await f.claim(); f.tabs.get(9)[property] = true; f.calls.length = 0;
    await assert.rejects(f.exec('click', { selector: '#submit' }), /TAB_NOT_READY.*renderer suspended/);
    assert.equal(f.calls.length, 0);
  }
});

test('an unresponsive click preflight fails in 500ms without consuming the input timeout or dispatching late input', async t => {
  const f = fixture(); await f.claim(); t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const send = f.api.debugger.sendCommand; let finish;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Runtime.evaluate' && args.expression.includes('visibility_state: document.visibilityState')) return await new Promise(resolve => {
      finish = () => resolve({ result: { value: { visibility_state: 'visible', has_focus: true } } });
    });
    return send(target, method, args);
  };
  const result = assert.rejects(f.exec('click', { x: 10, y: 10, timeout_ms: 30000 }), /TAB_NOT_READY.*within 500 ms.*No input was dispatched/);
  await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(500); await result;
  finish(); await new Promise(resolve => setImmediate(resolve));
  assert.ok(!f.calls.some(call => call.method.startsWith('Input.')));
  assert.ok((await f.exec('snapshot')).snapshot);
});

test('window minimized during native preparation is caught by the final preflight without dispatch or fallback', async () => {
  const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand; let checks = 0;
  f.api.windows.get = async () => ({ focused: false, state: ++checks === 1 ? 'normal' : 'minimized' });
  f.api.debugger.sendCommand = async (target, method, args) => method === 'Runtime.evaluate' && args.expression.includes('visibility_state: document.visibilityState')
    ? { result: { value: { visibility_state: 'visible', has_focus: true } } } : send(target, method, args);
  await assert.rejects(f.exec('click', { x: 10, y: 10 }), /TAB_NOT_READY.*minimized/);
  assert.equal(checks, 2);
  assert.ok(!f.calls.some(call => call.method.startsWith('Input.') || call.args?.functionDeclaration?.includes('function clickElement')));
});

test('hasFocus false alone does not reject an active visible page in a focused window', async () => {
  const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => method === 'Runtime.evaluate' && args.expression.includes('visibility_state: document.visibilityState')
    ? { result: { value: { visibility_state: 'visible', has_focus: false } } } : send(target, method, args);
  const result = await f.exec('click', { x: 10, y: 10 });
  assert.equal(result.target_verified, true); assert.equal(result.page_state.has_focus, false); assert.equal(result.page_state.window_focused, true);
});

test('explicit DOM click remains available on a background tab without a native readiness check', async () => {
  const f = fixture(); await f.claim(); f.tabs.get(9).active = false;
  const result = await f.exec('click', { ref: f.ref(await f.exec('snapshot')), mode: 'dom' });
  assert.equal(result.method, 'dom'); assert.equal(result.events_trusted, false);
  assert.ok(!f.calls.some(call => call.method.startsWith('Input.') || call.args?.expression?.includes('visibility_state: document.visibilityState')));
});

test('selectors resolve afresh per action, route isolated frame nodes and refuse ambiguous targets', async () => {
  const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
  let resolutions = 0;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Runtime.evaluate' && args.expression.includes('function queryElement')) {
      resolutions++;
      if (args.expression.endsWith('("button","css",undefined,true)')) return { exceptionDetails: { text: 'Selector must match exactly one element; matched 2' } };
      return { result: { objectId: 'selector-node' } };
    }
    if (method === 'DOM.describeNode' && args.objectId === 'selector-node') return { node: { backendNodeId: 12 } };
    return send(target, method, args);
  };
  await f.exec('click', { selector: '#submit' });
  await f.exec('click', { selector: '//button[@id="submit"]', selector_type: 'xpath' });
  await f.exec('fill', { selector: '#name', text: 'controlled', mode: 'dom' });
  const dispatched = f.calls.filter(call => call.method === 'Input.dispatchMouseEvent').length;
  await assert.rejects(f.exec('click', { selector: 'button' }), /matched 2/);
  assert.equal(resolutions, 4);
  assert.equal(f.calls.filter(call => call.method === 'Input.dispatchMouseEvent').length, dispatched);
  await assert.rejects(f.exec('click', { selector: '#submit', frame_id: 'missing' }), /unknown/);
});

test('document coordinate click scrolls once and converts back to viewport before dispatch', async () => {
  const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand; let scrolled = false;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Runtime.evaluate' && args.expression.startsWith('scrollTo(')) scrolled = true;
    if (scrolled && method === 'Runtime.evaluate' && args.expression.includes('scroll_x: scrollX')) result.result.value.scroll_y = 1200;
    return result;
  };
  const result = await f.exec('click', { x: 100, y: 1500, coordinate_space: 'document' });
  assert.deepEqual(result.clicked, { x: 100, y: 300 });
  assert.equal(f.calls.filter(call => call.args?.expression?.startsWith('scrollTo(')).length, 1);
  assert.ok(f.calls.filter(call => call.method === 'Input.dispatchMouseEvent').every(call => call.args.y === 300));
});

test('coordinate pseudo-element hits normalize to their originating element for hints and event guards', async () => {
  const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'DOM.resolveNode' && args.backendNodeId === 12) return { object: { objectId: 'pseudo', className: 'CSSPseudoElement' } };
    if (method === 'Runtime.callFunctionOn' && args.objectId === 'pseudo') {
      const result = vm.runInNewContext(`(${args.functionDeclaration})`).call({ element: { nodeType: 1 } });
      assert.equal(result.nodeType, 1);
      return { result: { objectId: 'origin' } };
    }
    if (method === 'DOM.describeNode' && args.objectId === 'origin') return { node: { backendNodeId: 99 } };
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function describeHit')) {
      assert.equal(args.objectId, 'origin'); return { result: { value: { tag: 'button', clickable_hint: true } } };
    }
    return send(target, method, args);
  };
  const result = await f.exec('click', { x: 10, y: 10 });
  assert.equal(result.target_verified, true); assert.equal(result.hit_target.pseudo_element, true);
  assert.ok(f.calls.some(call => call.method === 'DOM.resolveNode' && call.args.executionContextId === 42 && call.args.backendNodeId === 99));
});

test('batch uses one queue, fresh selector resolution and explicit native Tab for blur', async () => {
  const f = fixture(); await f.claim(); f.calls.length = 0;
  const batch = f.exec('batch', { steps: [
    { action: 'click', selector: '#open' }, { action: 'fill', selector: 'input', nth: 1, text: '2026' },
    { action: 'press_key', key: 'Tab' }, { action: 'click', selector: '.option' },
  ] });
  const later = f.exec('press_key', { key: 'Escape' });
  const result = await batch; await later;
  assert.equal(result.completed, true); assert.equal(result.results.length, 4);
  assert.equal(result.results[1].application_result, 'not_checked');
  const actions = f.calls.filter(c => c.method === 'Input.insertText' || c.method === 'Input.dispatchMouseEvent' && c.args.type === 'mouseReleased' || c.method === 'Input.dispatchKeyEvent' && c.args.type === 'rawKeyDown');
  assert.deepEqual(actions.map(c => c.args.text || c.args.key || 'click'), ['click', '2026', 'Tab', 'click', 'Escape']);
  const queries = f.calls.filter(c => c.method === 'Runtime.evaluate' && c.args.expression.includes('function queryElement'));
  assert.equal(queries.length, 3); assert.ok(queries[1].args.expression.endsWith('("input","css",1,true)'));
});

test('batch validates all steps first; on a dispatched failure it returns prior results and never continues or replays', async () => {
  const f = fixture(); await f.claim(); f.calls.length = 0;
  await assert.rejects(f.exec('batch', { steps: [{ action: 'click', selector: '#open' }, { action: 'press_key', key: 'F99' }] }), /Unsupported key/);
  assert.equal(f.calls.length, 0);
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function verifyFill')) return { result: { value: false } };
    return send(target, method, args);
  };
  const result = await f.exec('batch', { steps: [
    { action: 'click', selector: '#open' }, { action: 'fill', selector: '#edit', text: 'lost' }, { action: 'press_key', key: 'Enter' },
  ] });
  assert.equal(result.completed, false); assert.equal(result.failed_step, 1); assert.equal(result.results.length, 1);
  assert.match(result.error, /Outcome is unknown/);
  assert.equal(f.calls.filter(c => c.method === 'Input.insertText').length, 1);
  assert.ok(!f.calls.some(c => c.method === 'Input.dispatchKeyEvent'));
  assert.ok((await f.exec('snapshot')).snapshot);
});

test('batch shares one deadline and a late reply cannot start a subsequent step', async () => {
  const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand; let finish;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Input.insertText') return await new Promise(resolve => { finish = resolve; });
    return send(target, method, args);
  };
  const result = await f.exec('batch', { timeout_ms: 100, steps: [
    { action: 'fill', selector: '#edit', text: 'once' }, { action: 'press_key', key: 'Enter' },
  ] });
  assert.equal(result.failed_step, 0); assert.match(result.error, /Outcome is unknown/);
  finish({}); await new Promise(resolve => setImmediate(resolve));
  assert.ok(!f.calls.some(c => c.method === 'Input.dispatchKeyEvent'));
  assert.ok((await f.exec('snapshot')).snapshot);
});

test('batch stops at navigation, detach, closure and dialogs instead of applying later selectors to a changed page', async () => {
  for (const change of ['navigation', 'detach', 'close', 'dialog']) {
    const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
    f.api.debugger.sendCommand = async (target, method, args) => {
      const result = await send(target, method, args);
      if (method === 'Input.insertText') {
        if (change === 'navigation') f.api.debugger.onEvent.emit(target, 'Page.frameNavigated', { frame: { id: 'main' } });
        if (change === 'detach') f.api.debugger.onDetach.emit(target);
        if (change === 'close') await f.api.tabs.remove(9);
        if (change === 'dialog') f.api.debugger.onEvent.emit(target, 'Page.javascriptDialogOpening', { type: 'alert', message: 'Stop' });
      }
      return result;
    };
    const result = await f.exec('batch', { steps: [{ action: 'fill', selector: '#edit', text: 'once' }, { action: 'press_key', key: 'Enter' }] });
    assert.equal(result.completed, false);
    assert.ok(!f.calls.some(c => c.method === 'Input.dispatchKeyEvent'));
  }
});

test('navigation retries transient observation once, never replays navigation or arbitrary observation failures', async () => {
  const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand; let reads = 0;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Accessibility.getFullAXTree' && ++reads === 1) throw new Error('Execution context was destroyed');
    return send(target, method, args);
  };
  const result = await f.exec('navigate', { url: 'http://localhost:8000/new' });
  assert.ok(result.snapshot); assert.equal(reads, 2);
  assert.equal(f.calls.filter(call => call.method === 'Page.navigate').length, 1);
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Accessibility.getFullAXTree') { reads++; throw new Error('Permission denied'); }
    return send(target, method, args);
  };
  assert.match((await f.exec('navigate', { url: 'http://localhost:8000/fail' })).observation_error, /Permission denied/);
  assert.equal(reads, 3);
});

test('evaluation cursor reads an immutable captured result without replay and expires on navigation', async () => {
  const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
  const page = vm.createContext({ runs: 0 });
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Runtime.evaluate' && args.awaitPromise) return { result: { value: await vm.runInContext(args.expression, page) } };
    return send(target, method, args);
  };
  let result = await f.exec('evaluate', { expression: '(runs++, ["one", "two", "three"])', max_chars: 8 });
  const items = [...result.value]; const oldCursor = result.next_cursor;
  assert.equal(result.capture_truncated, false);
  while (result.next_cursor) {
    result = await f.exec('evaluate', { cursor: result.next_cursor, max_chars: 10 });
    items.push(...result.value);
  }
  assert.equal(page.runs, 1); assert.deepEqual(items, ['one', 'two', 'three']);
  await assert.rejects(f.exec('evaluate', { cursor: oldCursor }), /stale/);
  const small = await f.exec('evaluate', { expression: '(runs++, 12345)', max_chars: 1 });
  assert.equal(small.required_chars, 5); assert.ok(small.next_cursor);
  assert.equal((await f.exec('evaluate', { cursor: small.next_cursor, max_chars: 5 })).value, 12345);
  assert.equal(page.runs, 2);
  const next = await f.exec('evaluate', { expression: '[1,2,3]', max_chars: 3 });
  await f.exec('navigate', { url: 'http://localhost:8000/new' });
  await assert.rejects(f.exec('evaluate', { cursor: next.next_cursor }), /stale/);
});

test('claim verifies title and URL before attaching; ownership is enforced', async () => {
  const f = fixture();
  await assert.rejects(f.exec('claim_tab', { expected_title: 'Wrong', expected_url: 'http://localhost:8000/' }), /changed/);
  assert.equal(f.calls.length, 0);
  await f.claim();
  await assert.rejects(f.exec('read_text', {}, 'two'), /not claimed/);
  assert.equal(f.controller.claimedCount(), 1);
});

test('AX backend identity survives consecutive inputs without another snapshot', async () => {
  const f = fixture(); await f.claim();
  const ref = f.ref(await f.exec('snapshot'));
  await f.exec('click', { ref });
  assert.equal(f.calls.filter(call => call.method === 'Input.dispatchMouseEvent').length, 3);
  await f.exec('click', { ref });
  assert.equal(f.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length, 1);
  assert.equal(f.calls.filter(call => call.method === 'Input.dispatchMouseEvent').length, 6);
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
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function describeHit')
    ? { result: { value: { tag: 'div', text: 'Loading overlay', clickable_hint: false } } } : send(target, method, args);
  const ref = f.ref(await f.exec('snapshot'));
  await assert.rejects(f.exec('click', { ref }), error => {
    assert.match(error.message, /covers.*hit_target=.*Loading overlay.*point=.*frame_id=.*No input was dispatched/);
    assert.equal(error.input_dispatched, false); assert.equal(error.post_action, undefined); return true;
  });
  const batch = await f.exec('batch', { steps: [{ action: 'click', selector: '#go' }] });
  assert.equal(batch.completed, false); assert.equal(batch.retry_failed_step_safe, true);
  assert.equal(f.calls.filter(call => call.method === 'Input.dispatchMouseEvent').length, 0);
});

test('coordinate actions are bounded by the viewport', async () => {
  const f = fixture(); await f.claim();
  await assert.rejects(f.exec('click', { x: -1, y: 0 }), /viewport/);
  await assert.rejects(f.exec('click', { x: 1024, y: 0 }), /viewport/);
  await f.exec('click', { x: 500, y: 300 });
  await f.exec('scroll', { delta_y: 300 });
});

test('scroll defaults to DOM; explicit wheel uses viewport coordinates and never substitutes DOM', async () => {
  const f = fixture(); await f.claim();
  const ref = f.ref(await f.exec('snapshot'));
  await f.exec('scroll', {delta_y:120});
  assert.ok(f.calls.some(call => call.method === 'Runtime.evaluate' && call.args.expression.includes('function scrollAtPoint')));
  assert.equal(f.calls.filter(call => call.method === 'Input.dispatchMouseEvent').length, 0);
  assert.equal((await f.exec('click', {ref})).target_verified, true);
  f.calls.length = 0;
  const result = await f.exec('scroll', {mode:'wheel',x:25,y:30,delta_x:-40,delta_y:120});
  const dispatch = f.calls.find(call => call.method === 'Input.dispatchMouseEvent');
  assert.deepEqual(dispatch.target, {tabId:9});
  assert.deepEqual(dispatch.args, {type:'mouseWheel',x:25,y:30,deltaX:-40,deltaY:120,button:'none',buttons:0,modifiers:0});
  assert.equal(result.method,'native_wheel'); assert.equal(result.application_result,'not_checked');
  assert.equal(result.scrolled, undefined);
  assert.ok(!f.calls.some(call => call.method === 'Runtime.evaluate' && call.args.expression.includes('function scrollAtPoint')));
  await assert.rejects(f.exec('scroll',{mode:'bad',delta_y:1}),/mode/);
  await assert.rejects(f.exec('scroll',{mode:'wheel',x:-1,delta_y:1}),/viewport/);
  await assert.rejects(f.exec('scroll',{mode:'wheel',delta_y:Infinity}),/finite/);
  assert.equal(f.calls.filter(call => call.method === 'Input.dispatchMouseEvent').length,1);
});

test('a stalled native wheel frees the queue, reports unknown outcome and never replays a late response', async () => {
  const f = fixture(); await f.claim();
  const send = f.api.debugger.sendCommand; let finish;
  f.api.debugger.sendCommand = (target,method,args) => {
    const result = send(target,method,args);
    if (method === 'Input.dispatchMouseEvent') return new Promise(resolve => { finish = () => resolve(result); });
    return result;
  };
  await assert.rejects(f.exec('scroll',{mode:'wheel',delta_y:100,timeout_ms:100}),/Outcome is unknown/);
  assert.ok((await f.exec('snapshot')).snapshot);
  finish(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.filter(call => call.method === 'Input.dispatchMouseEvent').length,1);
  assert.ok(!f.calls.some(call => call.method === 'Runtime.evaluate' && call.args.expression.includes('function scrollAtPoint')));
});

test('scroll search observes delayed matches and resumes after boundary growth without repeating unchanged scrolls', async () => {
  for (const grows of [false, true]) {
    const f = fixture(); await f.claim(); await f.exec('snapshot');
    const send = f.api.debugger.sendCommand;
    const initial = { x: 0, y: 0, width: 100, height: 100, client_width: 100, client_height: 100 };
    let scrolls = 0, boundaryAt;
    f.api.debugger.sendCommand = async (target, method, args) => {
      const result = await send(target, method, args);
      const loaded = boundaryAt != null && Date.now() - boundaryAt >= 200;
      if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function findScrollText'))
        return { result: loaded && (!grows || scrolls === 2) ? { objectId: 'found' } : { subtype: 'null' } };
      if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function scrollElement')) {
        scrolls++; boundaryAt ??= Date.now();
        return { result: { value: { scrolled: scrolls > 1, after: initial } } };
      }
      if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function scrollState'))
        return { result: { value: { ...initial, height: grows && loaded ? 200 : 100 } } };
      if (method === 'DOM.describeNode' && args.objectId === 'found') return { node: { nodeType: 1, backendNodeId: 12 } };
      return result;
    };
    const result = await f.exec('scroll', { selector: '#list', until: { text: 'Later' }, max_steps: 3, timeout_ms: 1500 });
    assert.equal(result.found, true); assert.ok(result.ref);
    assert.equal(result.scroll_steps, grows ? 2 : 1); assert.equal(scrolls, grows ? 2 : 1);
    assert.ok(!f.calls.some(c => c.method.startsWith('Input.')));
  }
});

test('scroll boundary timeout stays uncertain, sends no repeated scroll and leaves the queue usable', async () => {
  const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
  const after = { x: 0, y: 0, width: 100, height: 100, client_width: 100, client_height: 100 };
  let scrolls = 0;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function findScrollText')) return { result: { subtype: 'null' } };
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function scrollElement')) {
      scrolls++; return { result: { value: { scrolled: false, after } } };
    }
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function scrollState')) return { result: { value: after } };
    return result;
  };
  await assert.rejects(f.exec('scroll', { selector: '#list', until: { text: 'Missing' }, timeout_ms: 250 }), error => {
    assert.equal(error.post_action.delivery, 'unknown');
    assert.equal(error.post_action.assessment, 'no_observable_effects'); return true;
  });
  assert.equal(scrolls, 1); assert.ok((await f.exec('snapshot')).snapshot);
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

test('fill uses a resolved node and text input; raw CDP remains unavailable', async () => {
  const f = fixture(); await f.claim();
  const snapshot = await f.exec('snapshot');
  const ref = snapshot.snapshot.match(/\[([^\]]+)\] textbox/)[1];
  await f.exec('fill', { ref, text: '中文 hello' });
  assert.deepEqual(f.calls.find(call => call.method === 'Input.insertText').args, { text: '中文 hello' });
  await assert.rejects(f.exec('send_cdp', { method: 'Runtime.evaluate' }), /Unknown operation/);
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
  assert.equal((await f.exec('fill', { ref, text: 'again', mode: 'dom' })).value_verified, true);
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
  await assert.rejects(f.exec('click', { x: 5, y: 5, mode: 'dom' }), /ref or selector/);
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
  await assert.rejects(f.exec('press_key', { key: 'Z' }), /no verified receipt.*Outcome is unknown.*press Esc/);
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
  assert.ok(f.calls.some(call => call.method === 'tabGroups.update' && call.args.title === '' && call.args.color === 'red'));
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
  const snapshot = await f.exec('snapshot', { max_nodes: 3000, max_chars: 14000, verbose: true });
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.truncation_reason, 'text_budget');
  assert.ok(JSON.stringify(snapshot).length < 16000);
  let page = snapshot, count = snapshot.node_count;
  while (page.next_cursor) {
    page = await f.exec('snapshot', { cursor: page.next_cursor, max_nodes: 3000, max_chars: 14000, verbose: true });
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

test('interactive snapshot reduces round trips and keeps one immutable view across pages', async () => {
  const f = fixture(); await f.claim();
  const nodes = [{ nodeId: 'root', role: { value: 'RootWebArea' }, childIds: [] }];
  for (let i = 1; i <= 200; i++) {
    nodes[0].childIds.push(`p${i}`);
    nodes.push({ nodeId: `p${i}`, role: { value: 'paragraph' }, backendDOMNodeId: i, childIds: [`t${i}`] },
      { nodeId: `t${i}`, role: { value: 'StaticText' }, name: { value: 'Long prose '.repeat(25) } });
  }
  nodes[0].childIds.push('button', 'edit');
  nodes.push({ nodeId: 'button', backendDOMNodeId: 500, role: { value: 'button' }, name: { value: 'Go' } },
    { nodeId: 'edit', backendDOMNodeId: 501, role: { value: 'textbox' }, name: { value: 'Edit' } });
  f.nodes(nodes);
  const full = await f.exec('snapshot');
  assert.equal(full.truncated, true);
  const compact = await f.exec('snapshot', { profile: 'interactive' });
  assert.equal(compact.profile, 'interactive'); assert.equal(compact.text_limit, 80);
  assert.equal(compact.total_node_count, 3); assert.equal(compact.truncated, false);
  assert.ok(compact.snapshot.length < full.snapshot.length / 20);
  assert.doesNotMatch(compact.snapshot, /paragraph/);
  const ref = f.ref(compact);
  await f.exec('click', { ref, mode: 'dom' }); await f.exec('click', { ref, mode: 'dom' });
  await assert.rejects(f.exec('snapshot', { profile: 'typo' }), /profile/);
  await f.exec('click', { ref, mode: 'dom' });
  const first = await f.exec('snapshot', { profile: 'interactive', text: false, max_nodes: 1, verbose: true });
  await assert.rejects(f.exec('snapshot', { cursor: first.next_cursor, profile: 'full' }), /original profile/);
  const next = await f.exec('snapshot', { cursor: first.next_cursor, verbose: true });
  assert.equal(next.profile, 'interactive'); assert.equal(next.text, false);
  assert.equal(next.snapshot_id, first.snapshot_id); assert.equal(next.node_count, 2);
});

test('snapshot query starts a fresh observation, returns actionable refs and binds query pagination', async () => {
  const f = fixture(); await f.claim();
  const oldRef = f.ref(await f.exec('snapshot'));
  const found = await f.exec('snapshot', { query: 'sUbMiT', max_nodes: 1 });
  assert.equal(found.profile, 'full'); assert.equal(found.node_count, 1); assert.equal(found.total_node_count, 1);
  assert.match(found.snapshot, /Frame main.*\n.*button "Submit"/);
  assert.doesNotMatch(found.snapshot, /textbox|RootWebArea/);
  assert.equal(found.next_cursor, null); assert.equal(found.viewport, undefined); assert.equal(found.snapshot_id, undefined);
  await assert.rejects(f.exec('click', { ref: oldRef }), /stale/);
  const ref = f.ref(found);
  await f.exec('click', { ref });
  await assert.rejects(f.exec('snapshot', { query: '   ' }), /query/);
  await f.exec('click', { ref });
  const page = await f.exec('snapshot', { query: 'm', max_nodes: 1 });
  const reads = f.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length;
  await assert.rejects(f.exec('snapshot', { cursor: page.next_cursor, query: 'n' }), /original.*query/);
  const next = await f.exec('snapshot', { cursor: page.next_cursor, verbose: true });
  assert.equal(next.query, 'm'); assert.equal(next.node_count, 2); assert.equal(next.next_cursor, null);
  assert.ok(next.viewport.width); assert.equal(f.calls.filter(call => call.method === 'Accessibility.getFullAXTree').length, reads);
  f.nodes([{ nodeId: 'new', backendDOMNodeId: 12, role: { value: 'button' }, name: { value: 'New action' } }]);
  assert.match((await f.exec('snapshot', { query: 'new action' })).snapshot, /New action/);
  const empty = await f.exec('snapshot', { query: 'missing' });
  assert.equal(empty.snapshot, ''); assert.equal(empty.node_count, 0); assert.equal(empty.next_cursor, null);
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

test('direct upload retains backend refs; [] clears and file chooser state expires on navigation and release', async () => {
  const f = fixture(); await f.claim();
  const ref = f.ref(await f.exec('snapshot'));
  assert.equal((await f.exec('upload_file', { ref, files: [] })).cleared, true);
  assert.equal((await f.exec('upload_file', { ref, files: [] })).cleared, true);
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

test('continuously moving refs exhaust the actionability deadline without dispatch', async () => {
  const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
  let sample = 0;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function inspectTarget')) result.result.value.x = ++sample;
    return result;
  };
  await assert.rejects(f.exec('click', { ref: f.ref(await f.exec('snapshot')), timeout_ms: 100 }), /no input was dispatched/);
  assert.ok(sample > 1);
  assert.equal(f.calls.filter(call => call.method === 'Input.dispatchMouseEvent').length, 0);
});

test('evaluation runs once, awaits promises, bounds values, retains refs and enforces ownership', async () => {
  const f = fixture(); await f.claim();
  const ref = f.ref(await f.exec('snapshot'));
  const send = f.api.debugger.sendCommand;
  const page = vm.createContext({ runs: 0 });
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method !== 'Runtime.evaluate' || !args.awaitPromise) return send(target, method, args);
    f.calls.push({ method, args, target });
    try { return { result: { value: await vm.runInContext(args.expression, page) } }; }
    catch (error) { return { exceptionDetails: { text: error.message } }; }
  };
  assert.equal((await f.exec('evaluate', { expression: 'Promise.resolve(++runs)' })).value, 1);
  assert.equal(page.runs, 1);
  assert.equal((await f.exec('click', { ref })).target_verified, true);
  await assert.rejects(f.exec('evaluate', { expression: '++runs' }, 'two'), /not claimed/);
  assert.equal(page.runs, 1);
  await assert.rejects(f.exec('evaluate', { expression: '(()=>{runs++; throw new Error("fixture failure")})()' }), /effects may already.*fixture failure/);
  assert.equal(page.runs, 2);
  const special = await f.exec('evaluate', { expression: '({big: 42n, nan: NaN, negativeZero: -0, empty: undefined})' });
  assert.equal(special.value.big.$type, 'bigint');
  assert.equal(special.value.nan.value, 'NaN');
  assert.equal(special.value.negativeZero.value, '-0');
  assert.equal(special.value.empty.$type, 'undefined');
  assert.equal(f.calls.find(call => call.args?.awaitPromise).args.userGesture, false);
});

test('evaluation timeout and modal release the queue, leaving diagnostics available without replay', async () => {
  const f = fixture(); await f.claim();
  const send = f.api.debugger.sendCommand;
  let executions = 0;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method !== 'Runtime.evaluate' || !args.awaitPromise) return send(target, method, args);
    executions++;
    if (args.expression.includes('alert(')) f.api.debugger.onEvent.emit(target, 'Page.javascriptDialogOpening', { type: 'alert', message: 'eval modal' });
    return new Promise(() => {});
  };
  await assert.rejects(f.exec('evaluate', { expression: 'new Promise(()=>{})', timeout_ms: 100 }), /timed out.*Do not replay/);
  assert.equal(executions, 1);
  await f.exec('read_text');
  await assert.rejects(f.exec('evaluate', { expression: 'alert("fixture")' }), /JavaScript dialog/);
  assert.equal((await f.exec('snapshot')).dialog.message, 'eval modal');
  const emit = (method, params) => f.api.debugger.onEvent.emit({ tabId: 9 }, method, params);
  emit('Runtime.consoleAPICalled', { type: 'warn', args: [{ value: 'fixture warning' }], timestamp: Date.now() });
  assert.equal((await f.exec('logs', { kind: 'console' })).entries[0].text, 'fixture warning');
  await f.exec('logs', { kind: 'network' });
  await f.exec('handle_dialog', { accept: true });
  assert.equal(executions, 2);
});

test('diagnostics are enabled on claim, survive navigation, keep refs and clear on release', async () => {
  const f = fixture(); await f.claim();
  for (const method of ['Runtime.enable', 'Log.enable', 'Network.enable']) assert.ok(f.calls.some(call => call.method === method));
  const emit = (method, params) => f.api.debugger.onEvent.emit({ tabId: 9 }, method, params);
  emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'retained' }] });
  const ref = f.ref(await f.exec('snapshot'));
  assert.equal((await f.exec('logs', { kind: 'console' })).entries.length, 1);
  await f.exec('click', { ref });
  emit('Page.frameNavigated', { frame: { id: 'main' } });
  assert.equal((await f.exec('logs', { kind: 'console' })).entries[0].text, 'retained');
  await assert.rejects(f.exec('logs', { kind: 'console' }, 'two'), /not claimed/);
  await f.exec('release_tab'); await f.claim();
  assert.equal((await f.exec('logs', { kind: 'console' })).entries.length, 0);
});

test('evaluation serializer handles cycles, avoids getters and bounds traversal and escaped transfer size', () => {
  const cyclic = { name: 'root', get dangerous() { throw new Error('Getter must not run'); } };
  cyclic.self = cyclic;
  assert.equal(serializeEvaluation(cyclic, 2000).value.self.$type, 'circular_or_repeated');
  assert.equal(serializeEvaluation(cyclic, 2000).value.dangerous.$type, 'accessor');
  const huge = serializeEvaluation({ value: '\\'.repeat(100000) }, 1000);
  assert.equal(huge.truncated, true); assert.equal(huge.value.$type, 'truncated');
  assert.equal(huge.serialized_preview, undefined);
  const nodes = serializeEvaluation(Array.from({ length: 10000 }, () => ({})), 100000);
  assert.equal(nodes.truncated, true); assert.ok(nodes.value.length <= 1000);
  const deep = {}; let child = deep;
  for (let i = 0; i < 10000; i++) child = child.next = {};
  assert.equal(serializeEvaluation(deep, 1000).truncated, true);
  const sparse = []; sparse[1000000000] = 'end';
  const bounded = serializeEvaluation(sparse, 100000);
  assert.equal(bounded.truncated, true); assert.ok(bounded.value.length <= 1000);
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

test('39 seconds of navigation plus 7 seconds of observation fits the transport budget', async t => {
  const f = fixture(); await f.claim();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Page.navigate') await new Promise(resolve => setTimeout(resolve, 39000));
    if (method === 'Accessibility.getFullAXTree') await new Promise(resolve => setTimeout(resolve, 7000));
    return send(target, method, args);
  };
  const result = f.exec('navigate', { url: 'http://localhost:8000/slow', timeout_ms: 40000 });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(39000); await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(7000); await new Promise(resolve => setImmediate(resolve));
  assert.ok((await result).snapshot);
  assert.equal(f.controller.claimedCount(), 1);
});

test('a stalled post-navigation snapshot returns navigation success and never saves late refs', async t => {
  const f = fixture(); await f.claim();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const send = f.api.debugger.sendCommand;
  let finish;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Accessibility.getFullAXTree') await new Promise(resolve => { finish = resolve; });
    return send(target, method, args);
  };
  const result = f.exec('navigate', { url: 'http://localhost:8000/slow', timeout_ms: 40000 });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(10000); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await result).navigated_to, 'http://localhost:8000/slow');
  assert.match((await result).observation_error, /Navigation observation timed out/);
  finish(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.controller.claimedCount(), 1);
  assert.equal(f.calls.filter(call => call.method === 'Page.navigate').length, 1);
  await assert.rejects(f.exec('snapshot', { cursor: 'late@1' }), /stale/);
});

test('OOPIF trees omitted from root frame metadata still invalidate the full subtree', async () => {
  const f = fixture(); await f.claim();
  const emit = f.api.debugger.onEvent.emit, root = {tabId:9}, child = {tabId:9,sessionId:'s1'};
  emit(root, 'Target.attachedToTarget', {sessionId:'s1',targetInfo:{type:'iframe',targetId:'child'}});
  emit(child, 'Target.attachedToTarget', {sessionId:'s2',targetInfo:{type:'iframe',targetId:'nested'}});
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const frame = target.sessionId === 's1' ? 'child' : target.sessionId === 's2' ? 'nested' : 'main';
    if (method === 'Page.getFrameTree') return {frameTree:{frame:{id:frame,url:'https://fixture.test/'}}};
    if (method === 'Accessibility.getPartialAXTree') return {nodes:[{backendDOMNodeId:12,role:{value:'button'},name:{value:frame}}]};
    if (method === 'Accessibility.getFullAXTree') return {nodes:[
      {nodeId:'button',backendDOMNodeId:12,role:{value:'button'},name:{value:frame}},
      ...(frame !== 'nested' ? [{nodeId:'iframe',backendDOMNodeId:14,role:{value:'Iframe'}}] : []),
    ]};
    if (method === 'DOM.describeNode' && args.backendNodeId === 14) return {node:{frameId:frame === 'main' ? 'child':'nested'}};
    return send(target,method,args);
  };
  const snap = await f.exec('snapshot');
  const ref = frame => snap.snapshot.split('\n').find(line => line.includes(`button "${frame}"`)).match(/\[([^\]]+)\]/)[1];
  assert.equal(snap.omitted_frames.length,0);
  emit(child,'Page.fileChooserOpened',{backendNodeId:77,frameId:'nested'});
  emit(child,'Page.frameNavigated',{frame:{id:'child'}});
  await assert.rejects(f.exec('click',{ref:ref('child')}),/stale/);
  await assert.rejects(f.exec('click',{ref:ref('nested')}),/stale/);
  assert.equal((await f.exec('click',{ref:ref('main')})).target_verified,true);
  await assert.rejects(f.exec('upload_file',{files:[]}),/No pending/);
});


test('hover uses the same hit checks but dispatches only one native move and preserves refs', async () => {
  const f = fixture(); await f.claim(); const ref = f.ref(await f.exec('snapshot'));
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Input.dispatchMouseEvent' && args.type === 'mouseMoved') {
      const binding = f.calls.findLast(c => c.method === 'Runtime.addBinding').args.name;
      f.api.debugger.onEvent.emit(target, 'Runtime.bindingCalled', { name: binding, executionContextId: 42, payload: '{"matched":true}' });
    }
    return result;
  };
  assert.equal((await f.exec('hover', { ref })).events_trusted, true);
  assert.deepEqual(f.calls.filter(c => c.method === 'Input.dispatchMouseEvent').map(c => c.args.type), ['mouseMoved']);
  assert.equal((await f.exec('click', { ref })).target_verified, true);
  assert.equal(f.calls.filter(c => c.method === 'Accessibility.getFullAXTree').length, 1);
});

test('native select hits fail before dispatch and lost receipts free a long-budget queue within two seconds', async () => {
  const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function describeHit')) return { result: { value: { native_select: true } } };
    return send(target, method, args);
  };
  await assert.rejects(f.exec('click', { selector: 'select', timeout_ms: 30000 }), /No input was dispatched.*browser_select_option/);
  assert.ok(!f.calls.some(c => c.method.startsWith('Input.')));
  f.api.debugger.sendCommand = send;
  const emit = f.api.debugger.onEvent.emit;
  f.api.debugger.onEvent.emit = (...args) => { if (args[1] !== 'Runtime.bindingCalled') emit(...args); };
  const start = Date.now();
  await assert.rejects(f.exec('click', { x: 10, y: 10, timeout_ms: 30000 }), /Outcome is unknown.*press Esc/);
  assert.ok(Date.now() - start < 2000);
  assert.equal(f.calls.filter(c => c.method === 'Input.dispatchMouseEvent').length, 3);
  assert.ok((await f.exec('snapshot')).snapshot);
});


test('native drag keeps ordering, includes all requested moves and releases only once', async () => {
  const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function installDragReceipt')) return { result: { objectId: 'drag-guard' } };
    if (method === 'Input.dispatchMouseEvent') {
      const binding = f.calls.findLast(c => c.method === 'Runtime.addBinding')?.args.name;
      const type = { mousePressed: 'pointerdown', mouseReleased: 'pointerup', mouseMoved: 'pointermove' }[args.type];
      f.api.debugger.onEvent.emit(target, 'Runtime.bindingCalled', { name: binding, executionContextId: 42, payload: JSON.stringify({ type }) });
    }
    return result;
  };
  const result = await f.exec('drag', { source: { selector: '#source' }, destination: { selector: '#destination' }, steps: 5 });
  assert.equal(result.delivery_verified, true);
  const events = f.calls.filter(c => c.method === 'Input.dispatchMouseEvent').map(c => c.args.type);
  assert.deepEqual(events, ['mouseMoved', 'mousePressed', ...Array(6).fill('mouseMoved'), 'mouseReleased']);
  assert.equal(f.calls.filter(c => c.method === 'DOM.scrollIntoViewIfNeeded').length, 2);
  assert.ok(!f.calls.some(c => c.method === 'Input.dispatchDragEvent'));
});

test('optional click offset uses the verified hit point; settle timeout cannot dispatch late input', async () => {
  const f = fixture(); await f.claim();
  const result = await f.exec('click', { selector: '#go', offset: { x_ratio: .25, y_ratio: .75 }, settle_ms: [1, 1] });
  assert.deepEqual(result.clicked, { x: 32.5, y: 40 });
  assert.equal(result.target_verified, true);
  const events = f.calls.filter(c => c.method === 'Input.dispatchMouseEvent');
  assert.equal(events.length, 3);
  assert.ok(events.every(c => c.args.x === 32.5 && c.args.y === 40));
  f.calls.length = 0;
  await assert.rejects(f.exec('click', { x: 10, y: 10, settle_ms: 200, timeout_ms: 100 }), /no input was dispatched/);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.ok(!f.calls.some(c => c.method.startsWith('Input.')));
});

test('detach during an optional settle cancels the pending click before dispatch', async () => {
  const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function installGuard')) {
      setTimeout(() => f.api.debugger.onDetach.emit({ tabId: 9 }), 10);
    }
    return result;
  };
  await assert.rejects(f.exec('click', { x: 10, y: 10, settle_ms: 80 }), /detached during click/);
  assert.ok(!f.calls.some(c => c.method.startsWith('Input.')));
});

test('optional drag trajectory reaches the requested point and a timeout releases without resuming moves', async () => {
  for (const timeout of [false, true]) {
    const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
    f.api.debugger.sendCommand = async (target, method, args) => {
      const result = await send(target, method, args);
      if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function installDragReceipt')) return { result: { objectId: 'drag-guard' } };
      if (method === 'Input.dispatchMouseEvent') {
        const binding = f.calls.findLast(c => c.method === 'Runtime.addBinding')?.args.name;
        f.api.debugger.onEvent.emit(target, 'Runtime.bindingCalled', { name: binding, executionContextId: 42,
          payload: JSON.stringify({ type: { mousePressed: 'pointerdown', mouseReleased: 'pointerup', mouseMoved: 'pointermove' }[args.type] }) });
      }
      return result;
    };
    const operation = f.exec('drag', { source: { x: 50, y: 50 }, destination: { x: 200, y: 50 }, steps: 8,
      trajectory: { curve_px: 12, duration_ms: timeout ? 600 : 100 }, timeout_ms: timeout ? 150 : 5000 });
    if (timeout) await assert.rejects(operation, /Outcome is unknown/);
    else assert.deepEqual((await operation).to, { x: 200, y: 50 });
    const events = f.calls.filter(c => c.method === 'Input.dispatchMouseEvent').map(c => c.args);
    assert.equal(events.filter(e => e.type === 'mouseReleased').length, 1);
    assert.equal(events.at(-1).type, 'mouseReleased');
    assert.ok(events.some(e => e.type === 'mouseMoved' && e.y > 50));
    const count = events.length;
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(f.calls.filter(c => c.method === 'Input.dispatchMouseEvent').length, count);
  }
});

test('document drag endpoints share a viewport and preserve both coordinate deltas before dispatch', async () => {
  for (const [a, b, initial] of [
    [{x:200,y:1000},{x:200,y:1200},{x:0,y:0}],
    [{x:200,y:1200},{x:200,y:1000},{x:0,y:0}],
    [{x:1400,y:200},{x:1600,y:200},{x:0,y:0}],
    [{x:1600,y:1200},{x:1400,y:1000},{x:1300,y:900}],
  ]) {
    const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
    let scroll = initial;
    f.api.debugger.sendCommand = async (target, method, args) => {
      const result = await send(target, method, args);
      if (method === 'Runtime.evaluate' && args.expression.startsWith('scrollTo(')) {
        const [,x,y] = args.expression.match(/left:([^,]+),top:([^,]+)/);
        scroll = {x:Number(x),y:Number(y)};
      }
      if (method === 'Runtime.evaluate' && args.expression.includes('scroll_x: scrollX'))
        result.result.value = {...result.result.value,scroll_x:scroll.x,scroll_y:scroll.y};
      if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function installDragReceipt')) return {result:{objectId:'drag-guard'}};
      if (method === 'Input.dispatchMouseEvent') {
        const binding = f.calls.findLast(c=>c.method==='Runtime.addBinding')?.args.name;
        const type = {mousePressed:'pointerdown',mouseReleased:'pointerup',mouseMoved:'pointermove'}[args.type];
        f.api.debugger.onEvent.emit(target,'Runtime.bindingCalled',{name:binding,executionContextId:42,payload:JSON.stringify({type})});
      }
      return result;
    };
    const result = await f.exec('drag',{source:{...a,coordinate_space:'document'},destination:{...b,coordinate_space:'document'},steps:3});
    assert.equal(result.to.x-result.from.x,b.x-a.x); assert.equal(result.to.y-result.from.y,b.y-a.y);
    const inputAt = f.calls.findIndex(c=>c.method==='Input.dispatchMouseEvent');
    assert.ok(!f.calls.slice(inputAt).some(c=>c.args?.expression?.startsWith('scrollTo(')));
    assert.ok(f.calls.filter(c=>c.args?.expression?.startsWith('scrollTo(')).length<=1);
    const down = f.calls.find(c=>c.method==='Input.dispatchMouseEvent'&&c.args.type==='mousePressed').args;
    const up = f.calls.find(c=>c.method==='Input.dispatchMouseEvent'&&c.args.type==='mouseReleased').args;
    assert.equal(up.y-down.y,b.y-a.y); assert.equal(up.x-down.x,b.x-a.x);
    await assert.rejects(f.exec('drag',{source:{x:-1,y:100,coordinate_space:'document'},destination:{x:20,y:100,coordinate_space:'document'}}),/nonnegative/);
  }
});

test('document click preserves an already visible point and scrolls only the axis that needs it', async () => {
  for (const [x,y,expected] of [[300,400,0],[300,1500,1]]) {
    const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand; let scrolled = false;
    f.api.debugger.sendCommand = async (target,method,args)=>{
      const result=await send(target,method,args);
      if(method==='Runtime.evaluate'&&args.expression.startsWith('scrollTo('))scrolled=true;
      if(method==='Runtime.evaluate'&&args.expression.includes('scroll_x: scrollX'))
        result.result.value={...result.result.value,scroll_x:250,scroll_y:scrolled?1200:350};
      return result;
    };
    const result=await f.exec('click',{x,y,coordinate_space:'document'});
    assert.equal(result.clicked.x,50); assert.equal(result.clicked.y,expected?300:50);
    const scrolls=f.calls.filter(c=>c.args?.expression?.startsWith('scrollTo('));
    assert.equal(scrolls.length,expected); if(expected)assert.match(scrolls[0].args.expression,/left:250,/);
  }
});

test('an HTML5 drag without interception never invents payload or switches modes and cleans up', async () => {
  const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function installDragReceipt')
    ? { result: { objectId: 'drag-guard' } } : send(target, method, args);
  await assert.rejects(f.exec('drag', { source: { selector: '#source' }, destination: { selector: '#destination' }, mode: 'html5', timeout_ms: 300 }), /Outcome is unknown/);
  assert.ok(f.calls.some(c => c.method === 'Input.cancelDragging'));
  assert.deepEqual(f.calls.filter(c => c.method === 'Input.setInterceptDrags').map(c => c.args.enabled), [true, false]);
  assert.equal(f.calls.filter(c => c.method === 'Input.dispatchMouseEvent' && c.args.type === 'mouseReleased').length, 1);
  assert.ok(!f.calls.some(c => c.method === 'Input.dispatchDragEvent'));
  assert.ok((await f.exec('snapshot')).snapshot);
});

test('drag stops after document change and does not resolve or act on a new destination', async () => {
  const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function installDragReceipt')) return { result: { objectId: 'drag-guard' } };
    const result = await send(target, method, args);
    if (method === 'Input.dispatchMouseEvent' && args.type === 'mousePressed') f.api.debugger.onEvent.emit(target, 'DOM.documentUpdated');
    return result;
  };
  await assert.rejects(f.exec('drag', { source: { selector: '#source' }, destination: { selector: '#destination' } }), /changed during drag|document.frame changed/);
  assert.ok(!f.calls.some(c => c.args?.expression?.includes('("#destination"')));
  assert.equal(f.calls.filter(c => c.method === 'Input.dispatchMouseEvent' && c.args.type === 'mouseReleased').length, 1);
});


test('a retained backend node repurposed with a different AX name is refused without guessing a replacement', async () => {
  const f = fixture();await f.claim();const ref=f.ref(await f.exec('snapshot'));
  const send=f.api.debugger.sendCommand;
  f.api.debugger.sendCommand=async (target,method,args)=> method==='Accessibility.getPartialAXTree'
    ? {nodes:[{backendDOMNodeId:12,role:{value:'button'},name:{value:'Different action'}}]} : send(target,method,args);
  await assert.rejects(f.exec('click',{ref}),/ref identity changed.*No input was dispatched/);
  assert.ok(!f.calls.some(c=>c.method.startsWith('Input.')));
});


test('type appends with native character keyDown text and keyUp, never insertText or a DOM fill setter', async () => {
  const f=fixture();await f.claim();
  const result=await f.exec('type',{selector:'#edit',text:'A中+',delay_ms:1});
  assert.equal(result.typed,3);assert.equal(result.events_trusted,true);
  const events=f.calls.filter(c=>c.method==='Input.dispatchKeyEvent').map(c=>c.args);
  assert.deepEqual(events.map(e=>e.type),['keyDown','keyUp','keyDown','keyUp','keyDown','keyUp']);
  assert.deepEqual(events.filter(e=>e.type==='keyDown').map(e=>e.text),['A','中','+']);
  assert.ok(!f.calls.some(c=>c.method==='Input.insertText'||c.args?.functionDeclaration?.includes('function prepareFill')));
});

test('batch uses a child timeout for wait and resumes explicitly without replaying completed steps', async () => {
  const f=fixture();await f.claim();const send=f.api.debugger.sendCommand;
  f.api.debugger.sendCommand=async(target,method,args)=> method==='Runtime.evaluate'&&args.expression.includes('function inspectWait')
    ? {result:{value:{satisfied:false,state:'absent'}}} : send(target,method,args);
  const steps=[{action:'click',selector:'#first'},{action:'wait',selector:'#later',condition:'visible',timeout_ms:100},{action:'click',selector:'#last'}];
  const failed=await f.exec('batch',{steps,timeout_ms:5000});
  assert.equal(failed.failed_step,1);assert.equal(failed.retry_failed_step_safe,true);
  assert.equal(f.calls.filter(c=>c.method==='Input.dispatchMouseEvent'&&c.args.type==='mousePressed').length,1);
  const resumed=await f.exec('batch',{steps,start_at:2});assert.equal(resumed.completed,true);
  assert.equal(f.calls.filter(c=>c.method==='Input.dispatchMouseEvent'&&c.args.type==='mousePressed').length,2);
});

test('explicit dialog policy handles alerts and permits subsequent batch steps; ask still stops', async () => {
  const f=fixture();await f.claim();f.modal();const send=f.api.debugger.sendCommand;
  f.api.debugger.sendCommand=async(target,method,args)=>{
    if(method==='Page.handleJavaScriptDialog') {f.api.debugger.onEvent.emit(target,'Page.javascriptDialogClosed');return {};}
    const result=send(target,method,args);
    if(method==='Input.dispatchMouseEvent'&&args.type==='mouseReleased') {
      const binding=f.calls.findLast(c=>c.method==='Runtime.addBinding')?.args.name;
      f.api.debugger.onEvent.emit(target,'Runtime.bindingCalled',{name:binding,executionContextId:42,payload:'{"matched":true}'});
      return {};
    }
    return result;
  };
  const result=await f.exec('batch',{dialog_policy:'accept',steps:[{action:'click',selector:'#alert'},{action:'click',selector:'#next'}]});
  assert.equal(result.completed,true);assert.equal(result.dialogs.length,2);assert.ok(result.dialogs.every(d=>d.accepted&&d.handled));
});

test('element capture uses its box and retains the document offset instead of full-page origin', async () => {
  const f=fixture();await f.claim();const send=f.api.debugger.sendCommand;
  f.api.debugger.sendCommand=async(target,method,args)=>{
    if(method==='DOM.getBoxModel')return {model:{border:[10,20,110,20,110,60,10,60]}};
    const result=await send(target,method,args);
    if(method==='Runtime.evaluate'&&args.expression.includes('scroll_x: scrollX'))result.result.value.scroll_y=100;
    return result;
  };
  const result=await f.exec('screenshot',{selector:'#box'});
  assert.equal(result.capture.scope,'element');assert.deepEqual(result.capture.image_origin_css,{x:10,y:120});assert.equal(result.capture.css_width,100);
  await assert.rejects(f.exec('screenshot',{selector:'#box',full_page:true}),/mutually exclusive/);
});


function fetchFixture() {
  const f = fixture(), send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Page.navigate') {
      const result = await send(target, method, args);
      f.api.debugger.onEvent.emit(target, 'Network.responseReceived', { requestId: 'document', type: 'Document', frameId: 'main', loaderId: 'new', response: { status: 200, url: args.url } });
      f.api.debugger.onEvent.emit(target, 'Page.frameNavigated', { frame: { id: 'main', loaderId: 'new', url: args.url } });
      return result;
    }
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: 'new', url: f.tabs.get(target.tabId).url } } };
    if (method === 'Runtime.evaluate' && args.expression.startsWith('(function capturePage')) {
      f.calls.push({ method: 'capture', target, args });
      return { result: { value: { url: f.tabs.get(target.tabId).url, title: 'Fetched', contentType: 'text/html', body: 'abcdef', ready_state: 'complete', body_source: 'rendered_document', capture_truncated: false } } };
    }
    return send(target, method, args);
  };
  return f;
}

test('fetch opens one background tab, navigates once, closes before paginating and keeps existing claims', async () => {
  const f = fetchFixture(); await f.claim();
  const page = await f.exec('fetch', { url: 'https://read.test/', max_chars: 2 });
  assert.equal(page.body, 'ab'); assert.equal(page.truncated, true);
  assert.equal(page.status, 200); assert.equal(page.ok, true);
  assert.equal(page.wait_satisfied, true); assert.equal(page.degraded, false); assert.equal(page.ready_state, 'complete');
  assert.deepEqual(f.calls.find(c => c.method === 'tabs.create').args, { url: 'about:blank', active: false });
  assert.ok(!f.tabs.has(10)); assert.ok(f.tabs.has(9)); assert.equal(f.controller.claimedCount(), 1);
  const before = f.calls.length;
  const next = await f.exec('fetch', { cursor: page.next_cursor });
  assert.equal(next.body, 'cdef'); assert.equal(next.next_cursor, null);
  assert.equal(f.calls.length, before);
  assert.equal(f.calls.filter(c => c.method === 'Page.navigate').length, 1);
  assert.ok(!f.calls.some(c => ['Page.bringToFront', 'tabs.update', 'windows.update'].includes(c.method)));
  await assert.rejects(f.exec('fetch', { cursor: page.next_cursor }, 'other'), /stale|another connection/);
});

test('fetch cleans up attach failure, navigation failure, timeout, capture errors and document races without replay', async () => {
  for (const failure of ['attach', 'Page.navigate', 'timeout', 'capture', 'document', 'detach']) {
    const f = fetchFixture(), send = f.api.debugger.sendCommand;
    if (failure === 'attach') f.api.debugger.attach = async () => { throw new Error('attach failed'); };
    f.api.debugger.sendCommand = async (target, method, args) => {
      if (method === 'Page.navigate' && failure === 'Page.navigate') throw new Error('navigation failed');
      if (method === 'Page.navigate' && failure === 'timeout') { f.calls.push({ method }); return new Promise(() => {}); }
      if (method === 'Runtime.evaluate' && args.expression.startsWith('(function capturePage')) {
        if (failure === 'capture') return { exceptionDetails: { text: 'invalid JSON' } };
        if (failure === 'document') f.api.debugger.onEvent.emit(target, 'DOM.documentUpdated');
        if (failure === 'detach') f.api.debugger.onDetach.emit(target);
      }
      return send(target, method, args);
    };
    await assert.rejects(f.exec('fetch', { url: 'https://read.test/', timeout_ms: 100 }));
    assert.ok(!f.tabs.has(10), failure); assert.equal(f.controller.claimedCount(), 0);
    assert.ok(f.calls.filter(c => c.method === 'Page.navigate').length <= 1);
  }
});

test('failed fetch close retains ownership until disconnect cleanup closes the temporary tab', async () => {
  const f = fetchFixture(), remove = f.api.tabs.remove;
  f.api.tabs.remove = async () => { throw new Error('close failed'); };
  await assert.rejects(f.exec('fetch', { url: 'https://read.test/' }), /could not be closed/);
  assert.equal(f.controller.claimedCount(), 1);
  assert.ok(!(await f.exec('list_tabs')).tabs.some(t => t.tab_id === 10));
  await assert.rejects(f.exec('claim_tab', { tab_id: 10 }, 'other'), /already controlled/);
  f.api.tabs.remove = remove;
  await f.exec('release_owner');
  assert.equal(f.controller.claimedCount(), 0); assert.ok(!f.tabs.has(10));
});

test('disconnect clears fetch captures and discards in-flight captures after closing', async () => {
  const f = fetchFixture(), send = f.api.debugger.sendCommand;
  let finish, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Runtime.evaluate' && args.expression.startsWith('(function capturePage')) {
      entered(); await new Promise(resolve => { finish = resolve; });
    }
    return send(target, method, args);
  };
  const pending = assert.rejects(f.exec('fetch', { url: 'https://read.test/' }), /connection ended/);
  await waiting;
  const release = f.exec('release_owner');
  finish(); await pending; await release;
  assert.ok(!f.tabs.has(10)); assert.equal(f.controller.claimedCount(), 0);
});


test('fetch initialization deadline closes its tab and late replies cannot resume setup or navigate', async () => {
  for (const stage of ['attach', 'Runtime.enable', 'Page.getFrameTree']) {
    const f = fetchFixture(), send = f.api.debugger.sendCommand;
    let finish;
    const stalled = () => new Promise(resolve => { finish = resolve; });
    if (stage === 'attach') f.api.debugger.attach = stalled;
    else f.api.debugger.sendCommand = async (target, method, args) => method === stage ? stalled() : send(target, method, args);
    await assert.rejects(f.exec('fetch', { url: 'https://read.test/', timeout_ms: 100 }), /Fetch did not finish/);
    assert.ok(!f.tabs.has(10));
    finish(stage === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'main' } } } : {});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.controller.claimedCount(), 0);
    assert.ok(!f.calls.some(c => c.method === 'Page.navigate'));
  }
});


test('disconnect during tab creation or initialization cannot dispatch a late navigation', async () => {
  for (const stage of ['create', 'initialize']) {
    const f = fetchFixture(), create = f.api.tabs.create, send = f.api.debugger.sendCommand;
    let finish, entered;
    const ready = new Promise(resolve => { entered = resolve; });
    if (stage === 'create') f.api.tabs.create = async args => { entered(); await new Promise(resolve => { finish = resolve; }); return create(args); };
    else f.api.debugger.sendCommand = async (target, method, args) => {
      if (method === 'Runtime.enable') { entered(); await new Promise(resolve => { finish = resolve; }); }
      return send(target, method, args);
    };
    const pending = assert.rejects(f.exec('fetch', { url: 'https://read.test/' }), /connection ended/);
    await ready;
    const released = f.exec('release_owner');
    finish(); await pending; await released;
    assert.ok(!f.tabs.has(10)); assert.equal(f.controller.claimedCount(), 0);
    assert.ok(!f.calls.some(c => c.method === 'Page.navigate'));
  }
});


test('fetch returns only the captured main document HTTP status, without treating HTTP errors as tool errors', async () => {
  for (const status of [200, 404, 500, null]) {
    const f = fetchFixture(), send = f.api.debugger.sendCommand;
    f.api.debugger.sendCommand = async (target, method, args) => {
      const result = await send(target, method, args);
      if (method === 'Page.navigate') {
        if (status == null) f.api.debugger.onEvent.emit(target, 'Network.requestWillBeSent', { requestId: 'unobserved', type: 'Document', frameId: 'main', request: { url: args.url, method: 'GET' } });
        else f.api.debugger.onEvent.emit(target, 'Network.responseReceived', { requestId: 'document', type: 'Document', frameId: 'main', loaderId: 'new', response: { status, url: args.url } });
        f.api.debugger.onEvent.emit(target, 'Network.responseReceived', { requestId: 'iframe', type: 'Document', frameId: 'child', loaderId: 'new', response: { status: 403, url: 'https://other.test/' } });
      }
      return result;
    };
    const result = await f.exec('fetch', { url: 'https://read.test/' });
    assert.equal(result.status, status); assert.equal(result.ok, status == null ? null : status === 200);
    assert.equal(result.body, 'abcdef'); assert.ok(!f.tabs.has(10));
  }
});


test('fetch respects commit/DOMContentLoaded and degrades an unmet load without navigating again', async () => {
  for (const wait_until of ['commit', 'domcontentloaded', 'load']) {
    const f = fetchFixture(), send = f.api.debugger.sendCommand;
    f.api.debugger.sendCommand = async (target, method, args) => {
      if (method === 'Page.navigate') {
        f.calls.push({ method, args }); f.tabs.get(10).url = args.url;
        f.api.debugger.onEvent.emit(target, 'Network.responseReceived', { requestId: 'r', type: 'Document', frameId: 'main', loaderId: 'new', response: { status: 200, url: args.url } });
        f.api.debugger.onEvent.emit(target, 'Page.frameNavigated', { frame: { id: 'main', loaderId: 'new', url: args.url } });
        f.api.debugger.onEvent.emit(target, 'Page.lifecycleEvent', { frameId: 'main', loaderId: 'new', name: 'DOMContentLoaded' });
        return { frameId: 'main', loaderId: 'new' };
      }
      const result = await send(target, method, args);
      if (method === 'Runtime.evaluate' && args.expression.startsWith('(function capturePage')) result.result.value.ready_state = 'interactive';
      return result;
    };
    const started = Date.now(), result = await f.exec('fetch', { url: 'https://read.test/', wait_until, timeout_ms: 600 });
    assert.equal(result.body, 'abcdef'); assert.equal(result.status, 200); assert.equal(result.ready_state, 'interactive');
    assert.equal(result.wait_satisfied, wait_until !== 'load'); assert.equal(result.degraded, wait_until === 'load');
    assert.equal(result.degraded_reason, wait_until === 'load' ? 'wait_timeout' : null);
    assert.equal(result.document_changed, false); assert.ok(Date.now() - started < 750);
    assert.equal(f.calls.filter(c => c.method === 'Page.navigate').length, 1); assert.ok(!f.tabs.has(10));
  }
});

test('fetch retries only the read on a document swap and pairs new body with new response metadata', async () => {
  const f = fetchFixture(), send = f.api.debugger.sendCommand;
  let captures = 0, changed = false;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Page.getFrameTree' && changed) return { frameTree: { frame: { id: 'main', loaderId: 'final', url: 'https://read.test/final' } } };
    const result = await send(target, method, args);
    if (method === 'Runtime.evaluate' && args.expression.startsWith('(function capturePage')) {
      captures++;
      if (!changed) {
        changed = true; f.tabs.get(10).url = 'https://read.test/final';
        f.api.debugger.onEvent.emit(target, 'Page.frameNavigated', { frame: { id: 'main', loaderId: 'final', url: 'https://read.test/final' } });
        f.api.debugger.onEvent.emit(target, 'Network.responseReceived', { requestId: 'final', type: 'Document', frameId: 'main', loaderId: 'final', response: { status: 201, url: 'https://read.test/final' } });
      } else result.result.value.body = 'final document';
    }
    return result;
  };
  const result = await f.exec('fetch', { url: 'https://read.test/', timeout_ms: 600 });
  assert.equal(captures, 2); assert.equal(result.url, 'https://read.test/final'); assert.equal(result.body, 'final document');
  assert.equal(result.status, 201); assert.equal(result.document_changed, true);
  assert.equal(result.degraded, true); assert.equal(result.degraded_reason, 'document_changed');
  assert.equal(f.calls.filter(c => c.method === 'Page.navigate').length, 1);
});

test('fetch returns confirmed empty HTTP errors and distinguishes unavailable bodies from network failures', async () => {
  for (const [status, empty] of [[418, true], [500, true], [503, true], [503, false]]) {
    const f = fetchFixture(), send = f.api.debugger.sendCommand;
    f.api.debugger.sendCommand = async (target, method, args) => {
      if (method === 'Page.navigate') {
        f.calls.push({ method });
        f.api.debugger.onEvent.emit(target, 'Network.responseReceived', { requestId: 'failed', type: 'Document', frameId: 'main', loaderId: 'failed', response: { status, url: args.url, mimeType: 'text/html', headers: empty ? { 'Content-Length': '0' } : {} } });
        f.api.debugger.onEvent.emit(target, 'Network.loadingFailed', { requestId: 'failed', errorText: 'net::ERR_HTTP_RESPONSE_CODE_FAILURE' });
        return { frameId: 'main', errorText: 'net::ERR_HTTP_RESPONSE_CODE_FAILURE' };
      }
      return send(target, method, args);
    };
    const result = await f.exec('fetch', { url: 'https://read.test/error' });
    assert.equal(result.status, status); assert.equal(result.ok, false); assert.equal(result.body, '');
    assert.equal(result.ready_state, null); assert.equal(result.body_source, empty ? 'http_response' : 'unavailable');
    assert.equal(result.body_unavailable, empty ? undefined : true); assert.equal(result.degraded_reason, 'http_error_response');
    assert.ok(!f.calls.some(c => c.method === 'capture')); assert.ok(!f.tabs.has(10));
  }
  const f = fetchFixture(), send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => method === 'Page.navigate' ? { errorText: 'net::ERR_NAME_NOT_RESOLVED' } : send(target, method, args);
  await assert.rejects(f.exec('fetch', { url: 'https://read.test/' }), /ERR_NAME_NOT_RESOLVED/);
});

test('fetch bounds creation and close; late completion cleans up without any late navigation', async () => {
  const f = fetchFixture(), create = f.api.tabs.create;
  let finish;
  f.api.tabs.create = async args => { await new Promise(resolve => { finish = resolve; }); return create(args); };
  await assert.rejects(f.exec('fetch', { url: 'https://read.test/', timeout_ms: 100 }), /Fetch did not finish/);
  finish(); await new Promise(resolve => setImmediate(resolve));
  assert.ok(!f.tabs.has(10)); assert.ok(!f.calls.some(c => c.method === 'Page.navigate'));
  const g = fetchFixture(), remove = g.api.tabs.remove;
  g.api.tabs.remove = async id => { await new Promise(resolve => { finish = resolve; }); return remove(id); };
  const started = Date.now();
  await assert.rejects(g.exec('fetch', { url: 'https://read.test/', timeout_ms: 200 }), /could not be closed/);
  assert.ok(Date.now() - started < 350); assert.equal(g.controller.claimedCount(), 1);
  finish(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(g.controller.claimedCount(), 0); assert.ok(!g.tabs.has(10));
});
