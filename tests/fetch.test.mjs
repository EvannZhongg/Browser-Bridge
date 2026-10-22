import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { capturePage, createFetches, fetchOptions } from '../extension/fetch.js';

test('fetch validates initial and continuation arguments before creating a tab', () => {
  for (const url of ['file:///tmp/a', 'chrome://settings', 'https://user:pass@example.com', 'bad']) assert.throws(() => fetchOptions({ url }));
  for (const args of [{}, { url: 'https://example.com', format: 'xml' }, { url: 'https://example.com', wait_until: 'interactive' }, { url: 'https://example.com', timeout_ms: 30001 }, { cursor: 'x', url: 'https://example.com' }, { cursor: 'x', format: 'json' }, { cursor: 'x', max_chars: 0 }]) assert.throws(() => fetchOptions(args));
  fetchOptions({ url: 'https://example.com' });
  fetchOptions({ url: 'https://example.com', wait_until: 'commit' });
  fetchOptions({ url: 'https://example.com', wait_until: 'domcontentloaded' });
  fetchOptions({ cursor: 'x', max_chars: 1 });
});

test('capture reads rendered text/current DOM/validated JSON and marks capture loss', () => {
  const document = { title: 'Page', contentType: 'text/html', readyState: 'complete', body: { innerText: 'visible', textContent: ' {"ok": true} ' }, documentElement: { outerHTML: '<html>current</html>' }, querySelector: () => null };
  const capture = (format, cap = 100) => vm.runInNewContext(`(${capturePage.toString()})(${JSON.stringify(format)},${cap})`, { document, location: { href: 'https://final.test', protocol: 'https:' } });
  assert.equal(capture('text').body, 'visible');
  assert.equal(capture('text').ready_state, 'complete');
  assert.equal(capture('text').body_source, 'rendered_document');
  assert.equal(capture('html').body, '<html>current</html>');
  assert.equal(capture('html').dom, 'rendered');
  assert.equal(capture('text').dom, undefined);
  document.title = '';
  assert.equal(Object.hasOwn(capture('json'), 'title'), false);
  assert.equal(capture('json').body, '{"ok":true}');
  assert.equal(capture('text', 3).capture_truncated, true);
  assert.throws(() => capture('json', 3), /capture limit/);
  document.body.textContent = 'not JSON';
  assert.throws(() => capture('json'), /JSON|Unexpected/);
  assert.throws(() => vm.runInNewContext(`(${capturePage.toString()})('text',100)`, { document, location: { protocol: 'file:' } }), /HTTP/);
});

test('fetch pagination is immutable, owner-scoped and never reads the URL again', async () => {
  let reads = 0;
  const fetches = createFetches(async () => { reads++; return { url: 'https://final.test', title: 'Page', contentType: 'application/json', body: '{"hello":"世界😀"}', capture_truncated: false }; });
  let page = await fetches.fetch('a', { url: 'https://initial.test', max_chars: 3 });
  const firstCursor = page.next_cursor;
  await assert.rejects(fetches.fetch('b', { cursor: firstCursor }), /another connection/);
  let body = page.body;
  while (page.next_cursor) { page = await fetches.fetch('a', { cursor: page.next_cursor, max_chars: 3 }); body += page.body; }
  assert.deepEqual(JSON.parse(body), { hello: '世界😀' });
  assert.equal(reads, 1);
  assert.equal(page.truncated, false);
  await assert.rejects(fetches.fetch('a', { cursor: firstCursor }), /stale/);
  page = await fetches.fetch('a', { url: 'https://initial.test', max_chars: 1 });
  fetches.forget('a');
  await assert.rejects(fetches.fetch('a', { cursor: page.next_cursor }), /stale/);
});

