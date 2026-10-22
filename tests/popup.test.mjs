import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../extension/popup.js', import.meta.url), 'utf8');

test('popup shows the release error with the remaining claim count and refreshes after an explicit retry', async () => {
  const elements = new Map(['status', 'profile', 'claims', 'release', 'reconnect', 'settings'].map(id => [`#${id}`, {}]));
  let failed = true;
  const messages = [];
  vm.runInNewContext(source, {
    document: { querySelector: selector => elements.get(selector) },
    chrome: { runtime: { sendMessage: async message => {
      messages.push(message.type);
      if (message.type === 'release_all') return failed ? { ok: false, error: 'detach failed' } : { ok: true };
      return { status: 'connected', browser: { family: 'chrome', profile_name: 'Chrome' }, claims: failed ? 1 : 0 };
    } } },
  });
  await elements.get('#release').onclick();
  assert.equal(elements.get('#status').textContent, '释放失败：detach failed');
  assert.equal(elements.get('#claims').textContent, '正在控制 1 个标签页');
  failed = false;
  await elements.get('#release').onclick();
  assert.equal(elements.get('#status').textContent, '已连接本地 MCP 服务');
  assert.equal(elements.get('#claims').textContent, '正在控制 0 个标签页');
  assert.equal(messages.filter(type => type === 'release_all').length, 2);
});

test('popup displays a rejected release message without an unhandled rejection', async () => {
  const elements = new Map(['status', 'profile', 'claims', 'release', 'reconnect', 'settings'].map(id => [`#${id}`, {}]));
  vm.runInNewContext(source, {
    document: { querySelector: selector => elements.get(selector) },
    chrome: { runtime: { sendMessage: async message => {
      if (message.type === 'release_all') throw new Error('message channel closed');
      return { status: 'connected', browser: { family: 'edge', profile_name: 'Edge' }, claims: 1 };
    } } },
  });
  await elements.get('#release').onclick();
  assert.equal(elements.get('#status').textContent, '释放失败：message channel closed');
});
