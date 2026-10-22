import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { cp, mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { ROOT, VERSION, writeJson } from '../src/config.mjs';
import { setup } from '../src/setup.mjs';
import { startHub } from '../src/hub.mjs';
import { ensureHub } from '../src/client.mjs';

async function until(check) {
  for (let i = 0; i < 100; i++) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('Condition did not become true');
}

async function fixture(t, version = '0.16.9') {
  const directory = await mkdtemp(join(tmpdir(), 'attach-upgrade-'));
  const pkg = join(directory, 'package');
  await cp(join(ROOT, 'src'), join(pkg, 'src'), { recursive: true });
  await cp(join(ROOT, 'extension'), join(pkg, 'extension'), { recursive: true, filter: path => !path.endsWith('config.generated.js') });
  await cp(join(ROOT, 'bin'), join(pkg, 'bin'), { recursive: true });
  await writeJson(join(pkg, 'package.json'), { type: 'module' });
  await symlink(join(ROOT, 'node_modules'), join(pkg, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const configSource = join(pkg, 'src/config.mjs');
  await writeFile(configSource, (await readFile(configSource, 'utf8')).replace(`VERSION = '${VERSION}'`, `VERSION = '${version}'`));
  const manifestPath = join(pkg, 'extension/manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')); manifest.version = version; await writeJson(manifestPath, manifest);
  const paired = await setup({ configPath: join(directory, 'pairing.json'), extensionDir: join(directory, 'custom extension') });
  const { startHub: startOld } = await import(pathToFileURL(join(pkg, 'src/hub.mjs')));
  const hub = await startOld(paired.config, { port: 0 });
  await writeJson(paired.configPath, paired.config);
  const headers = { Authorization: `Bearer ${paired.config.token}` };
  const base = `http://127.0.0.1:${paired.config.port}`;
  const sockets = [], requests = [];
  const reconnects = new Set();
  let closing = false;
  t.after(async () => {
    closing = true;
    for (const timer of reconnects) clearTimeout(timer);
    for (const ws of sockets) ws.terminate();
    try { await fetch(base + '/shutdown', { method: 'POST', headers }); } catch {}
    await hub.close();
    await until(async () => { try { await fetch(base + '/health', { headers }); return false; } catch { return true; } });
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  async function extension({ failCleanup = false, extensionVersion = version, instance = 'profile' } = {}) {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/extension', { origin: `chrome-extension://${paired.config.extension_id}` });
    sockets.push(ws);
    let reloadVersion;
    ws.on('close', () => {
      if (closing) return;
      const timer = setTimeout(() => {
        reconnects.delete(timer);
        extension({ failCleanup, extensionVersion: reloadVersion || extensionVersion, instance }).catch(() => {});
      }, 100);
      reconnects.add(timer);
    });
    ws.on('error', () => {});
    ws.on('message', raw => {
      const data = JSON.parse(raw.toString());
      if (!data.id) return;
      requests.push(data.command);
      if (data.command === 'reload_extension') {
        reloadVersion = VERSION;
        ws.send(JSON.stringify({ id: data.id, result: { reloading: true } }));
        ws.close();
      } else if (data.command === 'prepare_upgrade' && failCleanup) {
        ws.send(JSON.stringify({ id: data.id, error: 'detach failed' }));
      } else ws.send(JSON.stringify({ id: data.id, result: { prepared: true } }));
    });
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'hello', token: paired.config.token, browser: {
      family: 'chrome', instance_id: instance, run_id: 'run', profile_name: instance, extension_version: extensionVersion,
    } }));
    return ws;
  }
  return { ...paired, hub, base, headers, sockets, requests, extension, manifestPath: join(paired.extensionDir, 'manifest.json') };
}

test('concurrent MCP startups upgrade an idle Hub and extension, preserving the custom pairing', async t => {
  const f = await fixture(t);
  await f.extension();
  await until(() => f.hub.browsers.size === 1);
  const token = f.config.token;
  const results = await Promise.all([ensureHub(f.configPath), ensureHub(f.configPath)]);
  assert.ok(results.every(config => config.token === token && config.port === f.config.port && config.extension_dir === f.extensionDir));
  const health = await (await fetch(f.base + '/health', { headers: f.headers })).json();
  assert.equal(health.version, VERSION);
  assert.equal(health.browsers, 1);
  assert.equal(health.extensions[0].version, VERSION);
  assert.equal(JSON.parse(await readFile(f.manifestPath)).version, VERSION);
  assert.equal(f.requests.filter(command => command === 'prepare_upgrade').length, 1);
  assert.equal(f.requests.filter(command => command === 'reload_extension').length, 1);
  assert.deepEqual(JSON.parse(await readFile(f.configPath)), f.config);
});

test('an open MCP connection prevents upgrade even before its first tool call', async t => {
  const f = await fixture(t);
  const ws = new WebSocket(f.base.replace('http:', 'ws:') + '/client', { headers: { ...f.headers, 'X-Browser-Attach-Version': '0.16.9' } });
  f.sockets.push(ws); await once(ws, 'open');
  await assert.rejects(ensureHub(f.configPath), /in use/);
  assert.equal(JSON.parse(await readFile(f.manifestPath)).version, '0.16.9');
  assert.deepEqual(f.requests, []);
});

test('failed extension cleanup aborts the upgrade and resumes the existing Hub', async t => {
  const f = await fixture(t);
  await f.extension({ failCleanup: true });
  await until(() => f.hub.browsers.size === 1);
  await assert.rejects(ensureHub(f.configPath), /detach failed/);
  const health = await (await fetch(f.base + '/health', { headers: f.headers })).json();
  assert.equal(health.state, 'ready');
  assert.equal(health.version, '0.16.9');
  assert.equal(JSON.parse(await readFile(f.manifestPath)).version, '0.16.9');
  assert.deepEqual(f.requests, ['prepare_upgrade', 'resume']);
});

test('a newer shared Hub is never downgraded by an older MCP package', async t => {
  const f = await fixture(t, '0.18.0');
  await assert.rejects(ensureHub(f.configPath), /refusing to downgrade/);
  assert.equal(JSON.parse(await readFile(f.manifestPath)).version, '0.18.0');
});

test('only the Hub that owns the port may modify extension files, and interrupted replacement recovers', async t => {
  const f = await fixture(t);
  await assert.rejects(startHub(f.config), /EADDRINUSE/);
  assert.equal(JSON.parse(await readFile(f.manifestPath)).version, '0.16.9');
  await f.hub.close();
  await cp(f.extensionDir, f.extensionDir + '.previous', { recursive: true });
  await writeFile(join(f.extensionDir, 'connection.js'), 'interrupted write');
  await writeFile(join(f.extensionDir, 'partial-module.js'), 'incomplete update');
  const next = await startHub(f.config);
  t.after(() => next.close());
  assert.equal(JSON.parse(await readFile(f.manifestPath)).version, VERSION);
  assert.equal(await readFile(join(f.extensionDir, 'connection.js'), 'utf8'), await readFile(join(ROOT, 'extension/connection.js'), 'utf8'));
  await assert.rejects(readFile(join(f.extensionDir, 'partial-module.js')), { code: 'ENOENT' });
});

test('repeated setup retains a custom port and directory without touching active extension files', async t => {
  const f = await fixture(t);
  const repeated = await setup({ configPath: f.configPath });
  assert.deepEqual(repeated.config, f.config);
  assert.equal(JSON.parse(await readFile(f.manifestPath)).version, '0.16.9');
});

test('concurrent cold startup works without browsers; an offline older profile upgrades when it connects', async t => {
  const f = await fixture(t, VERSION);
  await f.hub.close();
  await Promise.all([ensureHub(f.configPath), ensureHub(f.configPath)]);
  const health = () => fetch(f.base + '/health', { headers: f.headers }).then(response => response.json());
  assert.equal((await health()).browsers, 0);
  await f.extension({ extensionVersion: '0.16.9' });
  await until(async () => (await health()).extensions.some(item => item.ready && item.version === VERSION));
  assert.deepEqual(f.requests, ['reload_extension']);
});

test('a legacy Hub without upgrade coordination fails fast with recovery guidance', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'attach-legacy-'));
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/health') response.end(JSON.stringify({ service: 'browser-attach', version: '0.16.0', browsers: 0 }));
    else response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const configPath = join(directory, 'config.json');
  await writeJson(configPath, { token: 'x'.repeat(48), port: server.address().port,
    extension_id: 'a'.repeat(32), extension_dir: join(directory, 'extension') });
  await assert.rejects(ensureHub(configPath), /predates coordinated upgrades/);
});
