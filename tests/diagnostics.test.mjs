import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnostics } from '../extension/diagnostics.js';

function fixture() {
  const logs = createDiagnostics(); logs.start(9);
  return { logs, emit: (method, params, source = { tabId: 9 }) => logs.event(source, method, params),
    read: (kind, args = {}) => logs.read(9, { kind, ...args }) };
}

test('unified log query requires a kind and refuses irrelevant filters', () => {
  const f = fixture();
  for (const kind of [undefined, '', 'all', '__proto__']) assert.throws(() => f.read(kind), /kind must be console or network/);
  assert.throws(() => f.read('console', { url_contains: '' }), /only valid for kind=network/);
  assert.throws(() => f.read('network', { level: 'error' }), /only valid for kind=console/);
  assert.throws(() => f.read('console', { level: 'unknown' }), /console level/);
  assert.throws(() => f.read('network', { url_contains: 5 }), /url_contains/);
  assert.equal(f.read('console').kind, 'console');
  assert.equal(f.read('network').kind, 'network');
});

test('network traffic cannot evict console messages; kind-specific cursors and loss stay independent', () => {
  const f = fixture();
  f.emit('Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'retained console error' }] });
  const consolePage = f.read('console');
  for (let i = 0; i < 700; i++) f.emit('Network.requestWillBeSent', { requestId: String(i), request: { url: 'https://fixture.test/api', method: 'GET' } });
  const networkPage = f.read('network', { limit: 1 });
  assert.equal(networkPage.kind, 'network'); assert.equal(networkPage.entries[0].seq, 201);
  assert.equal(networkPage.data_loss, true); assert.equal(networkPage.dropped_through_seq, 200);
  assert.equal(f.read('console').entries[0].text, 'retained console error');
  f.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'later console' }] });
  const nextConsole = f.read('console', { after_seq: consolePage.next_seq });
  assert.equal(nextConsole.kind, 'console'); assert.equal(nextConsole.data_loss, false);
  assert.deepEqual(nextConsole.entries.map(entry => entry.text), ['later console']);
  assert.equal(nextConsole.next_seq, 2); assert.equal(nextConsole.dropped_through_seq, 0);
  const nextNetwork = f.read('network', { after_seq: networkPage.next_seq, limit: 1 });
  assert.equal(nextNetwork.entries[0].seq, 202); assert.equal(nextNetwork.data_loss, false);
});

test('network lifecycle is append-only and correlates redirects without retaining headers or bodies', () => {
  const f = fixture();
  f.emit('Network.requestWillBeSent', { requestId: 'r1', timestamp: 1, request: { url: 'https://fixture.test/start', method: 'POST', headers: { Cookie: 'secret' }, postData: 'secret-body' }, type: 'Fetch', frameId: 'main' });
  const first = f.read('network');
  assert.equal(first.entries[0].event, 'request');
  f.emit('Network.requestWillBeSent', { requestId: 'r1', timestamp: 2, redirectResponse: { url: 'https://fixture.test/start', status: 302 }, request: { url: 'https://fixture.test/end', method: 'GET' } });
  f.emit('Network.responseReceived', { requestId: 'r1', timestamp: 3, response: { url: 'https://fixture.test/end', status: 404, mimeType: 'text/html', headers: { 'Set-Cookie': 'secret' }, fromServiceWorker: true } });
  f.emit('Network.loadingFinished', { requestId: 'r1', timestamp: 4, encodedDataLength: 123 });
  const next = f.read('network', { after_seq: first.next_seq });
  assert.deepEqual(next.entries.map(row => row.event), ['redirect', 'request', 'response', 'finished']);
  assert.deepEqual(next.entries.map(row => row.hop), [0, 1, 1, 1]);
  assert.equal(next.entries[2].status, 404); assert.equal(next.entries[2].from_service_worker, true);
  assert.ok(!JSON.stringify(next).includes('secret'));
  assert.equal(next.has_more, false);
  f.emit('Network.loadingFailed', { requestId: 'unknown', errorText: 'net::ERR_FAILED', canceled: true });
  const failed = f.read('network', { after_seq: next.next_seq });
  assert.equal(failed.entries[0].error, 'net::ERR_FAILED');
  assert.equal(failed.entries[0].canceled, true);
});

