import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { serializeEvaluation } from '../extension/evaluate.js';
import { fixture } from './helpers/controller-fixture.mjs';

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
