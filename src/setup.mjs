import { randomBytes, createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { ROOT, DEFAULT_CONFIG, loadConfig, writeJson } from './config.mjs';

export const mcpSettings = (configPath = DEFAULT_CONFIG) => ({ command: process.execPath,
  args: [join(ROOT, 'bin/browser-attach.mjs'), 'mcp', '--config', resolve(configPath)],
  env: { BROWSER_ATTACH_HOME: dirname(resolve(configPath)) } });

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const identity = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
    const sid = identity.match(/S-1-[\d-]+/)?.[0];
    if (!sid) throw new Error('Cannot determine current Windows user SID');
    execFileSync('icacls', [path, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true, stdio: 'pipe' });
  } else await chmod(path, 0o700);
}

export async function setup({ configPath = DEFAULT_CONFIG, extensionDir, port = 47831 } = {}) {
  configPath = resolve(configPath);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('port must be 1024..65535');
  await privateDirectory(dirname(configPath));
  extensionDir = resolve(extensionDir || join(dirname(configPath), 'extension'));
  if (extensionDir !== resolve(ROOT, 'extension')) {
    await cp(join(ROOT, 'extension'), extensionDir, { recursive: true, filter: source => !source.endsWith('config.generated.js') });
  }
  await privateDirectory(extensionDir);
  const manifestPath = join(extensionDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const extensionId = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)]
    .map(char => String.fromCharCode(97 + parseInt(char, 16))).join('');
  let config;
  try { config = await loadConfig(configPath); }
  catch (error) { if (error.cause?.code !== 'ENOENT') throw error; }
  config ||= { port, token: randomBytes(48).toString('base64url'), extension_id: extensionId };
  if (config.port !== port || config.extension_id !== extensionId) throw new Error('Pairing differs from requested port/extension. Stop the hub and remove the pairing config before a fresh setup.');
  config.extension_dir = extensionDir;
  manifest.content_security_policy = { extension_pages: `script-src 'self'; object-src 'self'; connect-src ws://127.0.0.1:${port}` };
  await writeJson(manifestPath, manifest);
  await writeFile(join(extensionDir, 'config.generated.js'), '// Machine-local pairing secret. Never publish.\nexport const CONNECTION = ' +
    JSON.stringify({ url: `ws://127.0.0.1:${port}/extension`, token: config.token }) + ';\n', { mode: 0o600 });
  await writeJson(configPath, config);
  return { config, configPath, extensionDir };
}

export async function configureNosis(directory = join(homedir(), '.nosis'), { configPath = DEFAULT_CONFIG } = {}) {
  const path = join(directory, 'agent_config.json');
  const data = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
  const backup = `${path}.browser-attach-${Date.now()}.bak`;
  await cp(path, backup);
  data.mcp ||= {}; data.mcp.enabled = true; data.mcp.servers ||= {};
  data.mcp.servers.browser_attach = { ...mcpSettings(configPath), startup_timeout_seconds: 20,
    call_timeout_seconds: 60, tools: { approval: 'always' } };
  await writeJson(path, data);
  return { path, backup };
}
