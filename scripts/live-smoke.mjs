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
import { ROOT, DEFAULT_CONFIG } from '../src/config.mjs';
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
const fixture = http.createServer((request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); });
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
    '--enable-unsafe-extension-debugging', 'about:blank',
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
  const rawCall = async (method, args = {}) => {
    if (process.env.ATTACH_TEST_VERBOSE) console.error(method, args.ref || '');
    const result = await mcp.callTool({ name: `browser_${method}`, arguments: args });
    calls.push({ method, isError: !!result.isError }); return result;
  };
  const call = async (method, args) => { const result = await rawCall(method, args); if (result.isError) throw new Error(result.content[0].text); return JSON.parse(result.content[0].text); };
  const browsers = await until(async () => {
    const list = (await call('list_browsers')).browsers.filter(browser => !values.connected || browser.family === values.family);
    return list.length && list;
  }, 'extension connection');
  assert.ok(browsers[0].capabilities.includes('upload_file'));
  const browserId = browsers[0].browser_id;
  const tab = await until(async () => (await call('list_tabs', { browser_id: browserId })).tabs.find(tab => tab.url === url && tab.title === 'Attach upload fixture'), 'fixture tab');
  const claim = await call('claim_tab', { browser_id: browserId, tab_id: tab.tab_id, expected_url: tab.url, expected_title: tab.title });
  const handle = { tab_handle: claim.tab_handle };
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
  assert.equal((await rawCall('upload_file', { ...handle, ref: single, files: [file] })).isError, true); checks.push('stale ref rejected');
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
  await call('handle_dialog', { ...handle, accept: false }); checks.push('existing dialog handling');
  const final = await state(); assert.deepEqual(final.errors, []); checks.push('no page JavaScript errors');
  await call('release_tab', handle);
  const report = { date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()), family: values.family, user_agent: browsers[0].user_agent, extension_version: '0.3.3', checks, calls: calls.length, results: calls };
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
