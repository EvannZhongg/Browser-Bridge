import test from 'node:test';
import assert from 'node:assert/strict';
import { deadline, inspectTarget, waitForTarget } from '../extension/actionability.js';
import { createClick, clickOptions, describeHit, framePoint } from '../extension/click.js';
import { NAVIGATION_MAX_TIMEOUT_MS, NAVIGATION_OBSERVATION_TIMEOUT_MS, HUB_OPERATION_TIMEOUT_MS, CLIENT_RESPONSE_TIMEOUT_MS } from '../extension/limits.js';

test('transport budgets leave headroom after maximum navigation plus observation', () => {
  assert.ok(HUB_OPERATION_TIMEOUT_MS > NAVIGATION_MAX_TIMEOUT_MS + NAVIGATION_OBSERVATION_TIMEOUT_MS);
  assert.ok(CLIENT_RESPONSE_TIMEOUT_MS > HUB_OPERATION_TIMEOUT_MS);
});

test('actionability waits for ready and stable bounds; continuously moving targets send no input', async () => {
  let samples = 0;
  const cdp = async () => ({ result: { value: ++samples < 3 ? { ready: false } : { ready: true, x: 1 } } });
  await waitForTarget(cdp, result => result.result.value, { tabId: 1 }, { objectId: 'node' }, deadline(500));
  assert.equal(samples, 4);
  await assert.rejects(waitForTarget(async () => ({ ready: true, x: samples++ }), result => result,
    {}, { objectId: 'node' }, deadline(100)), /no input was dispatched/);
});

test('a timed out preparation cannot dispatch when its CDP reply eventually arrives', async () => {
  const budget = deadline(100);
  let finish, dispatched = 0;
  const operation = (async () => {
    await budget.run(() => new Promise(resolve => { finish = resolve; }));
    budget.dispatch(); dispatched++;
  })();
  await assert.rejects(operation, /no input was dispatched/);
  finish(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(dispatched, 0);
  const sent = deadline(100); sent.dispatch();
  await assert.rejects(sent.run(() => new Promise(() => {})), /Outcome is unknown.*never automatically replay/);
});

test('shared DOM check handles inherited inert across shadow hosts, visibility, disabled and read-only', () => {
  const doc = { defaultView: { getComputedStyle: () => ({ visibility: 'visible' }) } };
  const element = { isConnected: true, tagName: 'INPUT', type: 'text', ownerDocument: doc,
    matches: () => false, hasAttribute: () => false, getRootNode: () => ({}),
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 10, height: 10 }) };
  assert.equal(inspectTarget.call(element, true).ready, true);
  element.readOnly = true; assert.equal(inspectTarget.call(element, true).ready, false);
  element.readOnly = false; element.matches = () => true;
  assert.equal(inspectTarget.call(element).ready, false);
  element.matches = () => false;
  const host = { ...element, hasAttribute: name => name === 'inert' };
  element.getRootNode = () => ({ host });
  assert.equal(inspectTarget.call(element).ready, false);
  element.getRootNode = () => ({}); doc.defaultView.getComputedStyle = () => ({ visibility: 'hidden' });
  assert.equal(inspectTarget.call(element).ready, false);
});

test('mouse parameters validate buttons, double clicks, modifiers and DOM limitations', () => {
  assert.equal(clickOptions({ button: 'middle', modifiers: ['Control', 'Shift'] }).modifiers, 10);
  assert.equal(clickOptions({ button: 'right' }).buttons, 2);
  for (const args of [{button:'bad'}, {click_count:3}, {modifiers:['Ctrl']}, {mode:'dom',button:'right'}, {mode:'dom',click_count:2}]) {
    assert.throws(() => clickOptions(args));
  }
});

test('hit hints follow ancestors and shadow/slot boundaries while preserving the actual hit node', () => {
  const element = (tag, parent, { clickable = false, disabled = false } = {}) => ({ nodeType: 1, tagName: tag.toUpperCase(),
    parentElement: parent, innerText: tag, getRootNode: () => ({}), getAttribute: () => null,
    matches: selector => selector.startsWith('button,') ? clickable : disabled });
  const button = element('button', null, { clickable: true }), span = element('span', button);
  const hit = describeHit.call(span);
  assert.equal(hit.tag, 'span'); assert.equal(hit.clickable_hint, true); assert.equal(hit.clickable_target.tag, 'button');
  assert.equal(hit.disabled, false);
  const shadow = element('span', null); shadow.getRootNode = () => ({ host: button });
  assert.equal(describeHit.call(shadow).clickable_target.tag, 'button');
  const slotted = element('span', null); slotted.assignedSlot = element('slot', button);
  assert.equal(describeHit.call(slotted).clickable_hint, true);
  const disabled = element('button', null, { clickable: true, disabled: true });
  assert.equal(describeHit.call(element('span', disabled)).disabled, true);
  const plain = describeHit.call(element('span', element('div', null)));
  assert.equal(plain.clickable_hint, false); assert.equal(plain.clickable_target, null);
});

test('frame coordinate conversion preserves affine transforms and refuses perspective', () => {
  const view = {width:100,height:50}, quad = [10,20,10,220,-90,220,-90,20];
  assert.deepEqual(framePoint({x:50,y:25},quad,view), {x:-40,y:120});
  assert.deepEqual(framePoint({x:-40,y:120},quad,view,true), {x:50,y:25});
  assert.throws(() => framePoint({x:1,y:1},[0,0,100,0,80,100,0,100],view), /Perspective/);
});

test('ancestor-frame obstruction reports its hit target and preserves the failure if diagnostics disappear', async () => {
  for (const [vanished, dispatched] of [[false, false], [true, false], [false, true]]) {
    const calls = [];
    const cdp = async (target, method, args) => {
      calls.push(method);
      if (method === 'Runtime.callFunctionOn') {
        if (args.functionDeclaration.includes('function inspectTarget')) return { result: { value: { ready: true, x: 10, y: 10 } } };
        if (args.functionDeclaration.includes('function describeHit')) {
          if (!target.sessionId && vanished) throw new Error('Node disappeared');
          return { result: { value: { tag: 'div', text: target.sessionId ? 'Child' : 'Parent overlay' } } };
        }
        return { result: { value: true } };
      }
      if (method === 'DOM.getContentQuads') return { quads: [[0, 0, 50, 0, 50, 50, 0, 50]] };
      if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 100, 0, 100, 100, 0, 100] } };
      if (method === 'DOM.getFrameOwner') return { backendNodeId: 55 };
      if (method === 'DOM.getNodeForLocation') return { backendNodeId: target.sessionId ? 7 : 99 };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'hit' } };
      return {};
    };
    const mouse = createClick(cdp, r => r.result.value, async () => ({ width: 100, height: 100, scroll_x: 0, scroll_y: 0 }), p => p,
      { parent: () => ({ target: { tabId: 1 }, frameId: 'child' }) });
    const budget = deadline(); if (dispatched) budget.dispatch();
    await assert.rejects(mouse.prepare(1, { target: { tabId: 1, sessionId: 's1' }, objectId: 'target', backendNodeId: 7, frameId: 'child' }, { budget }), error => {
      assert.match(error.message, /covers this frame.*hit_target=.*blocked_frame_id="child"/);
      assert.match(error.message, dispatched ? /Outcome is unknown/ : /No input was dispatched/);
      assert.match(error.message, vanished ? /backend_node_id.*99/ : /Parent overlay/);
      assert.equal(error.input_dispatched, dispatched); return true;
    });
    assert.ok(!calls.some(method => method.startsWith('Input.')));
  }
});
