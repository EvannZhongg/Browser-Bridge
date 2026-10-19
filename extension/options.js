chrome.storage.local.get('profileName').then(result => { document.querySelector('#profile').value = result.profileName || ''; });
document.querySelector('form').onsubmit = async event => {
  event.preventDefault();
  const profileName = document.querySelector('#profile').value.trim();
  if (!profileName) return;
  await chrome.storage.local.set({ profileName });
  await chrome.runtime.sendMessage({ type: 'reconnect' });
  document.querySelector('#saved').textContent = '已保存，连接正在更新。';
};
