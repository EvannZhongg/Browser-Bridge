import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { queryElement, targetOptions, resolveSelector, resolveFrame } from '../extension/locator.js';
import { deadline } from '../extension/actionability.js';

test('explicit nth selects CSS/XPath document order; omission remains strict', () => {
  const elements = [{ nodeType: 1, id: 'first' }, { nodeType: 1, id: 'second' }];
  const query = vm.runInNewContext(`(${queryElement.toString()})`, { document: {
    querySelectorAll: () => elements,
    evaluate: () => ({ snapshotLength: 2, snapshotItem: n => elements[n] }),
  }, XPathResult: { ORDERED_NODE_SNAPSHOT_TYPE: 7 } });
  for (const type of ['css', 'xpath']) {
    assert.throws(() => query('input', type), /matched 2/);
    assert.equal(query('input', type, 0), elements[0]);
    assert.equal(query('input', type, 1), elements[1]);
    assert.throws(() => query('input', type, 2), /out of range.*matched 2/);
    assert.equal(query('input', type, 2, true), null);
  }
  for (const args of [{ ref: 'a', nth: 0 }, { x: 1, y: 1, nth: 0 }, { selector: 'input', nth: -1 }, { selector: 'input', nth: 1.5 }]) {
    assert.throws(() => targetOptions(args, { coordinates: true }), /nth/);
  }
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
