import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startHub } from '../src/hub.mjs';
import { BridgeClient } from '../src/client.mjs';
import { ROOT, writeJson } from '../src/config.mjs';
import { setup, configureNosis } from '../src/setup.mjs';
import { validateFiles } from '../src/upload.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1kAAAAASUVORK5CYII=';
async function fixture(t, options) {
  const config = { port: 47831, token: 'test-secret-'.repeat(5), extension_id: 'a'.repeat(32) };
  const hub = await startHub(config, { port: 0, ...options }); config.port = hub.port;
  const sockets = [], clients = [], requests = [], released = new Set();
  let tabs = [{ tab_id: 9, title: 'Demo', url: 'http://localhost:8000/' }, { tab_id: 10, title: 'Other', url: 'https://example.com/' }];
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    for (const socket of sockets) socket.close();
    await hub.close();
  });
  async function extension({ family = 'chrome', instance = family, run = 'one', token = config.token } = {}) {
    const ws = new WebSocket(`ws://127.0.0.1:${config.port}/extension`, { origin: `chrome-extension://${config.extension_id}` });
    sockets.push(ws); await once(ws, 'open');
    const response = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'hello', token, browser: { family, instance_id: instance, run_id: run, profile_name: family, extension_version: '0.3.2' } }));
    const connected = JSON.parse((await response)[0].toString());
    ws.on('message', raw => {
      const data = JSON.parse(raw.toString()); requests.push(data);
      if (!data.id || data.command === 'stall') return;
      if (data.command === 'read_text' && options?.stall) return;
      let result = { ok: true };
      if (data.command === 'list_tabs') result = { tabs: structuredClone(tabs) };
      if (data.command === 'open_tab') result = { opened: true, tab_id: 11, active: data.arguments.active ?? false };
      if (data.command === 'release_owner') released.add(data.owner);
      if (data.command === 'snapshot') result = { snapshot: '[s1:1] button "Test"' };
      if (data.command === 'screenshot') result = { data: PNG, capture: { css_width: 1, css_height: 1,
        image_origin_css: { x: 0, y: 0 }, viewport: { scroll_x: 0, scroll_y: 0 } } };
      ws.send(JSON.stringify({ id: data.id, result }));
    });
    return { id: connected.browser_id, ws };
  }
  function client() { const client = new BridgeClient(config); clients.push(client); return client; }
  async function claim(client, browser, tabId = 9) {
    const result = await client.call('list_tabs', { browser_id: browser.id });
    const tab = result.tabs.find(tab => tab.tab_id === tabId);
    return client.call('claim_tab', { browser_id: browser.id, tab_id: tabId, expected_url: tab.url, expected_title: tab.title });
  }
  return { hub, config, extension, client, claim, requests, released, tabs };
}

test('loopback endpoints reject missing auth, website origins and unpaired extensions', async t => {
  const f = await fixture(t), url = `http://127.0.0.1:${f.config.port}`;
  assert.equal((await fetch(`${url}/health`)).status, 403);
  const headers = { Authorization: `Bearer ${f.config.token}`, Origin: 'https://evil.test' };
  assert.equal((await fetch(`${url}/health`, { headers })).status, 403);
  assert.equal((await fetch(`${url}/shutdown`, { method: 'POST', headers })).status, 403);
  for (const [path, settings] of [['extension', { origin: 'https://evil.test' }], ['client', { headers }], ['client', {}]]) {
    const ws = new WebSocket(`${url.replace('http:', 'ws:')}/${path}`, settings);
    await assert.rejects(once(ws, 'open'), /403/);
  }
  const ws = new WebSocket(`${url.replace('http:', 'ws:')}/extension`, { origin: `chrome-extension://${f.config.extension_id}` });
  await once(ws, 'open'); const closed = once(ws, 'close');
  ws.send(JSON.stringify({ type: 'hello', token: 'wrong' }));
  assert.equal((await closed)[0], 1008);
});

test('profiles are separate and upload capability is advertised', async t => {
  const f = await fixture(t); const chrome = await f.extension(), edge = await f.extension({ family: 'edge' });
  const result = await f.client().call('list_browsers');
  assert.deepEqual(new Set(result.browsers.map(item => item.browser_id)), new Set([chrome.id, edge.id]));
  assert.ok(result.browsers.every(item => item.capabilities.includes('upload_file')));
});

