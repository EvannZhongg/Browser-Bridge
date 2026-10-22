import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { queryElement, targetOptions, resolveSelector, resolveFrame } from '../extension/locator.js';
import { deadline } from '../extension/actionability.js';

test('explicit nth selects CSS/XPath document order; omission remains strict', () => {
  const elements = ['first', 'second'].map((id, index) => ({ nodeType: 1, id, tagName: 'BUTTON', textContent: `Choice ${index}`,
    matches: () => index === 1, closest: () => null, getBoundingClientRect: () => ({ width: 10, height: index ? 0 : 10 }),
    ownerDocument: { defaultView: { getComputedStyle: () => ({ visibility: 'visible' }) } } }));
  const query = vm.runInNewContext(`(${queryElement.toString()})`, { document: {
    querySelectorAll: () => elements,
    evaluate: () => ({ snapshotLength: 2, snapshotItem: n => elements[n] }),
  }, XPathResult: { ORDERED_NODE_SNAPSHOT_TYPE: 7 } });
  for (const type of ['css', 'xpath']) {
    assert.throws(() => query('input', type), error => {
      assert.match(error.message, /matched 2/);
      assert.match(error.message, /"nth":0,"tag":"button","text":"Choice 0","disabled":false,"visible":true/);
      assert.match(error.message, /"nth":1,"tag":"button","text":"Choice 1","disabled":true,"visible":false/);
      return true;
    });
    assert.equal(query('input', type, 0), elements[0]);
    assert.equal(query('input', type, 1), elements[1]);
    assert.throws(() => query('input', type, 2), /out of range.*matched 2/);
    assert.equal(query('input', type, 2, true), null);
  }
  for (const args of [{ ref: 'a', nth: 0 }, { x: 1, y: 1, nth: 0 }, { selector: 'input', nth: -1 }, { selector: 'input', nth: 1.5 }]) {
    assert.throws(() => targetOptions(args, { coordinates: true }), /nth/);
  }
});

test('ambiguity previews bound candidate count and text without losing total match count', () => {
  const element = { nodeType: 1, tagName: 'DIV', textContent: 'x'.repeat(1000), matches: () => false, closest: () => null,
    getBoundingClientRect: () => ({ width: 10, height: 10 }), ownerDocument: { defaultView: { getComputedStyle: () => ({ visibility: 'visible' }) } } };
  const query = vm.runInNewContext(`(${queryElement.toString()})`, { document: { querySelectorAll: () => Array(100).fill(element) } });
  assert.throws(() => query('div'), error => {
    assert.match(error.message, /matched 100/); assert.match(error.message, /90 more omitted/);
    assert.equal((error.message.match(/"nth":/g) || []).length, 10);
    assert.ok(error.message.length < 2500); return true;
  });
});

test('selector preparation waits for a later-rendered option, but never retries ambiguity or dispatches input', async () => {
  let samples = 0;
  const calls = [];
  const cdp = async (target, method) => {
    calls.push(method);
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
    if (method === 'Runtime.evaluate') return ++samples < 3 ? { result: { subtype: 'null', value: null } } : { result: { objectId: 'option' } };
    if (method === 'DOM.describeNode') return { node: { backendNodeId: 2 } };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'page-option' } };
  };
  const sessions = { frames: async () => [{ id: 'main' }], target: () => ({ tabId: 1 }) };
  const value = result => { if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); return result.result?.value; };
  const node = await resolveSelector(cdp, value, sessions, 1, { selector: '.option' }, deadline(500));
  assert.equal(samples, 3); assert.equal(node.objectId, 'page-option');
  assert.ok(!calls.some(method => method.startsWith('Input.')));
  let attempts = 0;
  await assert.rejects(resolveSelector(async (target, method) => method === 'Runtime.evaluate'
    ? (attempts++, { exceptionDetails: { text: 'Selector must match exactly one element; matched 2' } })
    : { executionContextId: 1 }, value, sessions, 1, { selector: '.option' }, deadline(500)), /matched 2/);
  assert.equal(attempts, 1);
  await assert.rejects(resolveSelector(async (target, method) => method === 'Runtime.evaluate'
    ? { result: { subtype: 'null', value: null } } : { executionContextId: 1 }, value, sessions, 1, { selector: '.missing' }, deadline(100)), /no input was dispatched/);
});


test('frame paths resolve each strict iframe selector, and exact URL/title match must be unique', async () => {
  const frames=[{id:'main',url:'https://test/'},{id:'child',url:'https://test/child'},{id:'nested',url:'https://test/nested'}];
  let current='main',paths=0;
  const sessions={frames:async()=>frames,target:(tabId,frameId)=>({tabId,frameId})};
  const cdp=async(target,method,args)=>{
    if(method==='Page.createIsolatedWorld'){current=args.frameId;return {executionContextId:args.frameId}}
    if(method==='Runtime.evaluate')return args.expression==='document.title'?{result:{value:current==='nested'?'Inner':'Outer'}}:{result:{objectId:`owner-${++paths}`}};
    if(method==='DOM.describeNode')return {node:{nodeName:'IFRAME',frameId:current==='main'?'child':'nested'}};
    return {};
  };
  const value=result=>result.result?.value;
  assert.equal(await resolveFrame(cdp,value,sessions,9,{frame:{path:['iframe[title="Outer"]','iframe[title="Inner"]']}},deadline(500)),'nested');
  assert.equal(paths,2);
  assert.equal(await resolveFrame(cdp,value,sessions,9,{frame:{url:'https://test/nested'}},deadline(500)),'nested');
  assert.equal(await resolveFrame(cdp,value,sessions,9,{frame:{title:'Inner'}},deadline(500)),'nested');
  await assert.rejects(resolveFrame(async(target,method,args)=>method==='Runtime.evaluate'?{result:{value:'Same'}}:cdp(target,method,args),value,sessions,9,{frame:{title:'Same'}},deadline(500)),/matched 2/);
  assert.throws(()=>targetOptions({selector:'button',frame_id:'old',frame:{title:'Inner'}}),/never both/);
});
