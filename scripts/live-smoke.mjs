// Real extension -> Hub -> stdio MCP integration on disposable local pages only.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { setup } from '../src/setup.mjs';
import { ROOT, DEFAULT_CONFIG, VERSION } from '../src/config.mjs';
import { startHub } from '../src/hub.mjs';

const { values } = parseArgs({ options: { executable: { type: 'string' }, family: { type: 'string', default: 'chromium' }, connected: { type: 'boolean', default: false } } });
if (!values.executable) throw new Error('Pass --executable PATH to a Chromium/Edge browser that permits --load-extension');
const temp = await mkdtemp(join(tmpdir(), 'attach-live-'));
const checks = [], calls = [];
let browser, hub, cdp, mcp;
const html = `<!doctype html><meta charset="utf-8"><title>Attach upload fixture</title>
<label>Single<input id="single" type="file"></label>
<label>Multiple<input id="multiple" type="file" multiple></label>
<input id="hidden" type="file" multiple hidden>
<button onclick="document.querySelector('#hidden').click()">Choose file</button>
<label>Disabled<input type="file" disabled></label>
<label>Directory<input type="file" webkitdirectory></label>
<input id="shadow-upload" type="file" hidden>
<button onclick="document.querySelector('#shadow-upload').showPicker()">Show picker</button>
<label>Name<input id="name"></label><button onclick="window.count++; sync()">Increment</button>
<button onclick="confirm('Fixture dialog');sync()">Confirm</button>
<pre id="state"></pre><script>
console.log('attach-before-claim');
window.count=0;const data={files:{},events:[],errors:[]};
function sync(){document.querySelector('#state').textContent='STATE:'+JSON.stringify({...data,count:window.count,name:document.querySelector('#name').value});}
window.onerror=message=>{data.errors.push(String(message));sync()};
window.onunhandledrejection=event=>{data.errors.push(String(event.reason));sync()};
for(const input of document.querySelectorAll('input[type=file]')){
 input.addEventListener('input',()=>{data.events.push(input.id+':input');sync()});
 input.addEventListener('change',async()=>{data.events.push(input.id+':change');
 data.files[input.id]=await Promise.all([...input.files].map(async file=>({name:file.name,size:file.size,text:await file.text()})));sync()});
}
document.querySelector('#name').oninput=sync;sync();</script>`;
let fetchVisits = 0, crawled = 0;
const fixture = http.createServer((request, response) => {
  const port = fixture.address().port;
  if (request.url === '/fetch/hang') return;
  if (request.url === '/fetch/events') { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write('data: connected\n\n'); return; }
  if (request.url === '/fetch/stall') { response.setHeader('Content-Type', 'text/html'); response.end('<title>Incomplete load</title><h1>Readable before load</h1><img src="/fetch/hang">'); return; }
  if (request.url === '/fetch/replace') { response.setHeader('Content-Type', 'text/html'); response.end('<title>Redirecting</title><h1>First document</h1><img src="/fetch/hang"><script>setTimeout(()=>location.replace("/fetch/final"),100)</script>'); return; }
  if (request.url === '/fetch/final') { response.setHeader('Content-Type', 'text/html'); response.end('<title>Final SPA document</title><h1>Final SPA content</h1>'); return; }
  if (request.url === '/fetch/sse') { response.setHeader('Content-Type', 'text/html'); response.end('<title>Streaming app</title><h1>Readable with a stream</h1><script>new EventSource("/fetch/events")</script>'); return; }
  if (request.url.startsWith('/fetch/empty/')) { response.writeHead(Number(request.url.split('/').at(-1)), { 'Content-Type': 'text/html', 'Content-Length': '0' }); response.end(); return; }
  if (request.url === '/fetch/error/404' || request.url === '/fetch/error/500') {
    const status = Number(request.url.split('/').at(-1));
    response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<title>HTTP error fixture</title><h1>Error ' + status + '</h1><p>' + 'error message '.repeat(80) + '</p>'); return;
  }
  if (request.url === '/fetch/softwall') { response.setHeader('Content-Type', 'text/html'); response.end('<title>Sign in</title><h1>Login required to view this document</h1>'); return; }
  if (request.url === '/fetch/status-frame') { response.setHeader('Content-Type', 'text/html'); response.end('<title>Main document</title><h1>Main frame</h1><iframe src="/fetch/error/404"></iframe>'); return; }
  if (request.url === '/fetch/large-json' || request.url === '/fetch/oversized-json') {
    response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.end(JSON.stringify({ text: 'a'.repeat(request.url === '/fetch/large-json' ? 900000 : 1000020) })); return;
  }
  if (request.url === '/fetch/redirect') { response.writeHead(302, { Location: '/fetch/page', 'Set-Cookie': 'fetch_session=local; HttpOnly; Path=/' }); response.end(); return; }
  if (request.url === '/fetch/page') {
    fetchVisits++; response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<title>Fetch fixture</title><h1>Read once</h1><span hidden>SECRET_HIDDEN</span><a href="/fetch/link">Link</a><p>${request.headers.cookie?.includes('fetch_session=local') ? 'SIGNED_IN' : 'SIGNED_OUT'}</p><script>const injected=document.createElement('script');injected.dataset.fixtureInjected='true';injected.textContent='/* rendered insertion */';document.head.append(injected);fetch('/fetch/data').then(r=>r.text()).then(text=>{const p=document.createElement('p');p.textContent=text;document.body.append(p)})</script>`); return;
  }
  if (request.url === '/fetch/data') { setTimeout(() => response.end('LATE_CONTENT'), 150); return; }
  if (request.url === '/fetch/link') { crawled++; response.end('not requested'); return; }
  if (request.url === '/fetch/json') { response.setHeader('Content-Type', 'application/json'); response.end('{"ok":true,"text":"你好😀"}'); return; }
  if (request.url === '/fetch/invalid') { response.setHeader('Content-Type', 'application/json'); response.end('{invalid'); return; }
  if (request.url === '/fetch/large') { response.setHeader('Content-Type', 'text/html'); response.end('<pre>' + 'a'.repeat(1000020) + '</pre>'); return; }
  if (request.url === '/fetch/slow') return;
  if (request.url === '/frames') {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<title>Frame fixture</title><button>Main frame button</button><iframe style="margin:60px;width:650px;height:500px" src="http://localhost:${port}/frame"></iframe><script>window.frameState={};addEventListener('message',event=>{window.frameState[event.data.id]=event.data})</script>`); return;
  }
  if (request.url?.startsWith('/frame') || request.url === '/nested') {
    const nested = request.url === '/nested';
    response.setHeader('Content-Type', 'text/html');
    response.end(`<title>Child fixture</title><button id="go">${nested ? 'Nested' : 'Child'} button</button><input aria-label="Child name" id="name"><input id="file" type="file" hidden><button onclick="file.click()">Child upload</button><pre id="state"></pre>
      ${nested ? '' : `<iframe style="margin:20px;width:400px;height:180px" src="http://127.0.0.1:${port}/nested"></iframe>`}
      <script>const data={id:${JSON.stringify(nested ? 'nested' : 'child')},clicks:0,doubles:0,middle:0,right:0,control:0,keys:0,wheels:0,wheelTrusted:false,text:'',files:[]};
      function publish(){state.textContent=JSON.stringify(data);top.postMessage(data,'*')}
      go.onclick=e=>{data.clicks++;if(e.ctrlKey)data.control++;console.log(data.id+' click');fetch('/api/ok');publish()};
      go.ondblclick=e=>{data.doubles++;publish()};go.onmousedown=e=>{if(e.button===1)e.preventDefault()};go.onauxclick=e=>{if(e.button===1){data.middle++;publish()}};
      go.oncontextmenu=e=>{e.preventDefault();data.right++;publish()};
      document.querySelector('#name').oninput=()=>{data.text=document.querySelector('#name').value;publish()};
      addEventListener('keydown',()=>{data.keys++;publish()});
      addEventListener('wheel',e=>{e.preventDefault();data.wheels++;data.wheelTrusted=e.isTrusted;publish()},{passive:false});
      file.onchange=()=>{data.files=[...file.files].map(f=>f.name);publish()};publish();</script>`); return;
  }
  if (request.url === '/api/redirect') { response.writeHead(302, { Location: '/api/ok' }); response.end(); return; }
  if (request.url === '/api/failed') { request.socket.destroy(); return; }
  if (request.url === '/api/ok') { response.setHeader('Content-Type', 'application/json'); response.end('{"ok":true}'); return; }
  if (request.url === '/api/missing') { response.writeHead(404); response.end('missing'); return; }
  response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html);
});
const fixtureSockets = new Set();
fixture.on('connection', socket => { fixtureSockets.add(socket); socket.on('close', () => fixtureSockets.delete(socket)); });
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${fixture.address().port}/`;
async function until(fn, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out waiting for ${description}`);
}
try {
  let configPath = DEFAULT_CONFIG;
  if (values.connected) {
    // Open only our local fixture in an already-paired user's browser profile.
    const launcher = spawn(values.executable, [url], { windowsHide: true, stdio: 'ignore' });
    launcher.on('error', error => console.error(error.message));
    launcher.unref();
  } else {
  // Allocate an isolated Hub port; the user's configured Hub is untouched.
  const reserve = http.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  configPath = join(temp, 'config.json');
  const pairing = await setup({ configPath, port }); hub = await startHub(pairing.config);
  const profile = join(temp, 'profile'); await mkdir(profile);
  browser = spawn(values.executable, [
    `--user-data-dir=${profile}`, `--disable-extensions-except=${pairing.extensionDir}`, `--load-extension=${pairing.extensionDir}`,
    '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--headless=new',
    '--enable-unsafe-extension-debugging', '--site-per-process', 'about:blank',
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  browser.on('error', error => { console.error(error.message); });
  let stderr = ''; browser.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-6000); });
  const active = await until(async () => {
    try { return (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/); } catch { return null; }
  }, 'test browser debugging endpoint');
  cdp = new WebSocket(`ws://127.0.0.1:${active[0]}${active[1]}`); await once(cdp, 'open');
  let id = 0; const pending = new Map();
  cdp.on('message', raw => { const data = JSON.parse(raw.toString()); const item = pending.get(data.id); if (item) { pending.delete(data.id); data.error ? item.reject(new Error(data.error.message)) : item.resolve(data.result); } });
  const command = (method, params) => new Promise((resolve, reject) => { const requestId = ++id; pending.set(requestId, { resolve, reject }); cdp.send(JSON.stringify({ id: requestId, method, params })); });
  await command('Target.createTarget', { url });
  }
  mcp = new Client({ name: 'live-test', version: '1' });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [join(ROOT, 'bin/browser-attach.mjs'), 'mcp', '--config', configPath], cwd: temp }));
  const tools = (await mcp.listTools()).tools;
  assert.equal(tools.length, 23);
  assert.ok(tools.some(tool => tool.name === 'browser_logs'));
  assert.ok(!tools.some(tool => ['browser_console_logs', 'browser_network_logs'].includes(tool.name)));
  const rawCall = async (method, args = {}) => {
    if (process.env.ATTACH_TEST_VERBOSE) console.error(method, args.ref || '');
    const result = await mcp.callTool({ name: `browser_${method}`, arguments: args });
    calls.push({ method, isError: !!result.isError }); return result;
  };
  const call = async (method, args) => { const result = await rawCall(method, args); if (result.isError) throw new Error(result.content[0].text); return JSON.parse(result.content[0].text); };
  const browsers = await until(async () => {
    const list = (await call('discover', { kind: 'browsers' })).browsers.filter(browser => !values.connected || browser.family === values.family);
    return list.length && list;
  }, 'extension connection');
  assert.ok(browsers[0].capabilities.includes('upload_file'));
  const browserId = browsers[0].browser_id;
  const fetchArgs = { browser_id: browserId };
  const activeBefore = (await call('discover', { kind: 'tabs', browser_id: browserId })).tabs.filter(t => t.active).map(t => t.tab_id);
  let fetched = await call('fetch', { ...fetchArgs, url: url + 'fetch/redirect', wait_until: 'network_idle', max_chars: 5 });
  assert.equal(fetched.url, url + 'fetch/page'); assert.equal(fetched.title, 'Fetch fixture'); assert.equal(fetched.contentType, 'text/html');
  assert.equal(fetched.status, 200); assert.equal(fetched.ok, true);
  let fetchedText = fetched.body;
  while (fetched.next_cursor) { fetched = await call('fetch', { ...fetchArgs, cursor: fetched.next_cursor, max_chars: 9 }); fetchedText += fetched.body; }
  assert.match(fetchedText, /Read once/); assert.match(fetchedText, /SIGNED_IN/); assert.match(fetchedText, /LATE_CONTENT/);
  assert.doesNotMatch(fetchedText, /SECRET_HIDDEN/); assert.equal(fetchVisits, 1); assert.equal(crawled, 0);
  const fetchedHtml = await call('fetch', { ...fetchArgs, url: url + 'fetch/page', format: 'html' });
  assert.match(fetchedHtml.body, /<h1>Read once<\/h1>/); assert.match(fetchedHtml.body, /SECRET_HIDDEN/);
  assert.equal(fetchedHtml.dom, 'rendered'); assert.match(fetchedHtml.body, /data-fixture-injected="true"/);
  const jsonPage = await call('fetch', { ...fetchArgs, url: url + 'fetch/json', format: 'json', max_chars: 4 });
  assert.equal(jsonPage.contentType, 'application/json'); assert.equal(jsonPage.status, 200); assert.equal(jsonPage.ok, true);
  assert.deepEqual(JSON.parse(jsonPage.body), { ok: true, text: '你好😀' });
  assert.equal(jsonPage.next_cursor, null); assert.equal(jsonPage.truncated, false); assert.equal(Object.hasOwn(jsonPage, 'title'), false);
  const wholeJson = await call('fetch', { ...fetchArgs, url: url + 'fetch/large-json', format: 'json', max_chars: 400 });
  assert.equal(JSON.parse(wholeJson.body).text.length, 900000); assert.equal(wholeJson.next_cursor, null);
  assert.equal((await rawCall('fetch', { ...fetchArgs, url: url + 'fetch/oversized-json', format: 'json' })).isError, true);
  for (const status of [404, 500]) {
    const errorPage = await call('fetch', { ...fetchArgs, url: url + 'fetch/error/' + status });
    assert.equal(errorPage.status, status); assert.equal(errorPage.ok, false); assert.match(errorPage.body, new RegExp('Error ' + status));
  }
  const wall = await call('fetch', { ...fetchArgs, url: url + 'fetch/softwall' });
  assert.equal(wall.status, 200); assert.equal(wall.ok, true); assert.match(wall.body, /Login required/);
  const mainWithErrorFrame = await call('fetch', { ...fetchArgs, url: url + 'fetch/status-frame' });
  assert.equal(mainWithErrorFrame.status, 200); assert.equal(mainWithErrorFrame.ok, true);
  for (const wait_until of ['commit', 'domcontentloaded', 'load']) {
    const started = Date.now();
    const readable = await call('fetch', { ...fetchArgs, url: url + 'fetch/stall', wait_until, timeout_ms: 1200 });
    assert.equal(readable.status, 200); assert.match(readable.body, /Readable before load/);
    assert.equal(readable.wait_until, wait_until); assert.equal(readable.wait_satisfied, wait_until !== 'load');
    assert.equal(readable.degraded, wait_until === 'load'); assert.equal(readable.document_changed, false);
    assert.ok(['loading', 'interactive', 'complete'].includes(readable.ready_state)); assert.ok(Date.now() - started < 1500);
  }
  const redirectedClient = await call('fetch', { ...fetchArgs, url: url + 'fetch/replace', timeout_ms: 4000 });
  assert.equal(redirectedClient.url, url + 'fetch/final'); assert.equal(redirectedClient.status, 200);
  assert.match(redirectedClient.body, /Final SPA content/); assert.equal(redirectedClient.document_changed, true);
  assert.equal(redirectedClient.wait_satisfied, true); assert.equal(redirectedClient.degraded, false);
  const streaming = await call('fetch', { ...fetchArgs, url: url + 'fetch/sse', wait_until: 'network_idle', timeout_ms: 1200 });
  assert.equal(streaming.status, 200); assert.match(streaming.body, /Readable with a stream/);
  assert.equal(streaming.degraded, true); assert.equal(streaming.degraded_reason, 'wait_timeout');
  for (const status of [418, 500, 503]) {
    const empty = await call('fetch', { ...fetchArgs, url: url + 'fetch/empty/' + status, timeout_ms: 1200 });
    assert.equal(empty.status, status); assert.equal(empty.ok, false); assert.equal(empty.body, '');
    assert.equal(empty.body_source, 'http_response'); assert.equal(empty.ready_state, null);
    assert.equal(empty.degraded_reason, 'http_error_response'); assert.equal(empty.body_unavailable, undefined);
  }
  const retained = [];
  for (const path of ['page', 'status-frame', 'softwall', 'error/404']) retained.push(await call('fetch', { ...fetchArgs, url: url + 'fetch/' + path, max_chars: 5 }));
  retained[0] = await call('fetch', { ...fetchArgs, cursor: retained[0].next_cursor, max_chars: 5 });
  retained.push(await call('fetch', { ...fetchArgs, url: url + 'fetch/error/500', max_chars: 5 }));
  const evicted = await rawCall('fetch', { ...fetchArgs, cursor: retained[1].next_cursor });
  assert.equal(evicted.isError, true); assert.match(evicted.content[0].text, /evicted/);
  for (const index of [0, 2, 3, 4]) assert.equal((await call('fetch', { ...fetchArgs, cursor: retained[index].next_cursor })).next_cursor, null);
  const invalidJson = await rawCall('fetch', { ...fetchArgs, url: url + 'fetch/invalid', format: 'json' });
  assert.equal(invalidJson.isError, true);
  const slow = await rawCall('fetch', { ...fetchArgs, url: url + 'fetch/slow', timeout_ms: 250 }); assert.equal(slow.isError, true);
  let large = await call('fetch', { ...fetchArgs, url: url + 'fetch/large', max_chars: 100000 });
  assert.equal(large.capture_truncated, true); let capturedChars = large.body.length;
  while (large.next_cursor) { large = await call('fetch', { ...fetchArgs, cursor: large.next_cursor, max_chars: 100000 }); capturedChars += large.body.length; }
  assert.equal(capturedChars, 1000000); assert.equal(large.truncated, true);
  const afterFetch = (await call('discover', { kind: 'tabs', browser_id: browserId })).tabs;
  assert.deepEqual(afterFetch.filter(t => t.active).map(t => t.tab_id), activeBefore);
  assert.ok(!afterFetch.some(t => t.url.startsWith(url + 'fetch/')));
  checks.push('fetch commit/DOMContentLoaded, stalled-load and persistent-stream degraded captures within deadline, client-side document replacement, empty 418/500/503 HTTP responses');
  checks.push('fetch background cleanup/no activation, redirect/login cookie, network idle, no crawling, rendered DOM marker/insertion, whole JSON/budget override/capture cap, 404/500/main-frame status, HTTP 200 soft wall, four interleaved captures/LRU eviction, omitted empty title, malformed JSON and timeout');
  const tab = await until(async () => (await call('discover', { kind: 'tabs', browser_id: browserId })).tabs.find(tab => tab.url === url && tab.title === 'Attach upload fixture'), 'fixture tab');
  const claim = await call('claim_tab', { browser_id: browserId, tab_id: tab.tab_id, expected_url: tab.url, expected_title: tab.title });
  const handle = { tab_handle: claim.tab_handle };
  const evaluate = (expression, args = {}) => call('evaluate', { ...handle, expression, ...args });
  const whole = await call('snapshot', handle);
  assert.equal(whole.profile, 'full'); assert.equal(whole.viewport, undefined); assert.equal(whole.snapshot_id, undefined); assert.equal(whole.note, undefined);
  const queried = await call('snapshot', { ...handle, query: 'increment' });
  assert.equal(queried.node_count, 1); assert.equal(queried.next_cursor, null); assert.ok(queried.snapshot.length < whole.snapshot.length);
  assert.doesNotMatch(queried.snapshot, /textbox/);
  await call('hover', { ...handle, ref: queried.snapshot.match(/\[([^\]]+)\] button/)[1] });
  const queriedPage = await call('snapshot', { ...handle, query: 'i', max_nodes: 1 });
  assert.equal(queriedPage.truncated, true);
  const queriedNext = await call('snapshot', { ...handle, cursor: queriedPage.next_cursor, verbose: true });
  assert.equal(queriedNext.query, 'i'); assert.ok(queriedNext.viewport.width); assert.ok(queriedNext.snapshot_id);
  const unmatched = await call('snapshot', { ...handle, query: 'no-such-fixture-control' });
  assert.equal(unmatched.snapshot, ''); assert.equal(unmatched.node_count, 0); assert.equal(unmatched.next_cursor, null);
  checks.push('compact default/full reading, fresh AX name query with actionable ref, query pagination/verbose metadata and zero matches');
  assert.ok(!(await call('logs', { ...handle, kind: 'console' })).entries.some(entry => entry.text === 'attach-before-claim'));
  assert.deepEqual((await evaluate('Promise.resolve({title: document.title, answer: 6 * 7})')).value,
    { title: 'Attach upload fixture', answer: 42 });
  const special = await evaluate('(()=>{const result={big:12n};result.self=result;return result})()');
  assert.equal(special.value.big.value, '12'); assert.equal(special.value.self.$type, 'circular_or_repeated');
  assert.equal((await evaluate('"x".repeat(100000)', { max_chars: 1000 })).truncated, true);
  assert.equal((await rawCall('evaluate', { ...handle, expression: '(()=>{throw new Error("evaluation fixture")})()' })).isError, true);
  assert.equal((await rawCall('evaluate', { ...handle, expression: 'new Promise(()=>{})', timeout_ms: 100 })).isError, true);
  assert.equal((await rawCall('evaluate', { ...handle, expression: '(()=>{while(true){}})()', timeout_ms: 200 })).isError, true);
  assert.equal((await evaluate('42')).value, 42); checks.push('evaluate promise/special values/truncation/errors/async and synchronous timeouts');
  let page = await evaluate('(window.pageRuns=(window.pageRuns||0)+1, Array.from({length:40},(_,i)=>({i,text:"escaped\\\\text"})))', { max_chars: 120 });
  const all = [...page.value];
  while (page.next_cursor) {
    page = await call('evaluate', { ...handle, cursor: page.next_cursor, max_chars: 120 });
    all.push(...page.value);
  }
  assert.equal(all.length, 40); assert.deepEqual(all.map(item => item.i), Array.from({ length: 40 }, (_, i) => i));
  assert.equal((await evaluate('window.pageRuns')).value, 1);
  await evaluate(`(()=>{
    const button=document.createElement('button');button.id='offscreen';button.innerHTML='<span style="display:block;width:100%;height:100%">Offscreen target</span>';
    button.style='position:absolute;left:20px;top:2200px;width:160px;height:40px';
    button.onclick=()=>window.extraClicks=(window.extraClicks||0)+1;document.body.append(button);
    const text=document.createElement('textarea');text.id='full-text';text.value='all\\nlines\\nhere';document.body.append(text);
  })()`);
  const located = await call('click', { ...handle, selector: '#offscreen' });
  assert.equal(located.hit_target.tag, 'span'); assert.equal(located.hit_target.text, 'Offscreen target');
  assert.equal(located.hit_target.clickable_hint, true);
  assert.equal(located.hit_target.clickable_target.tag, 'button');
  await call('click', { ...handle, selector: '//*[@id="offscreen"]', selector_type: 'xpath' });
  await call('click', { ...handle, x: 100, y: 2220, coordinate_space: 'document' });
  assert.equal((await evaluate('window.extraClicks')).value, 3);
  const readyTree = await call('snapshot', handle);
  const readyRef = readyTree.snapshot.split('\n').find(line => line.includes('button "Offscreen target"')).match(/\[([^\]]+)\]/)[1];
  const backgroundCover = await call('open_tab', { browser_id: browserId, url: `${url}?click-cover`, active: true });
  for (const target of [{ selector: '#offscreen' }, { ref: readyRef }, { x: 100, y: 100 }]) {
    const start = performance.now();
    const blocked = await rawCall('click', { ...handle, ...target, timeout_ms: 30000 });
    assert.equal(blocked.isError, true);
    assert.match(blocked.content[0].text, /TAB_NOT_READY.*browser_tab_control action=activate.*No input was dispatched/);
    assert.doesNotMatch(blocked.content[0].text, /unknown/i);
    assert.ok(performance.now() - start < 2000, 'background click must fail quickly, not consume the input deadline');
  }
  assert.equal((await evaluate('window.extraClicks')).value, 3);
  await call('click', { ...handle, selector: '#offscreen', mode: 'dom' });
  assert.equal((await evaluate('window.extraClicks')).value, 4);
  await call('tab_control', { ...handle, action: 'activate' });
  await call('snapshot', handle);
  assert.equal((await call('click', { ...handle, selector: '#offscreen' })).target_verified, true);
  assert.equal((await evaluate('window.extraClicks')).value, 5);
  const listedCover = await until(async () => (await call('discover', { kind: 'tabs', browser_id: browserId })).tabs.find(tab => tab.tab_id === backgroundCover.tab_id && tab.title === 'Attach upload fixture'), 'background click cover');
  const coverClaim = await call('claim_tab', { browser_id: browserId, tab_id: listedCover.tab_id });
  await call('tab_control', { action: 'close', tab_handle: coverClaim.tab_handle });
  checks.push('background native ref/selector/coordinate click fast rejection without effects; explicit DOM and activation recovery; span/button hit hints');
  assert.equal((await rawCall('click', { ...handle, selector: 'button' })).isError, true);
  await call('fill', { ...handle, selector: '#name', mode: 'dom', text: 'selector input' });
  assert.equal((await call('read_text', { ...handle, selector: '#name', mode: 'value' })).text, 'selector input');
  const textPage = await call('read_text', { ...handle, selector: '#full-text', mode: 'value', max_chars: 4 });
  const textRest = await call('read_text', { ...handle, selector: '#full-text', mode: 'value', offset: textPage.next_offset });
  assert.equal(textPage.text + textRest.text, 'all\nlines\nhere'); assert.equal(textRest.complete_source, true);
  assert.equal((await rawCall('read_text', { ...handle, selector: '#name', mode: 'editor' })).isError, true);
  await evaluate(`(()=>{document.querySelector('#offscreen').remove();document.querySelector('#full-text').remove();scrollTo(0,0)})()`);
  checks.push('CSS/XPath strict selectors, offscreen auto-scroll, document coordinates, hit metadata, value text pagination, cached evaluate pagination without replay');
  await evaluate(`(async()=>{
    console.warn('attach diagnostic warning', {answer:42});
    setTimeout(()=>{throw new Error('attach uncaught fixture')},0);
    Promise.reject(new Error('attach rejection fixture'));
    await (await fetch('/api/redirect')).text(); await (await fetch('/api/missing')).text();
    try { await fetch('/api/failed') } catch {}
    return true;
  })()`);
  const consoleLogs = await until(async () => {
    const result = await call('logs', { ...handle, kind: 'console' });
    return result.entries.some(entry => entry.text.includes('attach rejection fixture')) && result;
  }, 'console and rejection events');
  assert.equal(consoleLogs.kind, 'console');
  assert.ok(consoleLogs.entries.some(entry => entry.level === 'warning' && entry.text.includes('attach diagnostic warning')));
  assert.ok(consoleLogs.entries.some(entry => entry.source === 'exception' && entry.text.includes('attach uncaught fixture')));
  const networkLogs = await until(async () => {
    const result = await call('logs', { ...handle, kind: 'network', url_contains: '/api/' });
    return result.entries.some(entry => entry.event === 'failed') &&
      result.entries.some(entry => entry.event === 'finished' && entry.url?.endsWith('/api/ok')) && result;
  }, 'network failure');
  assert.equal(networkLogs.kind, 'network');
  assert.ok(networkLogs.entries.some(entry => entry.event === 'redirect' && entry.status === 302));
  assert.ok(networkLogs.entries.some(entry => entry.event === 'response' && entry.status === 404));
  assert.ok(networkLogs.entries.some(entry => entry.event === 'finished' && entry.url.endsWith('/api/ok')));
  const firstLog = await call('logs', { ...handle, kind: 'network', limit: 1 });
  assert.equal(firstLog.entries.length, 1);
  assert.ok((await call('logs', { ...handle, kind: 'network', after_seq: firstLog.next_seq })).entries.every(entry => entry.seq > firstLog.next_seq));
  checks.push('console previews/uncaught error/rejection and network redirect/HTTP error/failure/pagination');
  assert.equal((await rawCall('evaluate', { ...handle, expression: 'alert("evaluation modal")' })).isError, true);
  assert.ok((await call('logs', { ...handle, kind: 'console' })).entries.length);
  await call('handle_dialog', { ...handle, accept: true });
  await call('navigate', { ...handle, url: `${url}?diagnostics-reset` });
  assert.ok((await call('logs', { ...handle, kind: 'console' })).entries.some(entry => entry.text.includes('attach diagnostic warning')));
  assert.ok((await call('logs', { ...handle, kind: 'network' })).entries.some(entry => entry.event === 'redirect'));
  checks.push('evaluation dialog and diagnostic retention across navigation');
  const snapshot = () => call('snapshot', handle);
  const ref = async label => {
    const tree = (await snapshot()).snapshot;
    const line = tree.split('\n').find(line => line.includes(`"${label}"`) && /\[[^\]]+\] (button|textbox) /.test(line));
    assert.ok(line, `Missing ${label} in ${tree}`); return line.match(/\[([^\]]+)\]/)[1];
  };
  const state = async () => {
    const text = (await call('read_text', handle)).text;
    return JSON.parse(text.slice(text.indexOf('STATE:') + 6));
  };
  const file = join(temp, '中文 space.txt'), empty = join(temp, 'empty.txt');
  await writeFile(file, 'Attach 上传内容\n'); await writeFile(empty, '');
  await call('fill', { ...handle, ref: await ref('Name'), text: 'attach works' });
  assert.equal((await state()).name, 'attach works'); checks.push('existing fill');
  await call('click', { ...handle, ref: await ref('Increment') });
  assert.equal((await state()).count, 1); checks.push('existing click');
  const single = await ref('Single');
  await call('upload_file', { ...handle, ref: single, files: [file] });
  await until(async () => (await state()).files.single?.length, 'single file content');
  assert.equal((await state()).files.single[0].text, 'Attach 上传内容\n'); checks.push('single file content + Unicode path');
  assert.ok((await state()).events.includes('single:input'));
  assert.ok((await state()).events.includes('single:change'));
  await snapshot();
  assert.equal((await rawCall('upload_file', { ...handle, ref: single, files: [file] })).isError, true); checks.push('new snapshot expires the old ref');
  await call('upload_file', { ...handle, ref: await ref('Multiple'), files: [file, empty] });
  await until(async () => (await state()).files.multiple?.length === 2, 'multiple file content');
  assert.equal((await state()).files.multiple[1].size, 0); checks.push('multiple + empty file');
  const click = await call('click', { ...handle, ref: await ref('Choose file') });
  await until(async () => (await snapshot()).file_chooser, 'intercepted chooser');
  await call('upload_file', { ...handle, files: [file, empty] });
  await until(async () => (await state()).files.hidden?.length === 2, 'hidden chooser input');
  checks.push('Choose file -> hidden input upload without native dialog');
  await call('click', { ...handle, ref: await ref('Show picker') });
  await until(async () => (await snapshot()).file_chooser, 'showPicker interception');
  await call('upload_file', { ...handle, files: [file] });
  await until(async () => (await state()).files['shadow-upload']?.length === 1, 'showPicker input');
  checks.push('HTMLInputElement.showPicker');
  await call('upload_file', { ...handle, ref: await ref('Multiple'), files: [] });
  await until(async () => (await state()).files.multiple?.length === 0, 'cleared selection'); checks.push('clear selection');
  for (const [label, files] of [['Single', [file, empty]], ['Disabled', [file]], ['Directory', [file]]]) {
    assert.equal((await rawCall('upload_file', { ...handle, ref: await ref(label), files })).isError, true); checks.push(`${label} validation`);
  }
  assert.equal((await rawCall('upload_file', { ...handle, ref: await ref('Single'), files: [join(temp, 'missing')] })).isError, true); checks.push('missing file rejected');
  assert.deepEqual((await state()).errors, [], 'Upload interactions must not generate page JavaScript errors');
  await call('click', { ...handle, ref: await ref('Choose file') });
  await until(async () => (await snapshot()).file_chooser, 'chooser before navigation');
  await call('navigate', { ...handle, url: `${url}?fresh` });
  await until(async () => !(await snapshot()).file_chooser, 'navigation cleanup');
  assert.equal((await rawCall('upload_file', { ...handle, files: [] })).isError, true); checks.push('navigation clears chooser');
  await call('click', { ...handle, ref: await ref('Confirm') }).catch(() => {});
  const dialog = await snapshot(); assert.equal(dialog.dialog.type, 'confirm');
  const handled = await call('handle_dialog', { ...handle, accept: false });
  assert.equal(handled.dialog.type, 'confirm'); assert.equal(handled.accepted, false); assert.equal(handled.dialog.default_button, null);
  checks.push('existing dialog handling and original type/acceptance metadata');
  const final = await state(); assert.deepEqual(final.errors, []); checks.push('no page JavaScript errors');

  await call('navigate', { ...handle, url: `${url}frames` });
  const childRef = async (role, label) => {
    const tree = (await snapshot()).snapshot;
    const line = tree.split('\n').find(line => line.includes(`${role} "${label}"`));
    assert.ok(line, `Missing ${label}: ${tree}`); return line.match(/\[([^\]]+)\]/)[1];
  };
  const frameState = async id => (await evaluate(`window.frameState[${JSON.stringify(id)}]`)).value;
  await until(async () => (await snapshot()).snapshot.includes('Nested button'), 'nested OOPIF snapshot');
  const childClick = await call('click', { ...handle, ref: await childRef('button', 'Child button') });
  await until(async () => (await frameState('child'))?.clicks === 1, 'OOPIF native click');
  await call('click', { ...handle, ...childClick.clicked });
  await until(async () => (await frameState('child'))?.clicks === 2, 'root coordinate OOPIF click');
  await call('scroll', { ...handle, mode:'wheel', ...childClick.clicked, delta_y:80 });
  await until(async () => (await frameState('child'))?.wheels === 1, 'OOPIF native wheel handler');
  assert.equal((await frameState('child')).wheelTrusted,true);
  await call('fill', { ...handle, ref: await childRef('textbox', 'Child name'), text: 'OOPIF native' });
  await call('press_key', { ...handle, key: 'Z' });
  await until(async () => (await frameState('child'))?.text === 'OOPIF nativez', 'OOPIF fill and key');
  await call('fill', { ...handle, ref: await childRef('textbox', 'Child name'), text: 'DOM child', mode: 'dom' });
  assert.equal((await frameState('child')).text, 'DOM child');
  const childFrame = (await snapshot()).snapshot.split('\n').find(line => /^Frame /.test(line) && line.includes(`http://localhost:${fixture.address().port}/frame`)).split(' ')[1];
  await call('fill', { ...handle, selector: '#name', frame_id: childFrame, text: 'OOPIF selector', mode: 'dom' });
  assert.equal((await frameState('child')).text, 'OOPIF selector');
  await call('click', { ...handle, selector: '#go', frame_id: childFrame });
  await until(async () => (await frameState('child'))?.clicks === 3, 'OOPIF selector click');
  for (const options of [{button:'right'}, {button:'middle'}, {click_count:2}, {modifiers:['Control']}, {button:'right',click_count:2}, {button:'middle',click_count:2}]) {
    try { await call('click', { ...handle, ref: await childRef('button', 'Child button'), ...options }); }
    catch (error) { console.error('Mouse options', options, await frameState('child')); throw error; }
  }
  const mouseState = await frameState('child');
  assert.equal(mouseState.right, 3); assert.equal(mouseState.middle, 3); assert.equal(mouseState.doubles, 1); assert.equal(mouseState.control, 1);
  await call('click', { ...handle, ref: await childRef('button', 'Child upload') });
  await call('upload_file', { ...handle, files: [file] });
  await until(async () => (await frameState('child'))?.files.length === 1, 'OOPIF chooser upload');
  await call('click', { ...handle, ref: await childRef('button', 'Nested button') });
  await until(async () => (await frameState('nested'))?.clicks === 1, 'nested OOPIF click');
  assert.ok((await call('logs', { ...handle, kind: 'console' })).entries.some(e => e.session_id && e.text.includes('child click')));
  assert.ok((await call('logs', { ...handle, kind: 'network' })).entries.some(e => e.session_id && e.url?.includes('/api/ok')));
  // External subframe navigation must expire only its subtree, without consuming main refs.
  if (!values.connected) {
    await evaluate(`document.querySelector('iframe').src = 'http://localhost:${fixture.address().port}/frame?reload'`);
    // evaluate deliberately invalidates observations; take another before the timed reload.
    await evaluate(`setTimeout(()=>document.querySelector('iframe').src += '&again', 500)`);
    const stable = await childRef('button', 'Main frame button');
    await new Promise(resolve => setTimeout(resolve, 800));
    await call('tab_control', { ...handle, action: 'activate' });
    await call('click', { ...handle, ref: stable });
  }
  await evaluate(`(()=>{const cover=document.createElement('button');cover.id='cover';cover.textContent='Cover';cover.style='position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483647';cover.onclick=()=>window.coverClicks=(window.coverClicks||0)+1;document.body.append(cover)})()`);
  const covered = await rawCall('click', { ...handle, ref: await childRef('button', 'Child button'), timeout_ms: 500 });
  assert.equal(covered.isError, true); assert.match(covered.content[0].text, /covers this frame.*hit_target=.*Cover.*No input was dispatched/);
  assert.equal((await evaluate('window.coverClicks||0')).value, 0);
  await call('navigate', { ...handle, url });
  checks.push('nested OOPIF snapshot/native and DOM fill/keyboard/right-middle-double-Control clicks/chooser upload/logs/subframe navigation cleanup');

  await call('fill', { ...handle, ref: await ref('Name'), text: '' });
  await evaluate(`(()=>{window.keyEvents=[];addEventListener('keydown',e=>{keyEvents.push({key:e.key,code:e.code,trusted:e.isTrusted});if(['F8','Insert','PageUp'].includes(e.key))e.preventDefault()})})()`);
  for (const key of ['F8','Insert','PageUp']) await call('press_key', { ...handle, key });
  const keys = (await evaluate('window.keyEvents')).value;
  assert.deepEqual(keys.map(e=>e.code), ['F8','Insert','PageUp']); assert.ok(keys.every(e=>e.trusted));
  for (const key of ['Shift+1',';',':','?','+','Backslash','Quote','Backquote']) await call('press_key', { ...handle, key });
  assert.equal((await state()).name, "!;:?+\\'`");
  await evaluate(`(()=>{const zone=document.createElement('div');zone.id='wheel-zone';zone.style='position:fixed;left:20px;top:240px;width:300px;height:180px;overflow:auto;z-index:10';zone.innerHTML='<div style="height:1000px">Custom wheel scroller</div>';window.wheelState={count:0,dx:0,dy:0,trusted:false};zone.addEventListener('wheel',e=>{e.preventDefault();wheelState={count:wheelState.count+1,dx:e.deltaX,dy:e.deltaY,trusted:e.isTrusted}}, {passive:false});document.body.append(zone)})()`);
  await call('scroll', { ...handle, x:100,y:300,delta_y:90 });
  assert.equal((await evaluate('window.wheelState.count')).value,0);
  const wheel = await call('scroll', { ...handle,mode:'wheel',x:100,y:300,delta_x:-15,delta_y:120 });
  assert.equal(wheel.method,'native_wheel'); assert.equal(wheel.scrolled,undefined);
  await until(async () => (await evaluate('window.wheelState.count')).value === 1, 'trusted custom wheel handler');
  const wheelState = (await evaluate('window.wheelState')).value;
  assert.deepEqual(wheelState,{count:1,dx:-15,dy:120,trusted:true});
  checks.push('F8/Insert/PageUp trusted keys, shifted punctuation text, DOM default and native wheel custom handler');

  await call('tab_control', { ...handle, action: 'release' });
  const report = { date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()), family: values.family, user_agent: browsers[0].user_agent, extension_version: VERSION, checks, calls: calls.length, results: calls };
  const out = resolve(ROOT, 'test-results'); await mkdir(out, { recursive: true });
  await writeFile(join(out, `npm-live-${values.family}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, results: undefined }, null, 2));
} finally {
  await mcp?.close().catch(() => {});
  cdp?.close();
  browser?.kill();
  await hub?.close();
  for (const socket of fixtureSockets) socket.destroy();
  await new Promise(resolve => fixture.close(resolve));
  // Browser teardown may hold profile files briefly on Windows.
  await rm(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => {});
}
