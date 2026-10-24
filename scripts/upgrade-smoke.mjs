// Upgrade the real extension in a disposable browser profile; never touch user profiles.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import { ROOT, VERSION, writeJson } from '../src/config.mjs';
import { setup } from '../src/setup.mjs';
import { AttachClient } from '../src/client.mjs';
import { ensureHub } from '../src/hub-runtime.mjs';

const { values } = parseArgs({ options: { executable: { type: 'string' } } });
if (!values.executable) throw new Error('Pass --executable PATH to a browser that permits --load-extension');
const directory = await mkdtemp(join(tmpdir(), 'attach-real-upgrade-'));
const pkg = join(directory, 'package'), oldVersion = '0.16.9';
let hub, browser, client, config, cdp, browserErrors = '';
const page = http.createServer((request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Upgrade fixture</title><button onclick="this.textContent=\'Done\'">Upgrade action</button><script>window.upgradeSentinel=12345</script>'); });
async function until(check) {
  for (let i = 0; i < 150; i++) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Real-browser upgrade did not become ready');
}
try {
  await cp(join(ROOT, 'src'), join(pkg, 'src'), { recursive: true });
  await cp(join(ROOT, 'extension'), join(pkg, 'extension'), { recursive: true, filter: path => !path.endsWith('config.generated.js') });
  await writeJson(join(pkg, 'package.json'), { type: 'module' });
  await symlink(join(ROOT, 'node_modules'), join(pkg, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const configSource = join(pkg, 'src/config.mjs');
  await writeFile(configSource, (await readFile(configSource, 'utf8')).replace(`VERSION = '${VERSION}'`, `VERSION = '${oldVersion}'`));
  const manifestPath = join(pkg, 'extension/manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath)); manifest.version = oldVersion; await writeJson(manifestPath, manifest);
  const paired = await setup({ configPath: join(directory, 'config.json') }); config = paired.config;
  const { startHub } = await import(pathToFileURL(join(pkg, 'src/hub.mjs')));
  hub = await startHub(config, { port: 0 }); await writeJson(paired.configPath, config);
  await new Promise(resolve => page.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${page.address().port}/`;
  browser = spawn(values.executable, [`--user-data-dir=${join(directory, 'profile')}`,
    `--disable-extensions-except=${paired.extensionDir}`, `--load-extension=${paired.extensionDir}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--enable-logging=stderr', '--remote-debugging-port=0', '--enable-unsafe-extension-debugging', url], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  browser.stderr.on('data', chunk => { browserErrors = (browserErrors + chunk).slice(-10000); });
  const oldProfile = await until(() => [...hub.browsers.values()].find(item => item.ready));
  assert.equal(oldProfile.info.extension_version, oldVersion);
  const active = (await readFile(join(directory, 'profile/DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
  cdp = new WebSocket(`ws://127.0.0.1:${active[0]}${active[1]}`); await once(cdp, 'open');
  let sequence = 0;
  const pending = new Map();
  cdp.on('message', raw => { const message = JSON.parse(raw); if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); } });
  const call = (method, params = {}, sessionId) => new Promise(resolve => { const id = ++sequence; pending.set(id, resolve); cdp.send(JSON.stringify({ id, method, params, sessionId })); });
  // Set up developer mode through Chromium's own UI in this temporary profile.
  const settings = await call('Target.createTarget', { url: 'chrome://extensions/' });
  const attached = await call('Target.attachToTarget', { targetId: settings.result.targetId, flatten: true });
  await until(async () => (await call('Runtime.evaluate', { expression: 'typeof chrome.developerPrivate?.updateProfileConfiguration === "function"', returnByValue: true }, attached.result.sessionId)).result?.result?.value);
  const enabled = await call('Runtime.evaluate', { expression: 'new Promise((resolve,reject)=>chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true},()=>chrome.runtime.lastError?reject(new Error(chrome.runtime.lastError.message)):resolve(true)))', awaitPromise: true, returnByValue: true }, attached.result.sessionId);
  assert.equal(enabled.result?.result?.value, true, JSON.stringify(enabled));
  await call('Target.closeTarget', { targetId: settings.result.targetId });
  await Promise.all([ensureHub(paired.configPath), ensureHub(paired.configPath)]);
  client = new AttachClient(config);
  const profile = (await client.call('list_browsers')).browsers.find(item => item.instance_id === oldProfile.info.instance_id);
  assert.equal(profile.extension_version, VERSION);
  const opened = await client.call('open_tab', { browser_id: profile.browser_id, url, active: false });
  const tab = await until(async () => (await client.call('list_tabs', { browser_id: profile.browser_id })).tabs.find(item => item.tab_id === opened.tab_id && item.title === 'Upgrade fixture'));
  const claim = await client.call('claim_tab', { browser_id: profile.browser_id, tab_id: tab.tab_id });
  const snapshot = await client.call('snapshot', { tab_handle: claim.tab_handle, query: 'Upgrade action' });
  const ref = snapshot.snapshot.match(/\[([^\]]+)\] button/)[1];
  await client.call('click', { tab_handle: claim.tab_handle, ref, mode: 'dom' });
  assert.match((await client.call('snapshot', { tab_handle: claim.tab_handle, query: 'Done' })).snapshot, /Done/);
  await client.call('release_tab', { tab_handle: claim.tab_handle });
  console.log(JSON.stringify({ from: oldVersion, to: profile.extension_version, userAgent: profile.user_agent,
    sameProfile: profile.instance_id === oldProfile.info.instance_id, concurrentStartup: 'passed', automaticRuntimeReload: 'passed', pageOperationAfterUpgrade: 'passed' }));
} catch (error) {
  if (config) try { console.error(JSON.stringify(await (await fetch(`http://127.0.0.1:${config.port}/health`, { headers: { Authorization: `Bearer ${config.token}` } })).json())); } catch {}
  console.error(browserErrors);
  throw error;
} finally {
  await client?.close();
  cdp?.close();
  if (browser && browser.exitCode === null) { const exited = once(browser, 'exit'); browser.kill(); await exited; }
  if (config) try { await fetch(`http://127.0.0.1:${config.port}/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${config.token}` } }); } catch {}
  await hub?.close();
  await new Promise(resolve => page.close(resolve));
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
