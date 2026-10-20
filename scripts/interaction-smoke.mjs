// Private CDP is test setup/observation only. Browser actions use the real extension and Hub.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import { ROOT } from '../src/config.mjs';
import { setup } from '../src/setup.mjs';
import { startHub } from '../src/hub.mjs';
import { BridgeClient } from '../src/client.mjs';

const { values } = parseArgs({ options: { executable: { type: 'string' }, family: { type: 'string', default: 'chromium' }, regressions: { type: 'boolean', default: false }, 'input-capture': { type: 'boolean', default: false }, 'tab-indicators': { type: 'boolean', default: false } } });
if (!values.executable) throw new Error('Pass --executable PATH to a browser that permits --load-extension');
const dir = await mkdtemp(join(tmpdir(), 'bridge-interaction-'));
const rows = Array.from({ length: 200 }, (_, i) => `<li>Row ${i+1}: alpha beta gamma delta epsilon</li>`).join('');
const fixture = `<!doctype html><meta charset="utf-8"><title>Bridge issue probe</title>
<style>#go{position:fixed;left:200px;top:200px;width:120px;height:40px}#state{white-space:pre-wrap}</style>
<button id="go" onclick="window.__count++">Go</button>
<input id="edit" aria-label="Name" style="position:fixed;left:20px;top:20px">
<input id="file" type="file" hidden><button style="position:fixed;left:400px;top:20px" onclick="document.querySelector('#file').click()">Choose file</button>
<div id="state"></div><ul>${rows}</ul>
<script>window.__count=0;window.__events=[];for(const type of ['pointermove','pointerdown','pointerup','click'])document.addEventListener(type,e=>{const r=document.querySelector('#go').getBoundingClientRect();window.__events.push({type,target:e.target.id,x:e.clientX,y:e.clientY,trusted:e.isTrusted,rect:{x:r.x,y:r.y,width:r.width,height:r.height}})},true);</script>`;
const sockets = new Set();
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/slow.js')) { setTimeout(() => { res.setHeader('content-type','application/javascript');res.end('window.slowScriptReady=true;'); }, 1000); return; }
  res.setHeader('content-type','text/html; charset=utf-8');
  if (req.url.startsWith('/ad')) { res.end('<!doctype html><title>Ad frame</title><button>Ad control</button>'); return; }
  if (req.url.startsWith('/slow')) { res.end('<!doctype html><title>Slow probe</title><script src="/slow.js"></script><button id="ready">Ready</button>'); return; }
  res.end(fixture);
});
server.on('connection', socket => { sockets.add(socket);socket.on('close',()=>sockets.delete(socket)); });
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const reserve = http.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
const paired = await setup({ configPath:join(dir,'config.json'), port });
const hub=await startHub(paired.config);
const profile=join(dir,'profile');await mkdir(profile);
const browser=spawn(values.executable,[
 `--user-data-dir=${profile}`,`--disable-extensions-except=${paired.extensionDir}`,`--load-extension=${paired.extensionDir}`,
 '--remote-debugging-port=0','--no-first-run','--no-default-browser-check','--enable-unsafe-extension-debugging','--window-size=1000,800','about:blank',
],{windowsHide:true,stdio:'ignore'});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn, description) { for(let i=0;i<100;i++){const value=await fn();if(value)return value;await pause(100)}throw new Error(description); }
let ws,client,claim;
const results={family:values.family,cases:[],snapshots:[],navigation:null};
try {
 const active=await until(async()=>{try{return(await readFile(join(profile,'DevToolsActivePort'),'utf8')).trim().split(/\r?\n/)}catch{return null}},'DevTools not ready');
 ws=new WebSocket(`ws://127.0.0.1:${active[0]}${active[1]}`);await once(ws,'open');
 const pending=new Map();let serial=0;
 ws.on('message',raw=>{const data=JSON.parse(raw);const p=pending.get(data.id);if(p){pending.delete(data.id);data.error?p.reject(new Error(data.error.message)):p.resolve(data.result)}});
 const cdp=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}))});
 client=new BridgeClient(paired.config);
 if(process.env.BRIDGE_TEST_VERBOSE){const call=client.call.bind(client);client.call=(method,args)=>{console.error(method,args);return call(method,args)};}
 const browserInfo=await until(async()=>{const r=await client.call('list_browsers');return r.browsers[0]},'Extension not connected');
 const worker=await until(async()=>{const r=await cdp('Target.getTargets');return r.targetInfos.find(t=>t.type==='service_worker'&&t.url.includes(paired.config.extension_id))},'Worker missing');
 const {sessionId}=await cdp('Target.attachToTarget',{targetId:worker.targetId,flatten:true});
 const evaluate=async expression=>{const r=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId);if(r.exceptionDetails)throw new Error(r.exceptionDetails.text);return r.result.value;};
 const tab=await evaluate(`chrome.tabs.create({url:${JSON.stringify(base+'/probe')},active:true})`);
 await pause(350);
 const info=(await client.call('list_tabs',{browser_id:browserInfo.browser_id})).tabs.find(t=>t.tab_id===tab.id);
 claim=await client.call('claim_tab',{browser_id:browserInfo.browser_id,tab_id:tab.id,expected_url:info.url,expected_title:info.title});
 const h={tab_handle:claim.tab_handle};
 const page=async expression=>(await evaluate(`chrome.debugger.sendCommand({tabId:${tab.id}},'Runtime.evaluate',{expression:${JSON.stringify(expression)},returnByValue:true,awaitPromise:true})`)).result.value;
 const state=()=>page(`(()=>{const r=document.querySelector('#go')?.getBoundingClientRect();return {count:window.__count,events:window.__events,visibility:document.visibilityState,dpr:devicePixelRatio,rect:r?{x:r.x,y:r.y,width:r.width,height:r.height}:null}})()`);
 const cover=await evaluate(`chrome.tabs.create({url:${JSON.stringify(base+'/cover')},active:false})`);
 const focus = () => evaluate(`chrome.windows.getAll({populate:true}).then(w=>w.map(x=>({id:x.id,focused:x.focused,state:x.state,active:x.tabs.filter(t=>t.active).map(t=>t.id)})).sort((a,b)=>a.id-b.id))`);
 await evaluate(`chrome.tabs.update(${cover.id},{active:true})`);await pause(250);
 const operationsFocus=await focus();
 if (values['tab-indicators']) {
  const nativeTab=await evaluate(`chrome.tabs.get(${tab.id})`);
  const marker=await evaluate(`chrome.tabGroups.get(${nativeTab.groupId})`);
  assert.equal(marker.title,'🤖 被控');assert.equal(marker.color,'green');assert.equal(marker.collapsed,false);
  assert.equal(await page('document.querySelectorAll("[data-local-browser-bridge]").length'),0);
  assert.equal(await page('document.querySelectorAll("[data-local-browser-bridge-click]").length'),0);
  const snap=await client.call('snapshot',h),ref=snap.snapshot.match(/\[([^\]]+)\] button "Go"/)[1];
  assert.equal((await client.call('click',{...h,ref})).target_verified,true);
  assert.equal(await page('document.querySelectorAll("[data-local-browser-bridge]").length'),0);
  await until(()=>page('document.querySelectorAll("[data-local-browser-bridge-click]").length===1'),'transient click visual');
  await client.call('activate_tab',{...h,focus_window:false});
  const shot=await client.call('screenshot',h);
  assert.equal(shot.capture.agent_indicators_included,false);
  await client.call('navigate',{...h,url:base+'/slow'});
  assert.equal((await evaluate(`chrome.tabs.get(${tab.id})`)).groupId,marker.id);
  assert.equal(await page('document.querySelectorAll("[data-local-browser-bridge]").length'),0);
  await client.call('release_tab',h);claim=null;
  assert.equal((await evaluate(`chrome.tabs.get(${tab.id})`)).groupId,-1);
  results.cases.push({scenario:'native_marker_without_page_overlay',marker,screenshot_clean:true,navigation_preserved:true,release_removed:true});

  const original=await evaluate(`chrome.tabs.group({tabIds:[${tab.id},${cover.id}]})`);
  await evaluate(`chrome.tabGroups.update(${original},{title:'User research',color:'blue',collapsed:false})`);
  await evaluate(`chrome.tabs.update(${cover.id},{active:true})`);
  const claimAgain=async()=>{
   const current=(await client.call('list_tabs',{browser_id:browserInfo.browser_id})).tabs.find(t=>t.tab_id===tab.id);
   claim=await client.call('claim_tab',{browser_id:browserInfo.browser_id,tab_id:tab.id,expected_url:current.url,expected_title:current.title});
   assert.equal(claim.visual_warning,undefined);return {tab_handle:claim.tab_handle};
  };
  const groupedHandle=await claimAgain();
  assert.notEqual((await evaluate(`chrome.tabs.get(${tab.id})`)).groupId,original);
  await client.call('release_tab',groupedHandle);claim=null;
  assert.equal((await evaluate(`chrome.tabs.get(${tab.id})`)).groupId,original);
  assert.equal((await evaluate(`chrome.tabGroups.get(${original})`)).title,'User research');
  assert.equal((await evaluate(`chrome.tabs.get(${cover.id})`)).active,true);
  results.cases.push({scenario:'original_group_restored',group_id:original,background_preserved:true});

  const disconnectedHandle=await claimAgain();
  await client.close();client=new BridgeClient(paired.config);
  await until(async()=>(await evaluate(`chrome.tabs.get(${tab.id})`)).groupId===original,'session disconnect group restoration');
  await assert.rejects(client.call('snapshot',disconnectedHandle),/expired/);claim=null;
  results.cases.push({scenario:'session_disconnect_restores_group',restored:true});
 } else if (values['input-capture']) {
  const refFor = (snapshot, role, label) => snapshot.snapshot.match(new RegExp(`\\[([^\\]]+)\\] ${role} "${label}"`))[1];
  const inputRef = async () => refFor(await client.call('snapshot',h),'textbox','Name');
  const buttonRef = async () => refFor(await client.call('snapshot',h),'button','Go');
  // Deterministically suppress browser-native input in a disposable tab. This
  // exercises ignored-input recovery, not an OS menu/tab-drag UI reproduction.
  const suppress = ignore => evaluate(`chrome.debugger.sendCommand({tabId:${tab.id}},'Input.setIgnoreInputEvents',{ignore:${ignore}})`);
  const fill = await client.call('fill',{...h,ref:await inputRef(),text:'native baseline'});
  assert.equal(fill.value_verified,true);
  const key = await client.call('press_key',{...h,key:'Control+A'});
  assert.equal(key.delivery_verified,true);
  results.cases.push({scenario:'native_baseline',fill,key});
  await page('window.__count=0;window.__events=[];true');
  await suppress(true);
  try {
   let clickError;
   try { await client.call('click',{...h,ref:await buttonRef()}); } catch(error) { clickError=error.message; }
   assert.ok(clickError,'suppressed native click must fail');
   assert.equal((await state()).count,0);
   let keyError;
   try { await client.call('press_key',{...h,key:'Z'}); } catch(error) { keyError=error.message; }
   assert.ok(keyError,'suppressed keyboard input must fail');
   assert.equal(await page('document.querySelector("#edit").value'),'native baseline');
   results.cases.push({scenario:'native_input_suppressed',click_error:clickError,key_error:keyError,no_replay:true});
   const focusBefore=await page('document.activeElement.id');
   const domFill=await client.call('fill',{...h,ref:await inputRef(),text:'中文 DOM works',mode:'dom'});
   assert.equal(domFill.value_verified,true);assert.equal(domFill.events_trusted,false);
   assert.equal(await page('document.querySelector("#edit").value'),'中文 DOM works');
   assert.equal(await page('document.activeElement.id'),focusBefore);
   const domClick=await client.call('click',{...h,ref:await buttonRef(),mode:'dom'});
   assert.equal(domClick.events_trusted,false);assert.equal(domClick.method,'dom');
   const observed=await state();assert.equal(observed.count,1);
   assert.equal(observed.events.filter(e=>e.type==='click').at(-1).trusted,false);
   assert.equal(observed.events.filter(e=>e.type==='pointerdown').length,0);
   results.cases.push({scenario:'dom_during_suppression',fill:domFill,click:domClick,observed});
  } finally { await suppress(false); }
  await client.call('fill',{...h,ref:await inputRef(),text:'recovered'});
  await client.call('press_key',{...h,key:'Control+A'});
  assert.equal((await client.call('press_key',{...h,key:'Z'})).delivery_verified,true);
  assert.equal(await page('document.querySelector("#edit").value'),'z');
  assert.equal((await client.call('click',{...h,ref:await buttonRef()})).target_verified,true);
  assert.equal((await state()).count,2);
  assert.equal((await evaluate(`chrome.tabs.get(${tab.id})`)).active,false);
  results.cases.push({scenario:'native_recovered',value:'z',count:2,background:true});
  await page(`document.body.insertAdjacentHTML('beforeend','<textarea aria-label="Extra area" style="position:fixed;left:20px;top:60px"></textarea><div contenteditable="true" role="textbox" aria-label="Rich editor" style="position:fixed;left:20px;top:120px;width:120px;height:50px;white-space:pre-wrap"></div>');true`);
  for (const label of ['Extra area','Rich editor']) {
   for (const mode of ['native','dom']) {
    const snap=await client.call('snapshot',h), text=`${mode} first\n第二行`;
    const result=await client.call('fill',{...h,ref:refFor(snap,'textbox',label),text,mode});
    assert.equal(result.value_verified,true);
    assert.equal(await page(`(()=>{const e=document.querySelector('[aria-label="${label}"]');return ${mode==='dom'?'e.isContentEditable?e.textContent:e.value':'e.isContentEditable?e.innerText:e.value'}})()`),text);
   }
  }
  results.cases.push({scenario:'textarea_and_contenteditable_multiline',modes:['native','dom'],verified:true});
  await page(`window.__frameReady=false;const f=document.createElement('iframe');f.style='position:fixed;left:600px;top:50px';f.onload=()=>{f.contentDocument.body.innerHTML='<input id="child" aria-label="Child input">';window.__frameReady=true};f.src='/ad';document.body.append(f);true`);
  await until(()=>page('window.__frameReady'),'child fixture');
  const childSnap=await client.call('snapshot',h);
  await client.call('fill',{...h,ref:refFor(childSnap,'textbox','Child input'),text:'child text'});
  await client.call('press_key',{...h,key:'Control+A'});
  assert.equal((await client.call('press_key',{...h,key:'Z'})).delivery_verified,true);
  assert.equal(await page('document.querySelector("iframe").contentDocument.querySelector("#child").value'),'z');
  results.cases.push({scenario:'keyboard_delivery_in_child_frame',verified:true});
 } else if (values.regressions) {
  // These actions use only the disposable fixture and the public Bridge API.
  const refFor = snapshot => snapshot.snapshot.match(/\[([^\]]+)\] button "Go"/)[1];
  for (const coordinates of [false, true]) {
   await page('window.__count=0;window.__events=[];true');
   const snap = await client.call('snapshot', h), start = performance.now();
   const result = await client.call('click', {...h, ...(coordinates ? {x:260,y:220} : {ref:refFor(snap)})});
   assert.equal(result.target_verified,true); assert.equal((await state()).count,1);
   assert.equal((await evaluate(`chrome.tabs.get(${tab.id})`)).active,false);
   results.cases.push({scenario:coordinates?'background_coordinate':'background_ref',ms:Math.round(performance.now()-start),target_verified:true});
  }
  await page(`window.__adLoads=0;const ad=document.createElement('iframe');ad.id='ad';ad.style='position:fixed;left:600px;top:20px;width:200px;height:100px';ad.onload=()=>window.__adLoads++;ad.src='/ad';document.body.append(ad);true`);
  await until(()=>page('window.__adLoads>0'),'initial iframe load');
  const snap = await client.call('snapshot',h), mainRef = refFor(snap);
  await page(`document.querySelector('#ad').src='/ad?next';true`);
  await until(()=>page('window.__adLoads>1'),'iframe navigation');
  assert.equal((await client.call('click',{...h,ref:mainRef})).target_verified,true);
  results.cases.push({scenario:'main_ref_survives_iframe_navigation',target_verified:true});
  await page(`window.__adTimer=setInterval(()=>document.querySelector('#ad').src='/ad?tick='+Date.now(),60);true`);
  for(let i=0;i<20;i++) assert.match((await client.call('snapshot',h)).snapshot,/button "Go"/);
  await page(`clearInterval(window.__adTimer);document.querySelector('#ad').remove();true`);
  results.cases.push({scenario:'snapshot_during_iframe_refresh',snapshots:20});
  await client.call('activate_tab', {...h,focus_window:false});
  assert.equal((await evaluate(`chrome.tabs.get(${tab.id})`)).active,true);
  await page(`const style=document.createElement('style');style.textContent='@keyframes drift{from{transform:translateX(-5px)}to{transform:translateX(5px)}}#go{animation:drift 0.7s linear infinite alternate}';document.head.append(style);true`);
  for(let i=0;i<3;i++) {
   await page('window.__count=0;window.__events=[];true');
   const snap=await client.call('snapshot',h),start=performance.now();
   assert.equal((await client.call('click',{...h,ref:refFor(snap)})).target_verified,true);
   const observed=await state();assert.equal(observed.count,1);
   assert.ok(observed.events.some(e=>e.type==='click'&&e.trusted&&e.target==='go'));
   results.cases.push({scenario:'infinite_css_animation',run:i+1,ms:Math.round(performance.now()-start),target_verified:true});
  }
  const opened=await client.call('open_tab',{browser_id:browserInfo.browser_id,url:base+'/ad',active:false});
  await until(async()=>{const tabs=(await client.call('list_tabs',{browser_id:browserInfo.browser_id})).tabs;return tabs.find(t=>t.tab_id===opened.tab_id&&t.title==='Ad frame')},'opened tab loaded');
  const tabs=(await client.call('list_tabs',{browser_id:browserInfo.browser_id})).tabs,created=tabs.find(t=>t.tab_id===opened.tab_id);
  const createdClaim=await client.call('claim_tab',{browser_id:browserInfo.browser_id,tab_id:created.tab_id,expected_url:created.url,expected_title:created.title});
  const ch={tab_handle:createdClaim.tab_handle};
  await client.call('activate_tab',ch);
  assert.equal((await evaluate(`chrome.tabs.get(${created.tab_id})`)).active,true);
  assert.equal((await evaluate(`chrome.windows.get(${created.window_id})`)).focused,true);
  assert.equal((await client.call('close_tab',ch)).closed,true);
  await assert.rejects(client.call('snapshot',ch),/expired/);
  assert.ok(!(await client.call('list_tabs',{browser_id:browserInfo.browser_id})).tabs.some(t=>t.tab_id===created.tab_id));
  results.cases.push({scenario:'open_activate_close_tab',handle_expired:true});
  console.log(JSON.stringify(results.cases));
 } else {
 const backgroundFocus=await evaluate(`chrome.tabs.get(${cover.id})`);
 const nameSnapshot=await client.call('snapshot',h);
 const nameRef=nameSnapshot.snapshot.match(/\[([^\]]+)\] textbox "Name"/)[1];
 await client.call('fill',{...h,ref:nameRef,text:'后台输入'});
 assert.equal(await page('document.querySelector("#edit").value'),'后台输入');
 await client.call('press_key',{...h,key:'Control+A'});await client.call('press_key',{...h,key:'Z'});
 assert.equal(await page('document.querySelector("#edit").value'),'z');
 await client.call('scroll',{...h,x:900,y:500,delta_y:500});assert.ok(await page('scrollY > 0'));
 const file=join(dir,'background.txt');await writeFile(file,'background upload');
 const uploadSnapshot=await client.call('snapshot',h);
 const uploadRef=uploadSnapshot.snapshot.match(/\[([^\]]+)\] button "Choose file"/)[1];
 await client.call('click',{...h,ref:uploadRef});await client.call('upload_file',{...h,files:[file]});
 assert.equal(await page('document.querySelector("#file").files[0].text()'),'background upload');
 assert.equal((await evaluate(`chrome.tabs.get(${tab.id})`)).active,false);
 assert.equal((await evaluate(`chrome.tabs.get(${cover.id})`)).active,backgroundFocus.active);
 const operationsAfter=await focus();
 assert.deepEqual(operationsAfter.map(({focused,...w})=>w),operationsFocus.map(({focused,...w})=>w));
 for(const window of operationsFocus)if(!window.focused)assert.equal(operationsAfter.find(w=>w.id===window.id).focused,false);
 results.background_operations=['fill','press_key','scroll','click chooser','upload_file'];
 const s=await client.call('snapshot',h);
 assert.equal(s.truncated,false);assert.match(s.snapshot,/Row 200:/);assert.doesNotMatch(s.snapshot,/InlineTextBox/);
 results.snapshots.push({node_count:s.node_count,chars:s.snapshot.length,total:s.total_node_count,all_200_rows:true});
 let part=await client.call('snapshot',{...h,max_nodes:10,max_chars:1000}), combined=part.snapshot, pages=1;
 const firstRef=part.snapshot.match(/\[([^\]]+)\] button "Go"/)[1];
 while(part.next_cursor){part=await client.call('snapshot',{...h,cursor:part.next_cursor,max_nodes:10,max_chars:1000});combined+='\n'+part.snapshot;pages++;}
 assert.equal((combined.match(/Row \d+:/g)||[]).length,200);
 await client.call('click',{...h,ref:firstRef});
 results.snapshots.push({pages,all_200_rows:true,first_page_ref_survived:true});
 for(const scenario of ['foreground_ref','background_ref','background_coordinate','occluded_window_ref']){
  let coverWindow;
  if(scenario==='occluded_window_ref'){
   await evaluate(`chrome.tabs.update(${tab.id},{active:true})`);
   coverWindow=await evaluate(`chrome.windows.create({url:${JSON.stringify(base+'/cover-window')},focused:true,width:1100,height:900,left:0,top:0})`);
  }else await evaluate(`chrome.tabs.update(${scenario==='foreground_ref'?tab.id:cover.id},{active:true})`);
  await pause(350);
  const before=await focus();
  for(let run=1;run<=3;run++){
   await page('window.__count=0;window.__events=[];true');
   const snap=await client.call('snapshot',h),ref=snap.snapshot.match(/\[([^\]]+)\] button "Go"/)[1];
   const start=performance.now();
   const result=await client.call('click',{...h,...(scenario==='background_coordinate'?{x:260,y:220}:{ref})});
   const ms=Math.round(performance.now()-start),observed=await state();
   assert.equal(result.target_verified,true);assert.equal(observed.count,1);assert.ok(observed.events.some(e=>e.type==='click'&&e.trusted&&e.target==='go'));
   const after=await focus();
   assert.deepEqual(after.map(({focused,...w})=>w),before.map(({focused,...w})=>w),'Bridge must not activate tabs or change window state');
   for(const window of before)if(!window.focused)assert.equal(after.find(w=>w.id===window.id).focused,false,'Bridge must not bring an unfocused window forward');
   if(scenario.startsWith('background'))assert.equal((await evaluate(`chrome.tabs.get(${tab.id})`)).active,false);
   if(coverWindow)assert.equal(after.find(w=>w.id===tab.windowId).focused,false);
   results.cases.push({scenario,run,ms,visibility:observed.visibility,count:observed.count,focus_not_stolen:true});
   console.log(JSON.stringify(results.cases.at(-1)));
  }
  if(coverWindow)await evaluate(`chrome.windows.remove(${coverWindow.id})`);
 }
 await evaluate(`chrome.tabs.update(${tab.id},{active:true})`);
 for(const zoom of [0.8,1.25]){
  await evaluate(`chrome.tabs.setZoom(${tab.id},${zoom})`);await pause(200);
  await page('window.__count=0;window.__events=[];true');
  const snap=await client.call('snapshot',h),ref=snap.snapshot.match(/\[([^\]]+)\] button "Go"/)[1];
  const result=await client.call('click',{...h,ref});const observed=await state();assert.equal(observed.count,1);
  results.cases.push({scenario:'zoom_ref',zoom,result,observed});
 }
 await evaluate(`chrome.tabs.setZoom(${tab.id},1)`);await pause(150);
 await evaluate(`chrome.debugger.sendCommand({tabId:${tab.id}},'Input.dispatchMouseEvent',{type:'mouseMoved',x:10,y:10})`);
 await page(`window.__count=0;window.__events=[];const b=document.querySelector('#go');b.style.width='40px';b.onmouseenter=()=>{b.style.transform='translateX(30px)';b.onmouseenter=null};true`);
 const hs=await client.call('snapshot',h),hoverRef=hs.snapshot.match(/\[([^\]]+)\] button "Go"/)[1];
 let hoverError;try{await client.call('click',{...h,ref:hoverRef})}catch(error){hoverError=error.message}
 assert.match(hoverError,/target changed/);const hoverState=await state();assert.equal(hoverState.count,0);
 results.cases.push({scenario:'hover_shift_30px',error:hoverError,observed:hoverState});
 await page(`(()=>{window.__shadowCount=0;const host=document.createElement('div');host.style='position:fixed;left:500px;top:150px';document.body.append(host);const root=host.attachShadow({mode:'closed'});const b=document.createElement('button');b.textContent='Closed control';b.onclick=()=>window.__shadowCount++;root.append(b);return true})()`);
 const shadowSnapshot=await client.call('snapshot',h);
 const shadowRef=shadowSnapshot.snapshot.match(/\[([^\]]+)\] button "Closed control"/)[1];
 assert.equal((await client.call('click',{...h,ref:shadowRef})).target_verified,true);
 assert.equal(await page('window.__shadowCount'),1);
 assert.equal(await page('Object.getOwnPropertyNames(window).filter(n=>n.startsWith("__bridgeClick_")).length'),0);
 results.cases.push({scenario:'closed_shadow_target',target_verified:true,count:1,page_binding_exposed:false});
 // A verified click may destroy its own execution context through normal link navigation.
 await page(`(()=>{const a=document.createElement('a');a.href='/slow';a.textContent='Open slow';a.style='position:fixed;left:500px;top:100px';document.body.append(a);return true})()`);
 const linkSnapshot=await client.call('snapshot',h);
 const linkRef=linkSnapshot.snapshot.match(/\[([^\]]+)\] link "Open slow"/)[1];
 assert.equal((await client.call('click',{...h,ref:linkRef})).target_verified,true);
 await until(async()=>{try{return await page('!!document.querySelector("#ready")')}catch{return false}},'link destination');
 results.cases.push({scenario:'click_link_navigation',target_verified:true,destination_ready:true});
 await evaluate(`chrome.tabs.update(${cover.id},{active:true})`);
 const navigationFocus=await focus(), start=performance.now();
 const nav=await client.call('navigate',{...h,url:base+'/slow'});
 const ms=performance.now()-start;const immediate=await page(`({ready:document.readyState,hasTarget:!!document.querySelector('#ready'),title:document.title})`);
 const immediateSnapshot=await client.call('snapshot',h);
 assert.ok(nav.snapshot.includes('\"Ready\"'));assert.equal(nav.title,'Slow probe');assert.equal(nav.url,base+'/slow');assert.equal(immediate.hasTarget,true);
 assert.deepEqual((await focus()).map(({focused,...w})=>w),navigationFocus.map(({focused,...w})=>w));
 assert.equal((await evaluate(`chrome.tabs.get(${tab.id})`)).active,false);
 await pause(50);
 const later=await page(`({ready:document.readyState,hasTarget:!!document.querySelector('#ready'),title:document.title})`);
 results.navigation={ms:Math.round(ms),result:nav,immediate,later,immediate_snapshot_has_ready:immediateSnapshot.snapshot.includes('"Ready"')};
 const fragment=await client.call('navigate',{...h,url:base+'/slow#fragment',include_snapshot:false});
 assert.equal(fragment.same_document,true);assert.equal(fragment.snapshot,undefined);assert.equal(fragment.url,base+'/slow#fragment');
 }
 results.browser=browserInfo.user_agent;results.extension_version=browserInfo.extension_version;
 console.log(JSON.stringify({tab_indicators:values['tab-indicators']?results.cases:undefined,input_capture:values['input-capture']?results.cases:undefined,snapshots:results.snapshots,background_operations:results.background_operations,
  hover:results.cases.find(c=>c.scenario==='hover_shift_30px'),navigation:results.navigation}));
 if(claim)await client.call('release_tab',{tab_handle:claim.tab_handle});claim=null;
} finally {
 if(claim)await client?.call('release_tab',{tab_handle:claim.tab_handle}).catch(()=>{});
 await client?.close();ws?.close();browser.kill();await hub.close();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));
 await mkdir(join(ROOT,'test-results'),{recursive:true});
  await writeFile(join(ROOT,'test-results',`${values['tab-indicators']?'tab-indicators':values['input-capture']?'input-capture':values.regressions?'regressions':'interaction'}-${values.family}.json`),JSON.stringify(results,null,2));
 await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}).catch(()=>{});
}
