import test from 'node:test';
import assert from 'node:assert/strict';
import { createNavigation } from '../extension/navigation.js';
import { clippedPoint } from '../extension/click.js';

test('navigation matches loader and frame even when lifecycle events arrive before the command response', async () => {
  let navigation;
  navigation = createNavigation(async () => {
    navigation.event(9, 'Page.lifecycleEvent', { frameId: 'main', loaderId: 'old', name: 'load' });
    navigation.event(9, 'Page.lifecycleEvent', { frameId: 'child', loaderId: 'new', name: 'load' });
    navigation.event(9, 'Page.lifecycleEvent', { frameId: 'main', loaderId: 'new', name: 'DOMContentLoaded' });
    return { frameId: 'main', loaderId: 'new' };
  });
  assert.equal((await navigation.navigate(9, 'http://test/')).wait_until, 'domcontentloaded');
  await assert.rejects(navigation.navigate(9, 'http://test/', { wait_until: 'load', timeout_ms: 100 }), /did not reach load/);
});

test('same-document navigation and commit do not wait for a new load; failures and deadlines release the waiter', async () => {
  const same = createNavigation(async () => ({ frameId: 'main' }));
  assert.equal((await same.navigate(9, 'http://test/#next')).same_document, true);
  const commit = createNavigation(async () => ({ frameId: 'main', loaderId: 'new' }));
  assert.equal((await commit.navigate(9, 'http://test/', { wait_until: 'commit' })).same_document, false);
  await assert.rejects(createNavigation(async () => ({ errorText: 'net::ERR_FAILED' })).navigate(9, 'http://test/'), /ERR_FAILED/);
  const hung = createNavigation(() => new Promise(() => {}));
  await assert.rejects(hung.navigate(9, 'http://test/', { timeout_ms: 100 }), /may still be loading/);
  hung.cancel(9);
});

test('quad clipping chooses a point inside the visible polygon, including partially offscreen and rotated elements', () => {
  const view = { width: 100, height: 100 };
  assert.deepEqual(clippedPoint([-100, 20, 20, 20, 20, 60, -100, 60], view), { x: 10, y: 40 });
  assert.equal(clippedPoint([-100, -100, -10, -100, -10, -10, -100, -10], view), null);
  const point = clippedPoint([50, -50, 150, 50, 50, 150, -50, 50], view);
  assert.ok(point.x > 49 && point.x < 51 && point.y > 49 && point.y < 51);
});


test('history back waits for the selected entry lifecycle even if commit arrives before the command reply', async () => {
  const calls=[];let navigation;
  navigation=createNavigation(async(tab,method,params)=>{
    calls.push({method,params});
    if(method==='Page.getNavigationHistory')return {currentIndex:1,entries:[{id:7,url:'https://test/list'},{id:9,url:'https://test/detail'}]};
    if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'main'}}};
    navigation.event(9,'Page.frameNavigated',{frame:{id:'main',loaderId:'back'}});
    navigation.event(9,'Page.lifecycleEvent',{frameId:'main',loaderId:'back',name:'load'});return {};
  });
  const result=await navigation.navigate(9,undefined,{direction:'back',wait_until:'load'});
  assert.equal(result.navigated_to,'https://test/list');assert.equal(result.same_document,false);
  assert.deepEqual(calls.find(c=>c.method==='Page.navigateToHistoryEntry').params,{entryId:7});
  await assert.rejects(navigation.navigate(9,undefined,{direction:'forward'}),/No forward/);
});

test('history same-document and BFCache restoration complete without waiting for a new DOMContentLoaded', async () => {
  for(const same of [true,false]) {
    let navigation;navigation=createNavigation(async(tab,method)=>{
      if(method==='Page.getNavigationHistory')return {currentIndex:1,entries:[{id:1,url:'https://test/previous'},{id:2,url:'https://test/current'}]};
      if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'main'}}};
      if(same)navigation.event(9,'Page.navigatedWithinDocument',{frameId:'main'});
      else navigation.event(9,'Page.frameNavigated',{frame:{id:'main',loaderId:'cached'},type:'BackForwardCacheRestore'});
      return {};
    });
    assert.equal((await navigation.navigate(9,undefined,{direction:'back',timeout_ms:100})).same_document,same);
  }
});

test('URL navigation follows a replacement main loader, ignoring old and child lifecycle events', async () => {
  let navigation, calls = 0;
  navigation = createNavigation(async () => {
    calls++;
    navigation.event(9, 'Page.frameNavigated', { frame: { id: 'main', loaderId: 'first' } });
    navigation.event(9, 'Page.frameNavigated', { frame: { id: 'main', loaderId: 'final' } });
    navigation.event(9, 'Page.lifecycleEvent', { frameId: 'main', loaderId: 'first', name: 'load' });
    navigation.event(9, 'Page.lifecycleEvent', { frameId: 'child', loaderId: 'final', name: 'load' });
    setTimeout(() => navigation.event(9, 'Page.lifecycleEvent', { frameId: 'main', loaderId: 'final', name: 'load' }), 25);
    return { frameId: 'main', loaderId: 'first' };
  });
  await navigation.navigate(9, 'https://fixture.test/', { wait_until: 'load', timeout_ms: 100 });
  assert.equal(calls, 1);
});

test('a later commit cannot claim the lifecycle satisfied by the preceding document', async () => {
  const navigation = createNavigation(async () => ({ frameId: 'main', loaderId: 'first' }));
  const pending = navigation.navigate(9, 'https://fixture.test/', { wait_until: 'load', timeout_ms: 100 });
  await new Promise(resolve => setImmediate(resolve));
  navigation.event(9, 'Page.lifecycleEvent', { frameId: 'main', loaderId: 'first', name: 'load' });
  navigation.event(9, 'Page.frameNavigated', { frame: { id: 'main', loaderId: 'later' } });
  assert.equal((await pending).document.loaderId, 'first');
});
