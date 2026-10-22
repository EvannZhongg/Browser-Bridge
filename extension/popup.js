async function refresh() {
  const result = await chrome.runtime.sendMessage({ type: 'status' });
  document.querySelector('#status').textContent = result.status === 'connected' ? '已连接本地 MCP 服务' : '尚未连接：请先启动 MCP';
  document.querySelector('#profile').textContent = `${result.browser.family} · ${result.browser.profile_name}`;
  document.querySelector('#claims').textContent = `正在控制 ${result.claims} 个标签页`;
}
document.querySelector('#release').onclick = async () => {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'release_all' });
    await refresh();
    if (!result.ok) document.querySelector('#status').textContent = `释放失败：${result.error}`;
  } catch (error) { document.querySelector('#status').textContent = `释放失败：${error.message}`; }
};
document.querySelector('#reconnect').onclick = async () => { await chrome.runtime.sendMessage({ type: 'reconnect' }); await refresh(); };
document.querySelector('#settings').onclick = () => chrome.runtime.openOptionsPage();
refresh().catch(error => { document.querySelector('#status').textContent = error.message; });