test('claims require exact latest observation; ownership and release are connection-scoped', async t => {
  const f = await fixture(t), browser = await f.extension(), a = f.client(), b = f.client();
  const args = { browser_id: browser.id, tab_id: 9, expected_url: f.tabs[0].url, expected_title: 'Demo' };
  await assert.rejects(a.call('claim_tab', args), /latest/);
  await a.call('list_tabs', { browser_id: browser.id });
  await assert.rejects(a.call('claim_tab', { ...args, expected_title: 'Changed' }), /exact/);
  const claim = await a.call('claim_tab', args);
  await assert.rejects(f.claim(b, browser), /another MCP/);
  await assert.rejects(b.call('upload_file', { tab_handle: claim.tab_handle, files: [] }), /belongs to another/);
  await f.claim(b, browser, 10);
  await a.call('release_tab', { tab_handle: claim.tab_handle }); await f.claim(b, browser);
});

test('disconnect releases owner; browser restart invalidates old handles', async t => {
  const f = await fixture(t), browser = await f.extension(), a = f.client();
  await f.claim(a, browser); await a.close();
  for (let i = 0; !f.released.size && i < 40; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(f.released.size);
  const b = f.client(), claim = await f.claim(b, browser);
  browser.ws.close(); await once(browser.ws, 'close');
  await f.extension({ run: 'two' });
  await assert.rejects(b.call('snapshot', { tab_handle: claim.tab_handle }), /expired/);
});

test('tab lifecycle routes to the selected browser and close expires only the owning handle', async t => {
  const f = await fixture(t), browser = await f.extension(), a = f.client(), b = f.client();
  await assert.rejects(a.call('open_tab', { browser_id: 'absent', url: 'https://example.com/' }), /not connected/);
  const opened = await a.call('open_tab', { browser_id: browser.id, url: 'https://example.com/' });
  assert.equal(opened.opened, true); assert.equal(opened.active, false);
  const claim = await f.claim(a, browser), args = { tab_handle: claim.tab_handle };
  await assert.rejects(b.call('activate_tab', args), /belongs to another/);
  await assert.rejects(b.call('close_tab', args), /belongs to another/);
  await a.call('activate_tab', { ...args, focus_window: true });
  assert.equal(f.requests.find(item => item.command === 'activate_tab').arguments.tab_id, 9);
  await a.call('close_tab', args);
  await assert.rejects(a.call('snapshot', args), /expired/);
  await f.claim(b, browser);
});

test('unknown outcome disconnects the client and releases its claims without replaying', async t => {
  const f = await fixture(t, { operationTimeout: 80, stall: true });
  const browser = await f.extension(), client = f.client(), claim = await f.claim(client, browser);
  await assert.rejects(client.call('read_text', { tab_handle: claim.tab_handle }), /outcome may be unknown/);
  for (let i = 0; f.hub.claims.size && i < 40; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.hub.claims.size, 0);
  assert.equal(f.requests.filter(item => item.command === 'read_text').length, 1);
});

test('real stdio MCP exposes 17 tools, single JSON content, PNG image, and validated upload', async t => {
  const f = await fixture(t), browser = await f.extension();
  const temp = await mkdtemp(join(tmpdir(), 'bridge-mcp-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const path = join(temp, 'config.json'), file = join(temp, '中文 empty.txt');
  await writeJson(path, f.config); await writeFile(file, '');
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(ROOT, 'bin/browser-bridge.mjs'), 'mcp', '--config', path], cwd: temp });
  const mcp = new Client({ name: 'test', version: '1' });
  await mcp.connect(transport); t.after(() => mcp.close());
  const tools = (await mcp.listTools()).tools;
  assert.equal(tools.length, 17);
  for (const name of ['click', 'fill']) {
    const mode = tools.find(tool => tool.name === `browser_${name}`).inputSchema.properties.mode;
    assert.deepEqual(mode.enum, ['native', 'dom']); assert.equal(mode.default, 'native');
  }
  for (const name of ['upload_file', 'open_tab', 'activate_tab', 'close_tab']) assert.ok(tools.some(tool => tool.name === `browser_${name}`));
  const call = (name, args = {}) => mcp.callTool({ name: `browser_${name}`, arguments: args });
  const browsers = await call('list_browsers');
  assert.equal(browsers.structuredContent, undefined); assert.equal(browsers.content.length, 1);
  assert.equal(JSON.parse(browsers.content[0].text).browsers[0].browser_id, browser.id);
  await call('list_tabs', { browser_id: browser.id });
  const result = await call('claim_tab', { browser_id: browser.id, tab_id: 9, expected_title: 'Demo', expected_url: f.tabs[0].url });
  const handle = JSON.parse(result.content[0].text).tab_handle;
  assert.ok(!(await call('click', { tab_handle: handle, ref: 'current-ref', mode: 'dom' })).isError);
  assert.equal(f.requests.find(item => item.command === 'click').arguments.mode, 'dom');
  const clickCount = f.requests.filter(item => item.command === 'click').length;
  assert.equal((await call('click', { tab_handle: handle, x: 1, y: 1, mode: 'dom' })).isError, true);
  assert.equal(f.requests.filter(item => item.command === 'click').length, clickCount);
  const image = await call('screenshot', { tab_handle: handle });
  assert.equal(image.content[1].mimeType, 'image/png');
  assert.equal(JSON.parse(image.content[0].text).capture.image_to_viewport_css.scale_x, 1);
  assert.ok(!image.content[0].text.includes(PNG));
  assert.ok(!(await call('upload_file', { tab_handle: handle, files: [file] })).isError);
  const count = f.requests.filter(item => item.command === 'upload_file').length;
  assert.equal((await call('upload_file', { tab_handle: handle, files: [join(temp, 'missing')] })).isError, true);
  assert.equal(f.requests.filter(item => item.command === 'upload_file').length, count);
  const error = await call('read_text', { tab_handle: 'expired' });
  assert.equal(error.isError, true);
  assert.match(error.content[0].text, /^Tab handle/);
  assert.ok(!(await call('open_tab', { browser_id: browser.id, url: 'https://example.com/' })).isError);
  assert.equal(f.requests.find(item => item.command === 'open_tab').arguments.active, false);
  assert.ok(!(await call('activate_tab', { tab_handle: handle })).isError);
  assert.equal(f.requests.find(item => item.command === 'activate_tab').arguments.focus_window, true);
  assert.ok(!(await call('close_tab', { tab_handle: handle })).isError);
  assert.equal((await call('snapshot', { tab_handle: handle })).isError, true);
  await mcp.close();
});

