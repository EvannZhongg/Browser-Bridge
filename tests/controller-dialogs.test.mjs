import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/controller-fixture.mjs';

test('failure before outcome observation starts still restores the dialog policy scope', async () => {
  const f = fixture(); await f.claim();
  const get = f.api.tabs.get;
  let reads = 0;
  f.api.tabs.get = async id => { if (++reads === 2) throw new Error('Tab metadata unavailable'); return get(id); };
  await assert.rejects(f.exec('fill', { selector: 'input', text: 'value', dialog_policy: 'accept' }), /Tab metadata unavailable/);
  f.api.tabs.get = get; f.modal();
  await assert.rejects(f.exec('click', { selector: 'button' }), error => {
    assert.equal(error.post_action.dialogs[0].policy, 'ask');
    assert.equal(error.post_action.dialogs[0].accepted, null);
    return true;
  });
});

test('post-action evidence distinguishes unavailable observation, confirmed no change and positive effects without replay', async () => {
  for (const scenario of ['install_failed', 'read_failed', 'unchanged', 'mutated', 'navigation', 'tab_failed']) {
    const f = fixture(); await f.claim(); const send = f.api.debugger.sendCommand;
    const get = f.api.tabs.get; let sent = false;
    f.api.tabs.get = async id => { if (sent && scenario === 'tab_failed') throw new Error('Tab probe failed'); return get(id); };
    f.api.debugger.sendCommand = async (target, method, args) => {
      if (method === 'Runtime.evaluate' && args.expression.includes('installOutcomeObserver')) {
        if (scenario === 'install_failed') throw new Error('Cannot install observer');
        return { result: { objectId: 'observer' } };
      }
      if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function verifyFill')) {
        sent = true;
        if (scenario === 'navigation') f.api.debugger.onEvent.emit(target, 'Page.navigatedWithinDocument', { frameId: 'main' });
        return { result: { value: false } };
      }
      if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('this.read()')) {
        if (['read_failed', 'navigation'].includes(scenario)) throw new Error('Observer context destroyed');
        return { result: { value: { dom_changed: scenario === 'mutated' } } };
      }
      return send(target, method, args);
    };
    await assert.rejects(f.exec('fill', { selector: 'input', text: 'not retained' }), error => {
      assert.equal(error.input_dispatched, true);
      const evidence = error.post_action;
      assert.equal(evidence.delivery, 'unknown');
      assert.equal(evidence.assessment, ['navigation', 'mutated'].includes(scenario) ? 'observable_effects'
        : scenario === 'unchanged' ? 'no_observable_effects' : 'observation_unavailable');
      assert.equal(evidence.observations.dom.available, !['install_failed', 'read_failed', 'navigation'].includes(scenario));
      assert.equal(evidence.observations.tab.available, scenario !== 'tab_failed');
      return true;
    });
    assert.equal(f.calls.filter(call => call.method === 'Input.insertText').length, 1);
  }
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
