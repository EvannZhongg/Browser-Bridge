import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchFixture } from './helpers/controller-fixture.mjs';

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
