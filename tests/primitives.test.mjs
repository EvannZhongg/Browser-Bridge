import test from 'node:test';
import assert from 'node:assert/strict';
import { selectElement, selectOptions } from '../extension/input.js';
import { waitFor, inspectWait, waitOptions } from '../extension/wait.js';
import { createDiagnostics } from '../extension/diagnostics.js';

function selectFixture() {
  const events = [];
  class Select {
    set selectedIndex(index) { this.index = index; this.options.forEach((o, i) => { o.selected = i === index; }); }
    get selectedIndex() { return this.index; }
  }
  const field = new Select();
  Object.assign(field, { tagName: 'SELECT', isConnected: true, matches: () => false, closest: () => null,
    options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }, { value: 'c', label: 'Beta' }],
    ownerDocument: { defaultView: { HTMLSelectElement: Select, Event: class { constructor(type) { this.type = type; this.isTrusted = false; } } } },
    dispatchEvent: event => events.push(event),
  });
  return { field, events };
}

test('select matches exact label/value/index, rejects ambiguity/disabled options and reports retained selection', () => {
  const { field, events } = selectFixture();
  assert.equal(selectElement.call(field, { label: 'Alpha' }).value_verified, true);
  assert.equal(selectElement.call(field, { value: 'b' }).index, 1);
  assert.throws(() => selectElement.call(field, { label: 'Beta' }), /matched 2/);
  field.options[2].disabled = true;
  assert.throws(() => selectElement.call(field, { index: 2 }), /disabled/);
  assert.equal(events.length, 4);assert.ok(events.every(e => e.isTrusted === false));
  field.dispatchEvent = () => { field.selectedIndex = 0; };
  assert.throws(() => selectElement.call(field, { value: 'b' }), /did not retain.*unknown/);
  for (const args of [{}, { value: 'a', index: 0 }, { index: -1 }]) assert.throws(() => selectOptions(args));
});

test('wait failures include the requested condition and the last absent/hidden/disabled state', async () => {
  const sessions = { frames: async () => [{ id: 'main' }], target: () => ({ tabId: 1 }) };
  for (const [condition, state] of [['attached', 'absent'], ['visible', 'hidden'], ['actionable', 'disabled']]) {
    const calls = [];
    const cdp = async (target, method) => { calls.push(method); return method === 'Page.createIsolatedWorld' ? { executionContextId: 2 } : { result: { value: { satisfied: false, state } } }; };
    await assert.rejects(waitFor(cdp, r => r.result.value, sessions, null, null, 1, { selector: '#target', condition, timeout_ms: 100 }), error => {
      assert.match(error.message, new RegExp(`Wait for ${condition}.*#target.*current=.*${state}`)); return true;
    });
    assert.ok(!calls.some(m => m.startsWith('Input.') || m.startsWith('DOM.')));
  }
  for (const args of [{ condition: 'url' }, { condition: 'attached', ref: 'old' }, { condition: 'network_idle', selector: 'button' }]) assert.throws(() => waitOptions(args));
});

test('visible waits accept disabled elements while actionable waits report the disabled reason', () => {
  const field = { getBoundingClientRect: () => ({ width: 10, height: 10 }), ownerDocument: { defaultView: { getComputedStyle: () => ({ visibility: 'visible' }) } } };
  const query = () => field, inspect = () => ({ ready: false, reason: 'disabled' });
  assert.equal(inspectWait(query, inspect, { condition: 'visible' }).satisfied, true);
  assert.equal(inspectWait(query, inspect, { condition: 'actionable' }).reason, 'disabled');
});

test('network idle uses passive request tracking and does not claim quiet while a request is inflight', async () => {
  const diagnostics = createDiagnostics();diagnostics.start(1);
  diagnostics.event({ tabId: 1 }, 'Network.requestWillBeSent', { requestId: 'a', request: { url: 'https://test/', method: 'GET' } });
  const run = () => waitFor(null, null, null, diagnostics, null, 1, { condition: 'network_idle', idle_ms: 100, timeout_ms: 150 });
  await assert.rejects(run(), /inflight.*1/);
  diagnostics.event({ tabId: 1 }, 'Network.loadingFinished', { requestId: 'a' });
  assert.equal((await run()).satisfied, true);
});


test('text waits can observe any change from full previous text without knowing the next value', () => {
  const field={textContent:'Before'},query=()=>field;
  assert.equal(inspectWait(query,null,{condition:'text',previous:'Before'}).satisfied,false);
  field.textContent='After';
  assert.equal(inspectWait(query,null,{condition:'text',previous:'Before'}).satisfied,true);
  waitOptions({condition:'text',selector:'#state',previous:''});
  assert.throws(()=>waitOptions({condition:'text',selector:'#state',previous:'old',expected:'new'}),/exactly one/);
});
