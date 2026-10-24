import { spawn } from 'node:child_process';
import { open, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, VERSION } from './config.mjs';
import { compareVersions } from '../extension/version.js';

async function hubHealth(config) {
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${config.port}/health`, {
      headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(1000),
    });
  } catch (error) {
    if (['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'UND_ERR_SOCKET'].includes(error.cause?.code) || error.name === 'TimeoutError') return null;
    throw error;
  }
  if (!response.ok) throw new Error('BrowserAttach port is occupied by an unpaired service');
  const health = await response.json();
  if (health.service !== 'browser-attach') throw new Error('BrowserAttach port is occupied by another service');
  compareVersions(health.version, VERSION);
  return health;
}

export async function hubIsRunning(config) {
  const health = await hubHealth(config);
  if (!health) return false;
  if (health.version !== VERSION) throw new Error(`Hub ${health.version} differs from this package ${VERSION}; reconnect MCP to coordinate an upgrade`);
  return health.state === 'ready';
}

export async function ensureHub(configPath) {
  configPath = resolve(configPath);
  const config = await loadConfig(configPath);
  const deadline = Date.now() + 18000;
  const expected = new Set();
  let spawned = false, requested = false, readyAfter = 0, spawnError;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    const health = await hubHealth(config);
    if (!health) {
      if (!spawned) {
        spawned = true;
        await spawnHub(configPath, error => { spawnError = error; });
        readyAfter = Date.now() + 2500;
      }
    } else {
      const comparison = compareVersions(health.version, VERSION);
      if (comparison > 0) throw new Error(`Hub ${health.version} is newer than this package ${VERSION}; refusing to downgrade`);
      if (comparison < 0 && health.state == null) {
        throw new Error(`Hub ${health.version} predates coordinated upgrades; run browser-attach stop, restart MCP, and reload the extension manually if it was already loaded`);
      }
      if (comparison < 0 && health.state === 'ready' && !requested) {
        requested = true;
        for (const item of health.extensions) expected.add(item.instance_id);
        const response = await fetch(`http://127.0.0.1:${config.port}/upgrade`, { method: 'POST',
          headers: { Authorization: `Bearer ${config.token}`, 'X-Browser-Attach-Version': VERSION }, signal: AbortSignal.timeout(10000) });
        const result = await response.json();
        if (!response.ok) {
          const current = await hubHealth(config);
          if (current && compareVersions(current.version, VERSION) < 0 && !['upgrading', 'stopping'].includes(current.state)) throw new Error(result.error);
        } else for (const id of result.extensions) expected.add(id);
      } else if (comparison < 0 && health.state === 'ready' && requested) {
        throw new Error(health.upgrade_error || 'Hub upgrade did not complete; reconnect MCP to retry');
      } else if (comparison === 0 && health.state === 'ready') {
        const failure = health.extensions.find(item => item.error);
        if (failure) throw new Error(`Extension upgrade failed (${failure.instance_id}): ${failure.error}`);
        for (const item of health.extensions) if (item.ready) expected.delete(item.instance_id);
        if (!expected.size && health.extensions.every(item => item.ready) && Date.now() >= readyAfter) return config;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Hub/extension upgrade did not become ready${expected.size ? `; waiting for ${[...expected].join(', ')}` : ''}. See ${join(dirname(configPath), 'hub.log')}`);
}

async function spawnHub(configPath, onError) {
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  const log = await open(join(dirname(configPath), 'hub.log'), 'a', 0o600);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/browser-attach.mjs', import.meta.url)), 'hub', '--config', configPath], {
    detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
    env: { ...process.env, BROWSER_ATTACH_HOME: dirname(configPath) },
  });
  child.on('error', onError);
  child.unref(); await log.close();
}