test('console collects previews, errors/rejections and browser messages; excludes old and unclaimed events and records child sessions', () => {
  const f = fixture();
  f.emit('Runtime.consoleAPICalled', { type: 'warn', timestamp: 1, args: [{ value: 'historical' }] });
  f.emit('Runtime.consoleAPICalled', { type: 'warn', executionContextId: 0, args: [{ value: 'removed context' }] });
  f.emit('Runtime.consoleAPICalled', { type: 'warn', args: [{ value: 'child' }] }, { tabId: 9, sessionId: 'child' });
  f.emit('Runtime.consoleAPICalled', { type: 'warn', args: [{ value: 'other tab' }] }, { tabId: 10 });
  const args = [{ value: 'warning' }, { type: 'object', objectId: 'private-handle', description: 'Object', preview: { properties: [{ name: 'x', value: '42' }] } }];
  f.emit('Runtime.consoleAPICalled', { type: 'warning', args, stackTrace: { callFrames: [{ url: 'https://fixture.test/', lineNumber: 10, columnNumber: 2 }] } });
  f.emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught (in promise)', exception: { description: 'Error: rejected' } } });
  f.emit('Log.entryAdded', { entry: { level: 'error', source: 'network', text: 'browser failure' } });
  const child = f.read('console').entries[0];
  assert.equal(child.session_id, 'child');
  const result = f.read('console', { after_seq: 1 });
  assert.equal(result.entries.length, 3); assert.equal(result.entries[0].level, 'warning');
  assert.match(result.entries[0].text, /x: 42/); assert.equal(result.entries[0].location.line, 10);
  assert.ok(!JSON.stringify(result).includes('private-handle'));
  assert.equal(f.read('console', { level: 'error' }).entries.length, 2);
});

test('log pagination never skips retained records; overflow is explicit and responses obey character budget', () => {
  const f = fixture();
  for (let i = 0; i < 700; i++) f.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: `entry ${i}` }] });
  let page = f.read('console', { limit: 37 }), count = page.entries.length;
  assert.equal(page.data_loss, true); assert.equal(page.dropped_through_seq, 200);
  while (page.has_more) {
    page = f.read('console', { after_seq: page.next_seq, limit: 37 });
    assert.equal(page.data_loss, false); count += page.entries.length;
  }
  assert.equal(count, 500); assert.equal(page.next_seq, 700);
  f.emit('Runtime.consoleAPICalled', { type: 'error', args: [{ value: '"\\'.repeat(10000) }] });
  const huge = f.read('console', { after_seq: 700, max_chars: 1000 });
  assert.equal(huge.entries[0].truncated, true); assert.ok(JSON.stringify(huge.entries).length <= 1000);
  assert.equal(huge.next_seq, 701);
  assert.throws(() => f.read('console', { after_seq: 10000 }), /after_seq/);
  assert.throws(() => f.read('console', { max_chars: 2 }), /max_chars/);
  f.logs.forget(9); assert.throws(() => f.read('console'), /unavailable/);
});

test('filters advance cursor through unmatched events and character budget evicts large messages', () => {
  const f = fixture();
  for (let i = 0; i < 300; i++) f.emit('Runtime.consoleAPICalled', { type: 'log', args: Array.from({ length: 4 }, () => ({ value: 'x'.repeat(2000) })) });
  const filtered = f.read('console', { level: 'error' });
  assert.equal(filtered.entries.length, 0); assert.equal(filtered.next_seq, 300);
  assert.equal(filtered.has_more, false); assert.ok(filtered.dropped_through_seq > 0);
  f.emit('Network.requestWillBeSent', { requestId: 'a', request: { url: 'https://fixture.test/api', method: 'GET' } });
  f.emit('Network.requestWillBeSent', { requestId: 'b', request: { url: 'https://fixture.test/image', method: 'GET' } });
  const network = f.read('network', { url_contains: '/api' });
  assert.equal(network.entries.length, 1); assert.equal(network.next_seq, 2);
});

test('identical child/root request and context ids retain independent ownership', () => {
  const f = fixture();
  for (const [sessionId, frameId] of [[undefined, 'main'], ['child', 'remote']]) {
    const source = { tabId: 9, ...(sessionId ? {sessionId} : {}) };
    f.emit('Runtime.executionContextCreated', { context: {id:42,auxData:{frameId}} }, source);
    f.emit('Runtime.consoleAPICalled', { executionContextId:42, type:'log', args:[{value:frameId}] }, source);
    f.emit('Network.requestWillBeSent', {requestId:'same',frameId,request:{url:`https://${frameId}.test/`,method:'GET'}}, source);
  }
  f.emit('Network.loadingFinished', {requestId:'same'}, {tabId:9});
  f.emit('Network.loadingFailed', {requestId:'same',errorText:'child failed'}, {tabId:9,sessionId:'child'});
  const consoleRows = f.read('console').entries;
  assert.deepEqual(consoleRows.map(row => row.frame_id), ['main','remote']);
  const finished = f.read('network').entries.slice(2);
  assert.deepEqual(finished.map(row => row.url), ['https://main.test/','https://remote.test/']);
  assert.deepEqual(finished.map(row => row.session_id), [null,'child']);
  f.logs.detach(9,'child');
  f.emit('Runtime.consoleAPICalled', {executionContextId:42,type:'log',args:[]}, {tabId:9,sessionId:'child'});
  assert.equal(f.read('console').entries.at(-1).frame_id, undefined);
});
