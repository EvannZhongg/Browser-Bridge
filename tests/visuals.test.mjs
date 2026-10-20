import test from 'node:test';
import assert from 'node:assert/strict';
import { createVisuals } from '../extension/visuals.js';

function fixture() {
  const tabs = new Map([1, 2, 3].map(id => [id, { id, windowId: 7, groupId: -1, active: id === 3, pinned: false }]));
  const groups = new Map(), calls = [];
  let serial = 100, saved = {};
  const prune = () => { for (const id of groups.keys()) if (![...tabs.values()].some(tab => tab.groupId === id)) groups.delete(id); };
  const api = {
    storage: { session: { get: async () => structuredClone(saved), set: async value => { saved = structuredClone(value); } } },
    action: Object.fromEntries(['setBadgeText', 'setBadgeBackgroundColor', 'setTitle'].map(method => [method, async args => { calls.push({ method, args }); }])),
    tabs: {
      get: async id => { if (!tabs.has(id)) throw new Error('Tab closed'); return structuredClone(tabs.get(id)); },
      group: async ({ tabIds, groupId }) => {
        groupId ??= ++serial;
        if (!groups.has(groupId)) groups.set(groupId, { id: groupId, windowId: tabs.get(tabIds[0]).windowId, title: '', color: 'grey', collapsed: false });
        for (const id of tabIds) tabs.get(id).groupId = groupId;
        prune(); calls.push({ method: 'group', tabIds, groupId }); return groupId;
      },
      ungroup: async id => { tabs.get(id).groupId = -1; prune(); calls.push({ method: 'ungroup', id }); },
    },
    tabGroups: {
      get: async id => { if (!groups.has(id)) throw new Error('Group removed'); return structuredClone(groups.get(id)); },
      update: async (id, args) => { Object.assign(groups.get(id), args); calls.push({ method: 'update', id, args }); },
    },
  };
  return { api, tabs, groups, calls, saved: () => saved, visuals: createVisuals(api) };
}

test('unclaimed tabs keep their layout; claimed tabs get individual native markers and release removes them', async () => {
  const f = fixture();
  await f.visuals.install(1); await f.visuals.install(2);
  assert.notEqual(f.tabs.get(1).groupId, f.tabs.get(2).groupId);
  assert.equal(f.groups.get(f.tabs.get(1).groupId).title, '');
  assert.equal(f.groups.get(f.tabs.get(2).groupId).color, 'red');
  assert.equal(f.tabs.get(3).groupId, -1); assert.equal(f.tabs.get(3).active, true);
  await f.visuals.remove(1);
  assert.equal(f.tabs.get(1).groupId, -1); assert.equal(f.groups.size, 1);
  await f.visuals.remove(2); assert.equal(f.groups.size, 0);
  assert.deepEqual(f.saved().browserAttachTabIndicators, []);
});

test('release restores an existing original group and preserves user edits to that group', async () => {
  const f = fixture();
  const original = await f.api.tabs.group({ tabIds: [1, 3] });
  await f.api.tabGroups.update(original, { title: 'Research', color: 'blue', collapsed: false });
  await f.visuals.install(1);
  await f.api.tabGroups.update(original, { title: 'Renamed by user' });
  await f.visuals.remove(1);
  assert.equal(f.tabs.get(1).groupId, original);
  assert.equal(f.groups.get(original).title, 'Renamed by user');
});

test('empty original groups are recreated once and all claimed members rejoin them', async () => {
  const f = fixture();
  const original = await f.api.tabs.group({ tabIds: [1, 2] });
  await f.api.tabGroups.update(original, { title: 'Research', color: 'blue', collapsed: true });
  await f.visuals.install(1); await f.visuals.install(2);
  assert.equal(f.groups.has(original), false);
  await Promise.all([f.visuals.remove(1), f.visuals.remove(2)]);
  const restored = f.tabs.get(1).groupId;
  assert.equal(f.tabs.get(2).groupId, restored);
  assert.deepEqual(f.groups.get(restored), { id: restored, windowId: 7, title: 'Research', color: 'blue', collapsed: true });
});

test('user regrouping, renaming and window moves are not undone by release', async () => {
  const f = fixture();
  await f.visuals.install(1);
  const manualGroup = await f.api.tabs.group({ tabIds: [1, 3] });
  await f.visuals.remove(1); assert.equal(f.tabs.get(1).groupId, manualGroup);
  await f.visuals.install(2);
  const marker = f.tabs.get(2).groupId;
  await f.api.tabGroups.update(marker, { title: 'User group' });
  await f.visuals.remove(2); assert.equal(f.tabs.get(2).groupId, marker);
  await f.visuals.install(2);
  f.tabs.get(2).windowId = 8;
  await f.visuals.remove(2); assert.equal(f.tabs.get(2).groupId, -1);
});

test('extension restart cleans surviving markers and recovers previous groups from session storage', async () => {
  const f = fixture();
  const original = await f.api.tabs.group({ tabIds: [1, 2] });
  await f.api.tabGroups.update(original, { title: 'Before reload', color: 'purple', collapsed: false });
  await f.visuals.install(1); await f.visuals.install(2);
  // A fresh controller has no claims, but the same browser session/groups.
  const restarted = createVisuals(f.api);
  await restarted.remove(1);
  assert.equal(f.tabs.get(1).groupId, f.tabs.get(2).groupId);
  assert.equal(f.groups.get(f.tabs.get(1).groupId).title, 'Before reload');
  assert.deepEqual(f.saved().browserAttachTabIndicators, []);
});

test('pinned tabs report the native grouping limitation without unpinning or moving the tab', async () => {
  const f = fixture(); f.tabs.get(1).pinned = true;
  await assert.rejects(f.visuals.install(1), /Pinned tabs/);
  assert.equal(f.tabs.get(1).pinned, true); assert.equal(f.tabs.get(1).groupId, -1);
  assert.equal(f.groups.size, 0);
  await f.visuals.remove(1);
  assert.ok(f.calls.some(call => call.method === 'setBadgeText' && call.args.text === ''));
});

test('partial group setup failure rolls back to the original group even when it became empty', async () => {
  const f = fixture();
  const original = await f.api.tabs.group({ tabIds: [1] });
  await f.api.tabGroups.update(original, { title: 'Original', color: 'yellow', collapsed: false });
  const update = f.api.tabGroups.update;
  f.api.tabGroups.update = (id, args) => args.title === '' ? Promise.reject(new Error('Marker failed')) : update(id, args);
  await assert.rejects(f.visuals.install(1), /Marker failed/);
  assert.equal(f.groups.get(f.tabs.get(1).groupId).title, 'Original');
  assert.deepEqual(f.saved().browserAttachTabIndicators, []);
});
