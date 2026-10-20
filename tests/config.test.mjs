import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_CONFIG, ROOT } from '../src/config.mjs';
import { configureNosis, mcpSettings } from '../src/setup.mjs';

const configModule = new URL('../src/config.mjs', import.meta.url).href;
function resolveInChild(env, cwd) {
  const childEnv = { ...process.env, ...env };
  if (env.BROWSER_ATTACH_HOME === undefined) delete childEnv.BROWSER_ATTACH_HOME;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    `const c = await import(${JSON.stringify(configModule)}); console.log(JSON.stringify({data: c.DATA_DIR, config: c.DEFAULT_CONFIG}));`],
  { env: childEnv, cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
}

test('Windows default is outside AppData and independent of LOCALAPPDATA and cwd', { skip: process.platform !== 'win32' }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'attach-path-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const other = join(temp, 'other cwd'); await mkdir(other);
  const a = resolveInChild({ BROWSER_ATTACH_HOME: undefined, LOCALAPPDATA: join(temp, 'virtual view') }, temp);
  const b = resolveInChild({ BROWSER_ATTACH_HOME: undefined, LOCALAPPDATA: join(temp, 'normal view') }, other);
  assert.deepEqual(a, b);
  assert.equal(a.data, join(homedir(), '.browser-attach'));
  assert.equal(a.config, join(a.data, 'config.json'));
});

test('absolute shared home wins across process environments; relative home is rejected', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'attach-path-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const shared = join(temp, '中文 shared data');
  const actual = resolveInChild({ BROWSER_ATTACH_HOME: shared, LOCALAPPDATA: join(temp, 'ignored') }, ROOT);
  assert.equal(actual.data, shared);
  assert.equal(actual.config, join(shared, 'config.json'));
  assert.throws(() => resolveInChild({ BROWSER_ATTACH_HOME: './unstable-relative' }, temp), error =>
    error.stderr.toString().includes('BROWSER_ATTACH_HOME must be an absolute directory'));
  if (process.platform === 'win32') assert.throws(() => resolveInChild({ BROWSER_ATTACH_HOME: '\\drive-relative' }, temp), error =>
    error.stderr.toString().includes('BROWSER_ATTACH_HOME must be an absolute directory'));
});

test('generated MCP pins Node, CLI and the exact pairing file; Nosis custom config is backed up', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'attach-nosis-path-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const configPath = join(temp, 'shared data', 'pairing.json');
  const launch = mcpSettings(configPath);
  assert.deepEqual(launch, { command: process.execPath,
    args: [join(ROOT, 'bin/browser-attach.mjs'), 'mcp', '--config', configPath],
    env: { BROWSER_ATTACH_HOME: dirname(configPath) } });
  assert.equal(mcpSettings().args.at(-1), DEFAULT_CONFIG);
  const path = join(temp, 'agent_config.json');
  const original = { model: 'unchanged', mcp: { servers: { other: { command: 'other' } } } };
  await writeFile(path, JSON.stringify(original));
  const result = await configureNosis(temp, { configPath });
  assert.deepEqual(JSON.parse(await readFile(result.backup, 'utf8')), original);
  const updated = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(updated.model, original.model);
  assert.deepEqual(updated.mcp.servers.other, original.mcp.servers.other);
  assert.deepEqual(updated.mcp.servers.browser_attach.args, launch.args);
  assert.deepEqual(updated.mcp.servers.browser_attach.env, launch.env);
});