test('disconnect cannot resurrect an in-flight result; capture loss is independent of pagination', async () => {
  let finish;
  const fetches = createFetches(() => new Promise(resolve => { finish = resolve; }));
  const pending = fetches.fetch('owner', { url: 'https://example.com' });
  fetches.clear();
  finish({ body: 'late', capture_truncated: false });
  await assert.rejects(pending, /connection ended/);
  const bounded = createFetches(async () => ({ body: 'abc', capture_truncated: true }));
  const first = await bounded.fetch('owner', { url: 'https://example.com', max_chars: 1 });
  const last = await bounded.fetch('owner', { url: 'https://example.com' });
  assert.equal(last.truncated, true);
  assert.equal(last.next_cursor, null);
  assert.equal((await bounded.fetch('owner', { cursor: first.next_cursor })).body, 'bc');
});


test('JSON ignores the page budget and returns one complete parseable string', async () => {
  const body = JSON.stringify({ text: 'a'.repeat(900000), unicode: '世界😀' });
  const fetches = createFetches(async () => ({ format: 'json', body, capture_truncated: false }));
  const result = await fetches.fetch('owner', { url: 'https://fixture.test/json', format: 'json', max_chars: 400 });
  assert.equal(result.body, body); assert.deepEqual(JSON.parse(result.body), JSON.parse(body));
  assert.equal(result.truncated, false); assert.equal(result.next_cursor, null);
});

test('four immutable captures can interleave; a fifth evicts the least recently read capture', async () => {
  let reads = 0;
  const fetches = createFetches(async (owner, args) => ({ body: args.url + ':' + ++reads, capture_truncated: false }));
  const pages = [];
  for (const name of ['a', 'b', 'c', 'd']) pages.push(await fetches.fetch('owner', { url: 'https://fixture.test/' + name, max_chars: 1 }));
  pages[0] = await fetches.fetch('owner', { cursor: pages[0].next_cursor, max_chars: 1 });
  await fetches.fetch('owner', { url: 'https://fixture.test/e', max_chars: 1 });
  await assert.rejects(fetches.fetch('owner', { cursor: pages[1].next_cursor }), /evicted/);
  assert.match((await fetches.fetch('owner', { cursor: pages[0].next_cursor })).body, /a:1$/);
  assert.match((await fetches.fetch('owner', { cursor: pages[2].next_cursor })).body, /c:3$/);
  assert.match((await fetches.fetch('owner', { cursor: pages[3].next_cursor })).body, /d:4$/);
  assert.equal(reads, 5);
});

test('same URL gets independent captures; a failed read leaves other captures intact', async () => {
  let reads = 0;
  const fetches = createFetches(async (owner, args) => {
    if (args.url.endsWith('/fail')) throw new Error('read failed');
    return { body: 'capture:' + ++reads, capture_truncated: false };
  });
  const a = await fetches.fetch('owner', { url: 'https://fixture.test/same', max_chars: 1 });
  const b = await fetches.fetch('owner', { url: 'https://fixture.test/same', max_chars: 1 });
  await assert.rejects(fetches.fetch('owner', { url: 'https://fixture.test/fail' }), /read failed/);
  assert.equal((await fetches.fetch('owner', { cursor: a.next_cursor })).body, 'apture:1');
  assert.equal((await fetches.fetch('owner', { cursor: b.next_cursor })).body, 'apture:2');
});

test('completed and failed reads do not evict the four unfinished captures', async () => {
  const fetches = createFetches(async (owner, args) => {
    if (args.url.endsWith('/fail')) throw new Error('read failed');
    return { body: 'abcdef', capture_truncated: false };
  });
  const pages = [];
  for (let i = 0; i < 4; i++) pages.push(await fetches.fetch('owner', { url: 'https://fixture.test/' + i, max_chars: 1 }));
  await fetches.fetch('owner', { url: 'https://fixture.test/complete' });
  await assert.rejects(fetches.fetch('owner', { url: 'https://fixture.test/fail' }), /read failed/);
  for (const page of pages) assert.equal((await fetches.fetch('owner', { cursor: page.next_cursor })).body, 'bcdef');
});
