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
import { AttachClient } from '../src/client.mjs';

const { values } = parseArgs({ options: { executable: { type: 'string' }, family: { type: 'string', default: 'chromium' }, headless: { type: 'boolean', default: false }, primitives: { type: 'boolean', default: false }, extended: { type: 'boolean', default: false }, forms: { type: 'boolean', default: false }, regressions: { type: 'boolean', default: false }, 'input-capture': { type: 'boolean', default: false }, 'tab-indicators': { type: 'boolean', default: false } } });
if (!values.executable) throw new Error('Pass --executable PATH to a browser that permits --load-extension');
const dir = await mkdtemp(join(tmpdir(), 'attach-interaction-'));
const rows = Array.from({ length: 200 }, (_, i) => `<li>Row ${i+1}: alpha beta gamma delta epsilon</li>`).join('');
const fixture = `<!doctype html><meta charset="utf-8"><title>Attach issue probe</title>
<style>#go{position:fixed;left:200px;top:200px;width:120px;height:40px}#state{white-space:pre-wrap}</style>
<button id="go" onclick="window.__count++">Go</button>
<input id="edit" aria-label="Name" style="position:fixed;left:20px;top:20px">
<input id="file" type="file" hidden><button style="position:fixed;left:400px;top:20px" onclick="document.querySelector('#file').click()">Choose file</button>
<div id="state"></div><ul>${rows}</ul>
<script>window.__count=0;window.__events=[];for(const type of ['pointermove','pointerdown','pointerup','click'])document.addEventListener(type,e=>{const r=document.querySelector('#go').getBoundingClientRect();window.__events.push({type,target:e.target.id,x:e.clientX,y:e.clientY,trusted:e.isTrusted,rect:{x:r.x,y:r.y,width:r.width,height:r.height}})},true);</script>`;
const sockets = new Set();
const reactSources = values.forms ? await Promise.all([
 'https://unpkg.com/react@18.3.1/umd/react.development.js',
 'https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js',
].map(async url => { const r = await fetch(url); if (!r.ok) throw new Error(`React fixture dependency: ${r.status}`); return r.text(); })) : [];
const extendedFixture = values.extended ? await readFile(join(ROOT, 'tests/fixtures/extended.html'), 'utf8') : '';
const primitivesFixture = values.primitives ? await readFile(join(ROOT, 'tests/fixtures/primitives.html'), 'utf8') : '';
const formFixture = values.forms ? await readFile(join(ROOT, 'tests/fixtures/controlled-form.html'), 'utf8') : '';
const server = http.createServer((req, res) => {
  if (req.url === '/react.js' || req.url === '/react-dom.js') { res.setHeader('content-type', 'text/javascript'); res.end(reactSources[req.url === '/react.js' ? 0 : 1]); return; }
  if (req.url.startsWith('/slow.js')) { setTimeout(() => { res.setHeader('content-type','application/javascript');res.end('window.slowScriptReady=true;'); }, 1000); return; }
  if (req.url.startsWith('/echo')) { let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{res.setHeader('content-type','application/json');res.setHeader('Set-Cookie','secret_cookie=hidden');res.end(JSON.stringify({ok:true,method:req.method,body:JSON.parse(body||'{}'),Authorization:'hidden response credential'}))});return; }
  res.setHeader('content-type','text/html; charset=utf-8');
  if (req.url==='/outer') {res.end('<!doctype html><title>Outer document</title><iframe title="Inner" src="/inner"></iframe>');return;}
  if (req.url==='/inner') {res.end('<!doctype html><title>Inner document</title><input aria-label="Inner input"><button onclick="window.count=(window.count||0)+1">Inner button</button>');return;}
  if (req.url.startsWith('/ad')) { res.end('<!doctype html><title>Ad frame</title><button>Ad control</button>'); return; }
  if (req.url.startsWith('/slow')) { res.end('<!doctype html><title>Slow probe</title><script src="/slow.js"></script><button id="ready">Ready</button>'); return; }
  res.end(values.extended ? extendedFixture.replace('src="/outer"',`src="http://localhost:${server.address().port}/outer"`) : values.primitives ? primitivesFixture : values.forms ? formFixture : fixture);
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
 ...(values.headless?['--headless=new']:[]), ...(values.extended?['--site-per-process']:[]),
],{windowsHide:true,stdio:'ignore'});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn, description) { for(let i=0;i<100;i++){const value=await fn();if(value)return value;await pause(100)}throw new Error(description); }
let ws,client,claim;
const results={family:values.family,headless:values.headless,cases:[],snapshots:[],navigation:null};
try {
 const active=await until(async()=>{try{return(await readFile(join(profile,'DevToolsActivePort'),'utf8')).trim().split(/\r?\n/)}catch{return null}},'DevTools not ready');
 ws=new WebSocket(`ws://127.0.0.1:${active[0]}${active[1]}`);await once(ws,'open');
 const pending=new Map();let serial=0;
 ws.on('message',raw=>{const data=JSON.parse(raw);const p=pending.get(data.id);if(p){pending.delete(data.id);data.error?p.reject(new Error(data.error.message)):p.resolve(data.result)}});
 const cdp=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}))});
 client=new AttachClient(paired.config);
 if(process.env.ATTACH_TEST_VERBOSE){const call=client.call.bind(client);client.call=(method,args)=>{console.error(method,args);return call(method,args)};}
 const browserInfo=await until(async()=>{const r=await client.call('list_browsers');return r.browsers[0]},'Extension not connected');
 const worker=await until(async()=>{const r=await cdp('Target.getTargets');return r.targetInfos.find(t=>t.type==='service_worker'&&t.url.includes(paired.config.extension_id))},'Worker missing');
 const {sessionId}=await cdp('Target.attachToTarget',{targetId:worker.targetId,flatten:true});
 const evaluate=async expression=>{const r=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId);if(r.exceptionDetails)throw new Error(r.exceptionDetails.text);return r.result.value;};
 const tab=await evaluate(`chrome.tabs.create({url:${JSON.stringify(base+'/probe')},active:true})`);
 const info=await until(async()=>(await client.call('tabs',{action:'list',browser_id:browserInfo.browser_id})).tabs
  .find(t=>t.tab_id===tab.id&&t.url===base+'/probe'&&t.title==='Attach issue probe'),'Fixture tab not loaded');
 // Leave the existing startup settling interval after readiness, not before it.
 await pause(350);
 claim=await client.call('claim_tab',{browser_id:browserInfo.browser_id,tab_id:tab.id,expected_url:info.url,expected_title:info.title});
 const h={tab_handle:claim.tab_handle};
 const page=async expression=>(await evaluate(`chrome.debugger.sendCommand({tabId:${tab.id}},'Runtime.evaluate',{expression:${JSON.stringify(expression)},returnByValue:true,awaitPromise:true})`)).result.value;
 const state=()=>page(`(()=>{const r=document.querySelector('#go')?.getBoundingClientRect();return {count:window.__count,events:window.__events,visibility:document.visibilityState,dpr:devicePixelRatio,rect:r?{x:r.x,y:r.y,width:r.width,height:r.height}:null}})()`);
 const cover=await evaluate(`chrome.tabs.create({url:${JSON.stringify(base+'/cover')},active:false})`);
 const focus = () => evaluate(`chrome.windows.getAll({populate:true}).then(w=>w.map(x=>({id:x.id,focused:x.focused,state:x.state,active:x.tabs.filter(t=>t.active).map(t=>t.id)})).sort((a,b)=>a.id-b.id))`);
 await evaluate(`chrome.tabs.update(${cover.id},{active:true})`);await pause(250);
 const operationsFocus=await focus();
 if (values.extended) {
  await client.call('claimed_tab',{action:'activate',...h});const call=(method,args={})=>client.call(method,{...h,...args});
  await call('fill',{selector:'#edit',text:'seed'});assert.equal(await page('window.keys.filter(e=>e.type==="keydown").length'),0);
  await page('window.keys=[];true');
  const typed=await call('type',{selector:'#edit',text:'A中+',delay_ms:30});
  assert.equal(typed.typed,3);assert.equal(await page('document.querySelector("#edit").value'),'seedA中+');
  const keys=await page('window.keys');for(const type of ['keydown','keypress','input','keyup'])assert.equal(keys.filter(e=>e.type===type&&e.trusted).length,3,type);
  const downs=keys.filter(e=>e.type==='keydown');assert.ok(downs[1].time-downs[0].time>=30);
  await call('type',{selector:'#edit',text:'#'});assert.equal(await page('document.querySelector("#edit").value'),'seedA中+');
  results.cases.push({scenario:'character_events',keys});
  await call('wait',{selector:'input',frame:{path:['iframe[title="Outer"]','iframe[title="Inner"]']},condition:'visible'});
  await call('fill',{selector:'input',frame:{path:['iframe[title="Outer"]','iframe[title="Inner"]']},text:'nested'});
  assert.equal((await call('read_text',{selector:'input',mode:'value',frame:{title:'Inner document'}})).text,'nested');
  assert.equal((await call('evaluate',{expression:'() => document.title',frame:{url:base.replace('127.0.0.1','localhost')+'/inner'}})).value,'Inner document');
  results.cases.push({scenario:'stable_frame_path_title_url'});
  let f=await call('evaluate',{expression:'async () => Array.from({length:10},(_,i)=>i)',max_chars:5});let valuesRead=[...f.value];while(f.next_cursor){f=await call('evaluate',{cursor:f.next_cursor,max_chars:5});valuesRead.push(...f.value)}assert.equal(valuesRead.length,10);
  const handle=await call('evaluate',{expression:'() => document.querySelector("#increment")',result_type:'element'});await call('click',{ref:handle.ref});assert.equal(await page('window.count'),1);
  const found=await call('scroll',{selector:'#list',until:{text:'Row 0487',selector:'button'},delta_y:200,max_steps:60,timeout_ms:15000});await call('click',{ref:found.ref});assert.equal(await page('window.selectedRow'),'Row 0487');
  results.cases.push({scenario:'virtual_row_ref',found});
  const steps=[{action:'click',selector:'#increment'},{action:'wait',selector:'#later',condition:'visible',timeout_ms:150},{action:'click',selector:'#increment'}];
  const failed=await call('batch',{steps});assert.equal(failed.failed_step,1);assert.equal(failed.retry_failed_step_safe,true);assert.equal(await page('window.count'),2);
  await page('const later=document.createElement("button");later.id="later";later.textContent="Later";document.body.append(later);true');
  const resumed=await call('batch',{steps,start_at:1});assert.equal(resumed.completed,true);assert.equal(await page('window.count'),3);
  const extendedBatch=await call('batch',{steps:[{action:'hover',selector:'#increment'},{action:'scroll',selector:'#list',delta_y:-200},{action:'select_option',selector:'#select',value:'b'},{action:'wait',selector:'#later',condition:'attached'}]});assert.equal(extendedBatch.completed,true);
  results.cases.push({scenario:'batch_deadline_resume',failed});
  await call('logs',{kind:'network',capture:{enabled:true,max_body_bytes:4096}});
  await call('evaluate',{expression:'() => fetch("/echo",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer hidden"},body:JSON.stringify({field:"kept",password:"hidden password"})}).then(r=>r.json())'});
  const network=await call('logs',{kind:'network',url_contains:'/echo',max_chars:100000});
  assert.ok(network.entries.some(e=>e.method==='POST'));assert.ok(network.entries.some(e=>e.status===200));
  assert.ok(network.entries.some(e=>e.request_body?.text.includes('kept')));assert.ok(network.entries.some(e=>e.response_body?.text.includes('kept')));
  assert.ok(!JSON.stringify(network).includes('Bearer hidden'));assert.ok(!JSON.stringify(network).includes('hidden password'));assert.ok(!JSON.stringify(network).includes('hidden response credential'));assert.ok(!JSON.stringify(network).includes('secret_cookie=hidden'));
  await call('logs',{kind:'network',capture:{enabled:false}});results.cases.push({scenario:'network_details',network});
  const shot=await call('screenshot',{selector:'#capture'}),png=Buffer.from(shot.data,'base64');assert.equal(shot.capture.scope,'element');assert.equal(png.readUInt32BE(16),160);assert.equal(png.readUInt32BE(20),80);assert.equal(shot.capture.image_origin_css.y,1400);
  await writeFile(join(ROOT,'test-results','element-evidence.png'),png);
  const full=await call('screenshot',{full_page:true});assert.ok(full.capture.css_height>=1480);results.cases.push({scenario:'element_and_full_capture',capture:shot.capture});
  const file1=join(dir,'one.txt'),file2=join(dir,'two.txt');await writeFile(file1,'one');await writeFile(file2,'two');
  const fileRef=await call('evaluate',{expression:'() => window.closedInput',result_type:'element'});await call('upload_file',{ref:fileRef.ref,files:[file1,file2]});assert.equal(await page('window.closedInput.files.length'),2);await call('upload_file',{ref:fileRef.ref,files:[]});assert.equal(await page('window.closedInput.files.length'),0);
  await call('click',{selector:'#chooseclosed'});await call('upload_file',{files:[file1,file2]});assert.equal(await page('window.closedInput.files.length'),2);
  await call('click',{selector:'#chooseclosed'});await call('upload_file',{files:[]});assert.equal(await page('window.closedInput.files.length'),0);
  const uploadEvents=await page('window.uploadEvents');assert.equal(uploadEvents[0].trusted,true);assert.equal(uploadEvents[2].trusted,false);
  results.cases.push({scenario:'closed_shadow_multiple_clear',uploadEvents});
  const alertBatch=await call('batch',{dialog_policy:'accept',steps:[{action:'click',selector:'#alert'},{action:'click',selector:'#increment'}]});assert.equal(alertBatch.completed,true);assert.ok(alertBatch.dialogs.some(d=>d.message==='Continue alert'&&d.accepted));
  const dismissed=await call('click',{selector:'#confirm',dialog_policy:'dismiss'});assert.equal(await page('window.confirmed'),false);assert.equal(dismissed.dialogs[0].accepted,false);
  results.cases.push({scenario:'automatic_dialog_policy',alertBatch,dismissed});
  let unknown;try{await call('click',{selector:'#unreceipt',timeout_ms:10000})}catch(e){unknown=e.message}assert.match(unknown,/Outcome is unknown/);assert.match(unknown,/"dom_changed":true/);assert.equal(await page('document.querySelector("#mark").textContent'),'Effect observed');results.cases.push({scenario:'post_action_observation',unknown});
  const whole=await call('read_text');assert.ok(whole.text.includes('Increment'));assert.ok(whole.text.includes('Element evidence'));results.cases.push({scenario:'whole_rendered_text'});
  await call('navigate',{url:base+'/second',include_snapshot:false});await call('navigate',{direction:'back',include_snapshot:false,wait_until:'load'});assert.equal(await page('location.pathname'),'/probe');await call('navigate',{direction:'forward',include_snapshot:false,wait_until:'load'});assert.equal(await page('location.pathname'),'/second');
  await page('history.pushState({},"","#spa");true');await call('navigate',{direction:'back',include_snapshot:false});assert.equal(await page('location.hash'),'');
  results.cases.push({scenario:'history_document_and_spa'});
  await call('click',{selector:'#increment'});await page('window.onbeforeunload=e=>{e.preventDefault();e.returnValue=""};true');
  const cancelled=await call('navigate',{url:base+'/blocked',dialog_policy:'dismiss',include_snapshot:false,timeout_ms:3000});assert.equal(cancelled.cancelled_by_dialog,true);assert.equal(await page('location.pathname'),'/second');
  const accepted=await call('navigate',{url:base+'/accepted',dialog_policy:'accept',include_snapshot:false,timeout_ms:5000});assert.ok(accepted.dialogs.some(d=>d.type==='beforeunload'&&d.accepted));assert.equal(await page('location.pathname'),'/accepted');
  results.cases.push({scenario:'beforeunload_policy',cancelled,accepted});
 } else if (values.primitives) {
  await client.call('claimed_tab',{action:'activate',...h});
  const call=(method,args={})=>client.call(method,{...h,...args});
  const menuSnap=await call('snapshot'),menuRef=menuSnap.snapshot.match(/\[([^\]]+)\] button "Menu"/)[1];
  await call('hover',{ref:menuRef});
  assert.equal(await page('window.enters'),1);assert.equal(await page('window.childClicks'),0);
  assert.ok((await page('window.events')).every(e=>!['mousedown','mouseup','click'].includes(e.type)));
  await pause(350);
  await call('click',{selector:'#child'});
  assert.equal(await page('window.enters'),1);assert.equal(await page('window.leaves'),0);assert.equal(await page('window.childClicks'),1);
  results.cases.push({scenario:'hover_then_child',enters:1,leaves:0,clicks:1});
  // One observation, two inputs and an intervening expression evaluation.
  const snap=await call('snapshot');const ref=snap.snapshot.match(/\[([^\]]+)\] textbox "Edit"/)[1];
  await call('fill',{ref,text:'first'});await call('evaluate',{expression:'document.title'});await call('fill',{ref,text:'second'});
  assert.equal(await page('document.querySelector("#edit").value'),'second');
  results.cases.push({scenario:'ref_two_inputs_one_snapshot',survives_evaluation:true});
  await page('document.querySelector("#edit").setAttribute("aria-label","Different");true');
  await assert.rejects(call('fill',{ref,text:'must not reach repurposed node'}),/identity changed/);
  await page('document.querySelector("#edit").outerHTML=\'<input id="edit" aria-label="Edit">\';true');
  await assert.rejects(call('fill',{ref,text:'must not reach replacement'}),/detached|stale|identity changed|[Nn]o node|[Cc]ould not find/);
  assert.equal(await page('document.querySelector("#edit").value'),'');
  results.cases.push({scenario:'ref_replaced_node_refused'});
  for (const choice of [{label:'Beta'},{value:'a'},{index:1}]) {
   const selected=await call('select_option',{selector:'#select',...choice});assert.equal(selected.value_verified,true);assert.equal(selected.events_trusted,false);
  }
  assert.ok((await page('window.selectedEvents')).every(e=>e.trusted===false));
  let error;const before=performance.now();try{await call('click',{selector:'#select',timeout_ms:30000})}catch(e){error=e.message}
  assert.match(error,/No input was dispatched.*browser_select_option/);assert.ok(performance.now()-before<2000);
  results.cases.push({scenario:'select_without_popup',error,ms:Math.round(performance.now()-before)});
  await page('setTimeout(()=>{const b=document.createElement("button");b.id="late";b.textContent="Later";document.body.append(b)},2500);true');
  await call('wait',{selector:'#late',condition:'visible',timeout_ms:4000});
  await page('setTimeout(()=>{document.querySelector("#late").textContent="Ready";history.pushState({},"","/probe#done")},100);true');
  await call('wait',{selector:'#late',condition:'text',expected:'Ready'});await call('wait',{condition:'url',expected:'#done'});
  await page('setTimeout(()=>document.querySelector("#late").textContent="Completed",100);true');
  assert.equal((await call('wait',{selector:'#late',condition:'text',previous:'Ready'})).current.text,'Completed');
  await call('wait',{selector:'#child',condition:'actionable'});
  await page('fetch("/slow.js?wait");true');await call('wait',{condition:'network_idle',idle_ms:200,timeout_ms:4000});
  for(const [selector,condition] of [['#absent','attached'],['#hidden','visible'],['#disabled','actionable']]) {
   let error;try{await call('wait',{selector,condition,timeout_ms:150})}catch(e){error=e.message}
   assert.match(error,/Wait for .*current=/);results.cases.push({scenario:'wait_failure',selector,error});
  }
  await page('window.events=[];true');
  const pointer=await call('drag',{source:{selector:'#slider'},destination:{x:550,y:255},steps:8,mode:'pointer',timeout_ms:5000});
  assert.equal(pointer.delivery_verified,true);assert.ok(await page('window.pointerMoves>=8'));
  results.cases.push({scenario:'pointer_drag',result:pointer,events:await page('window.events')});
  await page('window.events=[];true');
  const html5=await call('drag',{source:{selector:'#drag'},destination:{selector:'#drop'},steps:8,mode:'html5',timeout_ms:5000});
  const events=await page('window.events');
  for(const type of ['dragstart','dragover','drop','dragend'])assert.ok(events.some(e=>e.type===type&&e.trusted),type);
  results.cases.push({scenario:'html5_drag',result:html5,events});
  await page('window.events=[];true');
  const far=await call('drag',{source:{selector:'#drag'},destination:{selector:'#far'},steps:8,mode:'html5',timeout_ms:5000});
  assert.ok(await page('scrollY>1000'));assert.ok((await page('window.events')).some(e=>e.type==='drop'&&e.target==='far'&&e.trusted));
  results.cases.push({scenario:'html5_offscreen',result:far});
 } else if (values.forms) {
  await client.call('claimed_tab',{action:'activate',...h});
  const fill = (selector, text, mode='native', nth) => client.call('fill',{...h,selector,text,mode,...(nth==null?{}:{nth})});
  const click = selector => client.call('click',{...h,selector});
  const inspect = () => page('({state:window.formState,events:window.formEvents,error:document.querySelector("#error").textContent})');
  assert.equal((await fill('input[placeholder="公司名称"]','DOM company','dom',0)).application_result,'not_checked');
  assert.equal((await inspect()).state.rows[0].company,'DOM company','native setter + untrusted input can update an ordinary React controlled field');
  await click('#add');
  assert.equal(await page('document.querySelector("input").value'),'DOM company','React state survives remount');
  const beforeAmbiguity=await inspect();
  await assert.rejects(fill('input[placeholder="公司名称"]','ambiguous'),/matched 2/);
  assert.deepEqual((await inspect()).state,beforeAmbiguity.state);
  const batch=await client.call('batch',{...h,steps:[
   {action:'fill',selector:'input[placeholder="公司名称"]',nth:1,text:'Native company'},
   {action:'press_key',key:'Tab'},
   {action:'click',selector:'#year'},
   {action:'fill',selector:'#year',text:'2026'},
   {action:'click',selector:'.year-option[data-value="2026"]'},
   {action:'click',selector:'#month'},
   {action:'fill',selector:'#month',text:'9'},
   {action:'click',selector:'.month-option[data-value="9"]'},
  ]});
  assert.equal(batch.completed,true,JSON.stringify(batch));
  const saved=await inspect();
  assert.equal(saved.state.rows[1].company,'Native company');assert.equal(saved.state.year,2026);assert.equal(saved.state.month,9);assert.equal(saved.error,'');
  await click('#add');assert.equal((await inspect()).state.month,9);assert.equal(await page('document.querySelectorAll("input[placeholder=公司名称]")[1].value'),'Native company');
  // Typing a filter is deliberately different from selecting the option.
  await click('#year');await fill('#year','2025','dom');
  assert.equal((await inspect()).state.year,2026);
  await client.call('press_key',{...h,key:'Tab'});await click('#add');
  assert.equal((await inspect()).state.year,2026);
  const rect=await page('(()=>{const r=document.querySelector("#previous").getBoundingClientRect();return {x:r.x-15,y:r.y+r.height/2}})()');
  const pseudo=await client.call('click',{...h,...rect});
  assert.equal(pseudo.target_verified,true);assert.equal(pseudo.hit_target.pseudo_element,true);assert.equal((await inspect()).state.previous,1);
  const blocker=await evaluate(`chrome.windows.create({url:${JSON.stringify(base+'/cover')},focused:true})`);
  let occludedState;
  try {
   const result=await click('#add'); assert.equal(result.target_verified,true);
   occludedState=result.page_state;
   if(!values.headless){assert.equal(result.page_state.window_focused,false);assert.equal((await focus()).find(w=>w.id===blocker.id).focused,true);}
  } finally {await evaluate(`chrome.windows.remove(${blocker.id})`);}
  results.cases.push({scenario:'controlled_form',react:'18.3.1',dom_state_survives_remount:true,native_batch_steps:batch.results.length,filter_is_not_selection:true,blur_verified:true,pseudo_verified:true,occluded_page_state:occludedState});
  console.log(JSON.stringify(results.cases.at(-1)));
 } else if (values['tab-indicators']) {
  const nativeTab=await evaluate(`chrome.tabs.get(${tab.id})`);
  const marker=await evaluate(`chrome.tabGroups.get(${nativeTab.groupId})`);
  assert.equal(marker.title,'');assert.equal(marker.color,'red');assert.equal(marker.collapsed,false);
  assert.equal(await page('document.querySelectorAll("[data-local-browser-attach]").length'),0);
  assert.equal(await page('document.querySelectorAll("[data-local-browser-attach-click]").length'),0);
  const snap=await client.call('snapshot',h),ref=snap.snapshot.match(/\[([^\]]+)\] button "Go"/)[1];
  await assert.rejects(client.call('click',{...h,ref}),/TAB_NOT_READY.*No input was dispatched/);
  await client.call('claimed_tab',{action:'activate',...h});
  assert.equal((await client.call('click',{...h,ref})).target_verified,true);
  assert.equal(await page('document.querySelectorAll("[data-local-browser-attach]").length'),0);
  await until(()=>page('document.querySelectorAll("[data-local-browser-attach-click]").length===1'),'transient click visual');
  await client.call('claimed_tab',{action:'activate',...h,focus_window:false});
  const shot=await client.call('screenshot',h);
  assert.equal(shot.capture.agent_indicators_included,false);
  await client.call('navigate',{...h,url:base+'/slow'});
  assert.equal((await evaluate(`chrome.tabs.get(${tab.id})`)).groupId,marker.id);
  assert.equal(await page('document.querySelectorAll("[data-local-browser-attach]").length'),0);
  await client.call('claimed_tab',{action:'release',...h});claim=null;
  assert.equal((await evaluate(`chrome.tabs.get(${tab.id})`)).groupId,-1);
  results.cases.push({scenario:'native_marker_without_page_overlay',marker,screenshot_clean:true,navigation_preserved:true,release_removed:true});

  const original=await evaluate(`chrome.tabs.group({tabIds:[${tab.id},${cover.id}]})`);
  await evaluate(`chrome.tabGroups.update(${original},{title:'User research',color:'blue',collapsed:false})`);
  await evaluate(`chrome.tabs.update(${cover.id},{active:true})`);
  const claimAgain=async()=>{
   const current=(await client.call('tabs',{action:'list',browser_id:browserInfo.browser_id})).tabs.find(t=>t.tab_id===tab.id);
   claim=await client.call('claim_tab',{browser_id:browserInfo.browser_id,tab_id:tab.id,expected_url:current.url,expected_title:current.title});
   assert.equal(claim.visual_warning,undefined);return {tab_handle:claim.tab_handle};
  };
  const groupedHandle=await claimAgain();
  assert.notEqual((await evaluate(`chrome.tabs.get(${tab.id})`)).groupId,original);
  await client.call('claimed_tab',{action:'release',...groupedHandle});claim=null;
  assert.equal((await evaluate(`chrome.tabs.get(${tab.id})`)).groupId,original);
  assert.equal((await evaluate(`chrome.tabGroups.get(${original})`)).title,'User research');
  assert.equal((await evaluate(`chrome.tabs.get(${cover.id})`)).active,true);
  results.cases.push({scenario:'original_group_restored',group_id:original,background_preserved:true});

  const disconnectedHandle=await claimAgain();
  await client.close();client=new AttachClient(paired.config);
  await until(async()=>(await evaluate(`chrome.tabs.get(${tab.id})`)).groupId===original,'session disconnect group restoration');
  await assert.rejects(client.call('snapshot',disconnectedHandle),/expired/);claim=null;
  results.cases.push({scenario:'session_disconnect_restores_group',restored:true});
 } else if (values['input-capture']) {
  await client.call('claimed_tab',{action:'activate',...h});
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
   let clickError;const clickStart=performance.now();
   try { await client.call('click',{...h,ref:await buttonRef(),timeout_ms:30000}); } catch(error) { clickError=error.message; }
   assert.ok(clickError,'suppressed native click must fail');
   assert.match(clickError,/Outcome is unknown.*press Esc/);assert.ok(performance.now()-clickStart<2000);
   assert.equal((await state()).count,0);
   let keyError;const keyStart=performance.now();
   try { await client.call('press_key',{...h,key:'Z',timeout_ms:30000}); } catch(error) { keyError=error.message; }
   assert.ok(keyError,'suppressed keyboard input must fail');
   assert.match(keyError,/Outcome is unknown.*press Esc/);assert.ok(performance.now()-keyStart<2000);
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
  assert.equal((await evaluate(`chrome.tabs.get(${tab.id})`)).active,true);
  results.cases.push({scenario:'native_recovered',value:'z',count:2,background:false});
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
  // These actions use only the disposable fixture and the public Attach API.
  const refFor = snapshot => snapshot.snapshot.match(/\[([^\]]+)\] button "Go"/)[1];
  for (const coordinates of [false, true]) {
   await page('window.__count=0;window.__events=[];true');
   const snap = await client.call('snapshot', h), start = performance.now();
   await assert.rejects(client.call('click', {...h, timeout_ms:30000, ...(coordinates ? {x:260,y:220} : {ref:refFor(snap)})}), /TAB_NOT_READY.*No input was dispatched/);
   assert.ok(performance.now()-start<2000); assert.equal((await state()).count,0);
   assert.equal((await evaluate(`chrome.tabs.get(${tab.id})`)).active,false);
   results.cases.push({scenario:coordinates?'background_coordinate':'background_ref',ms:Math.round(performance.now()-start),not_dispatched:true});
  }
  await client.call('claimed_tab',{action:'activate',...h});
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
  await client.call('claimed_tab',{action:'activate',...h});
  assert.equal((await evaluate(`chrome.tabs.get(${tab.id})`)).active,true);
  await page(`const style=document.createElement('style');style.textContent='@keyframes drift{from{transform:translateX(-5px)}to{transform:translateX(5px)}}#go{animation:drift 0.7s linear infinite alternate}';document.head.append(style);true`);
  for(let i=0;i<3;i++) {
   await page('window.__count=0;window.__events=[];true');
   const snap=await client.call('snapshot',h),start=performance.now();
   let result, error;
   try { result=await client.call('click',{...h,ref:refFor(snap),timeout_ms:500}); } catch(failure) { error=failure.message; }
   const observed=await state();
   if(result) {
    assert.equal(result.target_verified,true);assert.equal(observed.count,1);
    assert.ok(observed.events.some(e=>e.type==='click'&&e.trusted&&e.target==='go'));
   } else {
    // Compositor timing can either expose stable bounds or continuous motion.
    // Both a verified click and a pre-dispatch refusal are valid; uncertainty
    // or duplicate effects must never be accepted as animation-test success.
    assert.match(error,/no input was dispatched/i);assert.equal(observed.count,0);
   }
   results.cases.push({scenario:'infinite_css_animation',run:i+1,ms:Math.round(performance.now()-start),target_verified:!!result,error});
  }
  const opened=await client.call('tabs',{action:'open',browser_id:browserInfo.browser_id,url:base+'/ad',active:false});
  await until(async()=>{const tabs=(await client.call('tabs',{action:'list',browser_id:browserInfo.browser_id})).tabs;return tabs.find(t=>t.tab_id===opened.tab_id&&t.title==='Ad frame')},'opened tab loaded');
  const tabs=(await client.call('tabs',{action:'list',browser_id:browserInfo.browser_id})).tabs,created=tabs.find(t=>t.tab_id===opened.tab_id);
  const createdClaim=await client.call('claim_tab',{browser_id:browserInfo.browser_id,tab_id:created.tab_id,expected_url:created.url,expected_title:created.title});
  const ch={tab_handle:createdClaim.tab_handle};
  await client.call('claimed_tab',{action:'activate',...ch});
  assert.equal((await evaluate(`chrome.tabs.get(${created.tab_id})`)).active,true);
  assert.equal((await evaluate(`chrome.windows.get(${created.window_id})`)).focused,true);
  assert.equal((await client.call('claimed_tab',{action:'close',...ch})).closed,true);
  await assert.rejects(client.call('snapshot',ch),/expired/);
  assert.ok(!(await client.call('tabs',{action:'list',browser_id:browserInfo.browser_id})).tabs.some(t=>t.tab_id===created.tab_id));
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
 await client.call('click',{...h,ref:uploadRef,mode:'dom'});await client.call('upload_file',{...h,files:[file]});
 assert.equal(await page('document.querySelector("#file").files[0].text()'),'background upload');
 assert.equal((await evaluate(`chrome.tabs.get(${tab.id})`)).active,false);
 assert.equal((await evaluate(`chrome.tabs.get(${cover.id})`)).active,backgroundFocus.active);
 const operationsAfter=await focus();
 assert.deepEqual(operationsAfter.map(({focused,...w})=>w),operationsFocus.map(({focused,...w})=>w));
 for(const window of operationsFocus)if(!window.focused)assert.equal(operationsAfter.find(w=>w.id===window.id).focused,false);
 results.background_operations=['fill','press_key','scroll','DOM click chooser','upload_file'];
 const s=await client.call('snapshot',h);
 assert.equal(s.truncated,false);assert.match(s.snapshot,/Row 200:/);assert.doesNotMatch(s.snapshot,/InlineTextBox/);
 results.snapshots.push({node_count:s.node_count,chars:s.snapshot.length,total:s.total_node_count,all_200_rows:true});
 let part=await client.call('snapshot',{...h,max_nodes:10,max_chars:1000}), combined=part.snapshot, pages=1;
 const firstRef=part.snapshot.match(/\[([^\]]+)\] button "Go"/)[1];
 while(part.next_cursor){part=await client.call('snapshot',{...h,cursor:part.next_cursor,max_nodes:10,max_chars:1000});combined+='\n'+part.snapshot;pages++;}
 assert.equal((combined.match(/Row \d+:/g)||[]).length,200);
 await client.call('claimed_tab',{action:'activate',...h});
 await client.call('click',{...h,ref:firstRef});
 results.snapshots.push({pages,all_200_rows:true,first_page_ref_survived:true});
 for(const scenario of ['foreground_ref','background_ref','background_coordinate','occluded_window_ref']){
  let coverWindow;
  if(scenario==='occluded_window_ref'){
   await evaluate(`chrome.tabs.update(${tab.id},{active:true})`);
   coverWindow=await evaluate(`chrome.windows.create({url:${JSON.stringify(base+'/cover-window')},focused:true,width:${values.headless?800:1100},height:${values.headless?600:900},left:0,top:0})`);
  }else if(scenario==='foreground_ref') await client.call('claimed_tab',{action:'activate',...h});
  else await evaluate(`chrome.tabs.update(${cover.id},{active:true})`);
  await pause(350);
  const before=await focus();
  const expectNativeReady=scenario==='foreground_ref'||scenario==='occluded_window_ref';
  for(let run=1;run<=3;run++){
   await page('window.__count=0;window.__events=[];true');
   const snap=await client.call('snapshot',h),ref=snap.snapshot.match(/\[([^\]]+)\] button "Go"/)[1];
   const start=performance.now();
   let result, clickError;
   try { result=await client.call('click',{...h,...(scenario==='background_coordinate'?{x:260,y:220}:{ref})}); }
   catch(error) { clickError=error.message; }
   const ms=Math.round(performance.now()-start),observed=await state();
   if(expectNativeReady) {
    assert.equal(clickError,undefined);assert.equal(result.target_verified,true);assert.equal(observed.count,1);assert.ok(observed.events.some(e=>e.type==='click'&&e.trusted&&e.target==='go'));
   } else {
    assert.match(clickError,/TAB_NOT_READY.*No input was dispatched/);assert.equal(observed.count,0);assert.equal(observed.events.length,0);assert.ok(ms<2000);
   }
   const after=await focus();
   assert.deepEqual(after.map(({focused,...w})=>w),before.map(({focused,...w})=>w),'Attach must not activate tabs or change window state');
   for(const window of before)if(!window.focused)assert.equal(after.find(w=>w.id===window.id).focused,false,'Attach must not bring an unfocused window forward');
   if(scenario.startsWith('background'))assert.equal((await evaluate(`chrome.tabs.get(${tab.id})`)).active,false);
   if(coverWindow)assert.equal(after.find(w=>w.id===tab.windowId).focused,before.find(w=>w.id===tab.windowId).focused);
   results.cases.push({scenario,run,ms,visibility:observed.visibility,count:observed.count,focus_not_stolen:true,expected_native_ready:expectNativeReady,error:clickError});
   console.log(JSON.stringify(results.cases.at(-1)));
  }
  if(coverWindow)await evaluate(`chrome.windows.remove(${coverWindow.id})`);
 }
 await client.call('claimed_tab',{action:'activate',...h});
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
 assert.equal(await page('Object.getOwnPropertyNames(window).filter(n=>n.startsWith("__attachClick_")).length'),0);
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
 console.log(JSON.stringify({extended:values.extended?results.cases:undefined,primitives:values.primitives?results.cases:undefined,tab_indicators:values['tab-indicators']?results.cases:undefined,input_capture:values['input-capture']?results.cases:undefined,snapshots:results.snapshots,background_operations:results.background_operations,
  hover:results.cases.find(c=>c.scenario==='hover_shift_30px'),navigation:results.navigation}));
 if(claim)await client.call('claimed_tab',{action:'release',tab_handle:claim.tab_handle});claim=null;
} finally {
 if(claim)await client?.call('claimed_tab',{action:'release',tab_handle:claim.tab_handle}).catch(()=>{});
 await client?.close();ws?.close();browser.kill();await hub.close();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));
 await mkdir(join(ROOT,'test-results'),{recursive:true});
  await writeFile(join(ROOT,'test-results',`${values.extended?'extended':values.primitives?'primitives':values.forms?'forms':values['tab-indicators']?'tab-indicators':values['input-capture']?'input-capture':values.regressions?'regressions':'interaction'}-${values.family}.json`),JSON.stringify(results,null,2));
 await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}).catch(()=>{});
}
