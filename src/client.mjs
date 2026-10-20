import { spawn } from 'node:child_process';
import { open, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { loadConfig, VERSION } from './config.mjs';

export async function hubIsRunning(config) {
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${config.port}/health`, {
      headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(1000),
    });
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED' || error.name === 'TimeoutError') return false;
    throw error;
  }
  if (!response.ok) throw new Error('BrowserAttach port is occupied by an unpaired service');
  const health = await response.json();
  if (health.service !== 'browser-attach' || health.version !== VERSION)
    throw new Error('Hub version differs from this package; stop the hub and start again.');
  return true;
}

export async function ensureHub(configPath) {
  configPath = resolve(configPath);
  const config = await loadConfig(configPath);
  if (await hubIsRunning(config)) return config;
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  const log = await open(join(dirname(configPath), 'hub.log'), 'a', 0o600);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/browser-attach.mjs', import.meta.url)), 'hub', '--config', configPath], {
    detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
    env: { ...process.env, BROWSER_ATTACH_HOME: dirname(configPath) },
  });
  let spawnError;
  child.on('error', error => { spawnError = error; });
  child.unref(); await log.close();
  for (let i = 0; i < 40; i++) {
    if (spawnError) throw spawnError;
    await new Promise(resolve => setTimeout(resolve, 150));
    if (await hubIsRunning(config)) return config;
  }
  throw new Error(`Hub did not start. See ${join(dirname(configPath), 'hub.log')}`);
}

export class AttachClient {
  constructor(config) { this.config = config; this.pending = new Map(); this.counter = 0; }
  async connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.config.port}/client`, {
        headers: { Authorization: `Bearer ${this.config.token}` }, maxPayload: 24 * 1024 * 1024,
      });
      this.socket = ws;
      ws.once('open', resolve); ws.once('error', reject);
      ws.on('message', raw => {
        let data;
        try { data = JSON.parse(raw.toString()); } catch { ws.close(); return; }
        const item = this.pending.get(data.id);
        if (!item) return;
        this.pending.delete(data.id); clearTimeout(item.timer);
        if ('error' in data) item.reject(new Error(String(data.error))); else item.resolve(data.result);
      });
      ws.on('close', () => {
        reject(new Error('Hub connection closed'));
        for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('Hub disconnected; outcome may be unknown. Observe again.')); }
        this.pending.clear(); this.connecting = null;
      });
    });
    return this.connecting;
  }
  async call(method, args = {}) {
    await this.connect();
    return new Promise((resolve, reject) => {
      const id = ++this.counter;
      const timer = setTimeout(() => {
        this.pending.delete(id); this.socket.close();
        reject(new Error('Hub response timed out; outcome may be unknown. Observe again.'));
      }, 50000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, arguments: args }));
    });
  }
  async close() {
    const ws = this.socket;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    await new Promise(resolve => { ws.once('close', resolve); ws.close(); });
  }
}
