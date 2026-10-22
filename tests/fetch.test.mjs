import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { capturePage, createFetches, fetchOptions } from '../extension/fetch.js';

test('fetch validates initial and continuation arguments before creating a tab', () => {
  for (const url of ['file:///tmp/a', 'chrome://settings', 'https://user:pass@example.com', 'bad']) assert.throws(() => fetchOptions({ url }));
  for (const args of [{}, { url: 'https://example.com', format: 'xml' }, { url: 'https://example.com', wait_until: 'commit' }, { url: 'https://example.com', timeout_ms: 30001 }, { cursor: 'x', url: 'https://example.com' }, { cursor: 'x', format: 'json' }, { cursor: 'x', max_chars: 0 }]) assert.throws(() => fetchOptions(args));
  fetchOptions({ url: 'https://example.com' });
  fetchOptions({ cursor: 'x', max_chars: 1 });
});

test('capture reads rendered text/current DOM/validated JSON and marks capture loss', () => {
  const document = { title: 'Page', contentType: 'text/html', body: { innerText: 'visible', textContent: ' {"ok": true} ' }, documentElement: { outerHTML: '<html>current</html>' }, querySelector: () => null };
  const capture = (format, cap = 100) => vm.runInNewContext(`(${capturePage.toString()})(${JSON.stringify(format)},${cap})`, { document, location: { href: 'https://final.test', protocol: 'https:' } });
  assert.equal(capture('text').body, 'visible');
  assert.equal(capture('html').body, '<html>current</html>');
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

test('new fetch replaces old capture; disconnect cannot resurrect an in-flight result', async () => {
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
  await assert.rejects(bounded.fetch('owner', { cursor: first.next_cursor }), /stale/);
});
