// Native tab-strip indicators only. No page scripts, DOM nodes or click overlays.
const STORAGE_KEY = 'browserAttachTabIndicators';
const TITLE = '🔴';
const COLOR = 'red';

export function createVisuals(api) {
  const records = new Map();
  let writes = Promise.resolve();
  let restores = Promise.resolve();
  const persist = () => {
    writes = writes.catch(() => {}).then(() => api.storage.session.set({ [STORAGE_KEY]: [...records.entries()] }));
    return writes;
  };
  async function badge(tabId, controlled) {
    await api.action.setBadgeText({ tabId, text: controlled ? 'RUN' : '' });
    await api.action.setTitle({ tabId, title: controlled ? 'Agent 正在接管此标签页' : 'BrowserAttach' });
    if (controlled) await api.action.setBadgeBackgroundColor({ tabId, color: '#12634f' });
  }
  async function restore(tabId) {
    const record = records.get(tabId);
    if (!record) return;
    let tab;
    try { tab = await api.tabs.get(tabId); } catch { /* Closed tabs have nothing to restore. */ }
    // Restore only our own unchanged group. A user move/rename takes precedence.
    let current;
    if (tab && tab.groupId === record.groupId) {
      try { current = await api.tabGroups.get(record.groupId); } catch { /* Group was removed. */ }
    }
    if (current && (!record.applied || (current.title === TITLE && current.color === COLOR))) {
      const original = record.previousGroup;
      if (!original || tab.windowId !== record.windowId) await api.tabs.ungroup(tabId);
      else {
        let group;
        try { group = await api.tabGroups.get(original.id); } catch { /* The original group may have become empty. */ }
        if (group?.windowId !== tab.windowId) group = null;
        let groupId = group?.id;
        if (groupId == null) {
          const originalId = original.id;
          groupId = await api.tabs.group({ tabIds: [tabId] });
          await api.tabGroups.update(groupId, { title: original.title, color: original.color, collapsed: original.collapsed });
          // Other claimed tabs from the same now-empty group must rejoin it.
          for (const other of records.values()) {
            if (other.previousGroup?.id === originalId && other.windowId === record.windowId) other.previousGroup.id = groupId;
          }
        } else await api.tabs.group({ tabIds: [tabId], groupId });
      }
    }
    records.delete(tabId);
    await persist();
    await badge(tabId, false).catch(() => {});
  }
  // An extension reload loses debugger claims, but browser groups survive. Keep
  // enough session state to clean them up before accepting new claims.
  const ready = (async () => {
    const saved = await api.storage.session.get(STORAGE_KEY);
    for (const [tabId, record] of saved[STORAGE_KEY] || []) records.set(tabId, record);
    for (const tabId of [...records.keys()]) await restore(tabId);
  })();
  ready.catch(() => {});

  async function install(tabId) {
    await ready;
    await badge(tabId, true);
    const tab = await api.tabs.get(tabId);
    if (tab.pinned) throw new Error('Pinned tabs cannot display a native tab-group marker. Unpin the tab before claiming to show 🔴; the extension RUN badge remains available.');
    let previousGroup = null;
    if (tab.groupId >= 0) {
      const group = await api.tabGroups.get(tab.groupId);
      previousGroup = { id: group.id, title: group.title || '', color: group.color, collapsed: group.collapsed };
    }
    const groupId = await api.tabs.group({ tabIds: [tabId] });
    const record = { groupId, windowId: tab.windowId, previousGroup, applied: false };
    records.set(tabId, record);
    try {
      await persist();
      await api.tabGroups.update(groupId, { title: TITLE, color: COLOR, collapsed: false });
      record.applied = true;
      await persist();
    } catch (error) {
      // Roll back an incomplete marker even if setting its title failed.
      try { await restore(tabId); } catch { /* Keep the record for later release/recovery. */ }
      throw error;
    }
  }
  async function remove(tabId) {
    await ready;
    const next = restores.catch(() => {}).then(() => restore(tabId));
    restores = next;
    await next;
    await badge(tabId, false).catch(() => {});
  }
  return { install, remove, forget: tabId => { void remove(tabId).catch(() => {}); } };
}
