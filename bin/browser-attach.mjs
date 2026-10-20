#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { DEFAULT_CONFIG, loadConfig } from '../src/config.mjs';
import { ensureHub, hubIsRunning, AttachClient } from '../src/client.mjs';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    config: { type: 'string', default: DEFAULT_CONFIG },
    'extension-dir': { type: 'string' }, port: { type: 'string', default: '47831' },
    nosis: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' },
  } });
  const action = positionals[0] || 'mcp', configPath = values.config;
  if (values.help) {
    console.log('browser-attach [mcp|setup|start|status|stop]\n  setup [--extension-dir PATH] [--port 47831] [--nosis]\n  --config PATH (default: per-user BrowserAttach data directory)');
  } else if (action === 'mcp') {
    const { runMcp } = await import('../src/mcp.mjs'); await runMcp(configPath);
  } else if (action === 'hub') {
    const { startHub } = await import('../src/hub.mjs');
    const hub = await startHub(await loadConfig(configPath));
    const stop = () => hub.close(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } else if (action === 'setup') {
    if (values.nosis && configPath !== DEFAULT_CONFIG) throw new Error('--nosis uses the default per-user pairing; configure custom --config paths in your MCP client explicitly.');
    const { setup, configureNosis } = await import('../src/setup.mjs');
    const result = await setup({ configPath, extensionDir: values['extension-dir'], port: Number(values.port) });
    console.log(`Extension folder: ${result.extensionDir}\nExtension ID: ${result.config.extension_id}\nPairing: ${result.configPath}`);
    if (values.nosis) console.log(JSON.stringify(await configureNosis()));
    await ensureHub(result.configPath); console.log('Local hub started. Load/reload the extension in Chrome/Edge.');
  } else if (action === 'start') { await ensureHub(configPath); console.log('Local hub started.'); }
  else if (action === 'status') {
    const config = await loadConfig(configPath);
    if (!await hubIsRunning(config)) console.log('Local hub is stopped.');
    else {
      const client = new AttachClient(config);
      try { console.log(JSON.stringify(await client.call('list_browsers'), null, 2)); } finally { await client.close(); }
    }
  } else if (action === 'stop') {
    const config = await loadConfig(configPath);
    const response = await fetch(`http://127.0.0.1:${config.port}/shutdown`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Hub refused shutdown (${response.status})`);
    console.log('Hub stopped; extension control released.');
  } else throw new Error(`Unknown command: ${action}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
