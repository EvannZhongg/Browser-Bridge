import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { ROOT, VERSION } from '../src/config.mjs';

for (const path of ['package.json', 'extension/manifest.json']) {
  if (JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), 'utf8')).version !== VERSION) throw new Error(`Version mismatch: ${path}`);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = JSON.parse(execFileSync(npm, ['pack', '--dry-run', '--ignore-scripts', '--json'], {
  cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'],
}))[0];
const names = result.files.map(file => file.path);
for (const path of names) {
  if (/config\.generated\.js|(^|\/)(\.local|\.venv|test-results|node_modules)\//.test(path)) throw new Error(`Private file included in package: ${path}`);
}
for (const path of ['extension/connection.js', 'extension/version.js', 'extension/errors.js', 'extension/page-url.js']) if (!names.includes(path)) throw new Error(`Package is missing ${path}`);
for (const path of ['src/hub-runtime.mjs', 'extension/observation.js', 'extension/pointer.js', 'extension/dialogs.js', 'extension/network.js', 'extension/log-data.js', 'extension/fetch-page.js', 'extension/screenshot.js', 'extension/upload.js']) if (!names.includes(path)) throw new Error(`Package is missing ${path}`);
for (const path of ['bin/browser-attach.mjs', 'src/mcp.mjs', 'src/hub.mjs', 'extension/manifest.json', 'extension/evaluate.js', 'extension/fetch.js', 'extension/locator.js', 'extension/batch.js', 'extension/wait.js', 'extension/outcomes.js', 'extension/scroll.js', 'extension/drag.js', 'extension/text.js', 'extension/diagnostics.js', 'extension/sessions.js', 'extension/actionability.js', 'extension/limits.js', 'extension/icons/BrowserAttach.png']) {
  if (!names.includes(path)) throw new Error(`Package is missing ${path}`);
}
console.log(`Package boundary verified (${names.length} files, no generated pairing secret).`);