test('upload rejects directories, relative and missing files; handles empty files and Unicode paths', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'bridge-files-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const file = join(temp, '中文 empty.txt'); await writeFile(file, '');
  assert.deepEqual(await validateFiles([file]), [file]); assert.deepEqual(await validateFiles([]), []);
  await assert.rejects(validateFiles(['relative.txt']), /absolute/);
  await assert.rejects(validateFiles([temp]), /regular file/);
  await assert.rejects(validateFiles([join(temp, 'missing')]), /ENOENT/);
});

test('setup installs stable extension data outside package, and preserves current pairing on repeated setup', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'bridge-setup-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const configPath = join(temp, 'config.json');
  const a = await setup({ configPath }), b = await setup({ configPath });
  assert.equal(a.config.token, b.config.token);
  assert.equal(a.config.extension_id.length, 32);
  assert.equal(a.extensionDir, join(temp, 'extension'));
  assert.ok((await readFile(join(a.extensionDir, 'config.generated.js'), 'utf8')).includes(a.config.token));
  assert.equal(JSON.parse(await readFile(join(a.extensionDir, 'manifest.json'), 'utf8')).version, '0.3.2');
});

test('Nosis configuration uses the current server schema and preserves unrelated servers', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'bridge-nosis-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const path = join(temp, 'agent_config.json');
  await writeFile(path, JSON.stringify({ mcp: { servers: { other: { command: 'other-server' } } } }));
  await configureNosis(temp);
  const config = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(config.mcp.servers.other, { command: 'other-server' });
  assert.equal(config.mcp.servers.browser_bridge.command, 'browser-bridge');
  assert.ok(!('scope' in config.mcp.servers.browser_bridge));
});
