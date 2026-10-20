import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { readFile, mkdir, writeFile, rename, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const DATA_DIR = process.env.BROWSER_BRIDGE_HOME
  ? resolve(process.env.BROWSER_BRIDGE_HOME)
  : process.platform === 'win32' ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'BrowserBridge')
    : join(homedir(), '.local', 'share', 'browser-bridge');
export const DEFAULT_CONFIG = join(DATA_DIR, 'config.json');
export const VERSION = '0.2.0';

export async function loadConfig(path = DEFAULT_CONFIG) {
  let config;
  try { config = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { throw new Error(`Cannot read pairing config ${path}${error.code ? ` (${error.code})` : ''}. Run browser-bridge setup.`, { cause: error }); }
  if (typeof config.token !== 'string' || config.token.length < 32 ||
      !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 ||
      !/^[a-p]{32}$/.test(config.extension_id)) throw new Error('Invalid pairing config. Run browser-bridge setup.');
  return config;
}

export async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  if (process.platform !== 'win32') await chmod(path, 0o600);
}
