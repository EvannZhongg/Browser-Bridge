import { CLIENT_RESPONSE_TIMEOUT_MS } from '../extension/limits.js';
import { errorFromData } from '../extension/errors.js';
import WebSocket from 'ws';
import { VERSION } from './config.mjs';

export class AttachClient {
  constructor(config) { this.config = config; this.pending = new Map(); this.counter = 0; }
  async connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.config.port}/client`, {
        headers: { Authorization: `Bearer ${this.config.token}`, 'X-Browser-Attach-Version': VERSION }, maxPayload: 24 * 1024 * 1024,
      });
      this.socket = ws;
      ws.once('open', resolve); ws.once('error', reject);
      ws.on('message', raw => {
        let data;
        try { data = JSON.parse(raw.toString()); } catch { ws.close(); return; }
        const item = this.pending.get(data.id);
        if (!item) return;
        this.pending.delete(data.id); clearTimeout(item.timer);
        if ('error' in data) item.reject(errorFromData(data)); else item.resolve(data.result);
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
      }, CLIENT_RESPONSE_TIMEOUT_MS);
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
