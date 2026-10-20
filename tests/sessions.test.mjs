import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessions } from '../extension/sessions.js';

test('recursive flat sessions route nested and same-process frames and clean descendant detach', async () => {
  const calls = [], invalid = [], removed = [];
  let sessions;
  const child = (source, sessionId, targetId) => sessions.event(source, 'Target.attachedToTarget', { sessionId, targetInfo: { targetId, type: 'iframe', url: 'https://child.test' } });
  sessions = createSessions(async (target, method, params) => {
    if (typeof target === 'number') target = { tabId: target };
    calls.push({ target, method, params });
    if (method === 'Target.setAutoAttach') {
      assert.equal(params.flatten, true);
      if (!target.sessionId) child(target, 's1', 'child');
      if (target.sessionId === 's1') child(target, 's2', 'nested');
    }
    if (method === 'Page.getFrameTree') return { frameTree: target.sessionId === 's2'
      ? { frame: { id: 'nested' } }
      : target.sessionId === 's1' ? { frame: { id: 'child', parentId: 'main' }, childFrames: [{ frame: { id: 'same', parentId: 'child' } }] }
      : { frame: { id: 'main' }, childFrames: [{ frame: { id: 'child', parentId: 'main' } }] } };
    return {};
  }, (tab, frame) => invalid.push(frame), (tab, session) => removed.push(session));
  await sessions.start(1);
  assert.equal(calls.filter(call => call.method === 'Target.setAutoAttach').length, 3);
  assert.equal((await sessions.frames(1)).length, 4);
  assert.equal(sessions.target(1, 'nested').sessionId, 's2');
  assert.equal(sessions.target(1, 'same').sessionId, 's1');
  sessions.event({ tabId: 1 }, 'Target.detachedFromTarget', { sessionId: 's1' });
  assert.equal(sessions.has({tabId:1,sessionId:'s2'}), false);
  assert.deepEqual(new Set(removed), new Set(['s1', 's2']));
  assert.deepEqual(new Set(invalid), new Set(['child', 'same', 'nested']));
  sessions.forget(1); assert.equal(sessions.targets(1).length, 1);
});

test('release stops asynchronous session setup and failed setup never routes to the root target', async () => {
  let fail = false, sessions, finish;
  sessions = createSessions(async (target, method) => {
    if (target.sessionId && method === 'Runtime.enable') {
      if (fail) throw new Error('session setup failed');
      await new Promise(resolve => { finish = resolve; });
    }
    return {};
  }, () => {});
  await sessions.start(1);
  sessions.event({tabId:1}, 'Target.attachedToTarget', { sessionId:'pending', targetInfo:{type:'iframe',targetId:'child'} });
  sessions.forget(1); finish();
  await new Promise(resolve => setImmediate(resolve));
  await sessions.start(1); fail = true;
  sessions.event({tabId:1}, 'Target.attachedToTarget', {sessionId:'failed', targetInfo:{type:'iframe',targetId:'child'}});
  await sessions.settle(1);
  assert.throws(() => sessions.target(1, 'child'), /setup failed/);
});
