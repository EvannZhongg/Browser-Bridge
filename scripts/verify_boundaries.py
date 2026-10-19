"""Real Chrome/Edge tool boundary tests; all mutations stay on local fixture pages."""
import argparse
import asyncio
import base64
import ctypes
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import time

from aiohttp import web
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'test-results' / 'boundaries'
HTML = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Browser Bridge boundary fixture</title>
<style>body{font:16px system-ui;margin:40px;max-width:1000px}button,input,textarea{font:inherit;margin:6px;padding:8px}#pane{height:110px;width:280px;overflow:auto;border:1px solid}#pad{height:1400px}iframe{height:90px;width:350px}#state{white-space:pre-wrap;max-width:900px;font:11px monospace}</style>
<h1>Browser Bridge boundary fixture</h1><p>Local disposable test page.</p>
<a id="observer" target="_blank" href="/observer">Open observer tab</a><br>
<label>Name<input id="name"></label><label>Notes<textarea id="notes"></textarea></label>
<label>Disabled<input id="disabled" disabled value="unchanged"></label>
<label>Read only<input id="readonly" readonly value="unchanged"></label>
<label>Number<input id="number" type="number" value="3"></label>
<div id="editable" contenteditable="true" role="textbox" aria-label="Editable">initial</div>
<button id="increment">Increment</button><button id="confirm">Confirm</button><button id="prompt">Prompt</button>
<div id="coveredWrap" style="position:relative;width:160px;height:50px"><button id="covered">Covered</button><div style="position:absolute;inset:0;background:#eee8">Overlay</div></div>
<div id="pane"><div style="height:700px">Scrollable pane</div></div>
<iframe title="Same frame" src="/frame"></iframe><iframe title="Cross frame" src="http://localhost:__PORT__/frame"></iframe>
<pre id="state"></pre><div id="pad"></div>
<script>
const data={count:0,frameCount:0,dialog:'none',trusted:false,lastClick:null};
function sync(){const host=document.querySelector('[data-local-browser-bridge]');
 const box=document.querySelector('#increment').getBoundingClientRect(); const pane=document.querySelector('#pane').getBoundingClientRect();
 const state={...data,name:document.querySelector('#name').value,notes:document.querySelector('#notes').value,editable:document.querySelector('#editable').textContent,
 paneScroll:document.querySelector('#pane').scrollTop,windowScroll:scrollY,visibility:document.visibilityState,
 markers:document.querySelectorAll('[data-local-browser-bridge]').length,markerVisible:!!host&&host.style.visibility!=='hidden',
 clickPoint:{x:box.x+box.width/2,y:box.y+box.height/2},panePoint:{x:pane.x+pane.width/2,y:pane.y+pane.height/2}};
 const text='STATE:'+JSON.stringify(state);if(document.querySelector('#state').textContent!==text)document.querySelector('#state').textContent=text;}
document.querySelector('#increment').onclick=e=>{data.count++;data.lastClick={x:e.clientX,y:e.clientY};sync()};
document.querySelector('#confirm').onclick=()=>{data.dialog=confirm('Local confirm')?'accepted':'dismissed';sync()};
document.querySelector('#prompt').onclick=()=>{data.dialog=prompt('Local prompt','default');sync()};
document.addEventListener('input',e=>{data.trusted=e.isTrusted;sync()});document.querySelector('#pane').onscroll=sync;
window.addEventListener('scroll',sync);document.addEventListener('visibilitychange',sync);
window.addEventListener('message',e=>{if(e.data==='frame-click'){data.frameCount++;sync()}});
new MutationObserver(items=>{if(items.some(m=>m.target.hasAttribute?.('data-local-browser-bridge')||[...m.addedNodes,...m.removedNodes].some(n=>n.hasAttribute?.('data-local-browser-bridge'))))sync()}).observe(document.documentElement,{childList:true,subtree:true,attributes:true});
sync();</script></html>'''


def foreground():
    user32 = ctypes.windll.user32
    user32.GetForegroundWindow.restype = ctypes.c_void_p
    handle = user32.GetForegroundWindow()
    pid = ctypes.c_ulong()
    user32.GetWindowThreadProcessId(ctypes.c_void_p(handle), ctypes.byref(pid))
    title = ctypes.create_unicode_buffer(1024)
    user32.GetWindowTextW(ctypes.c_void_p(handle), title, len(title))
    return {'hwnd': handle, 'pid': pid.value, 'title': title.value}


def launch(family, url):
    paths = ([Path(os.environ['PROGRAMFILES'])/'Google/Chrome/Application/chrome.exe',
              Path(os.environ['LOCALAPPDATA'])/'Google/Chrome/Application/chrome.exe'] if family == 'chrome' else
             [Path(os.environ['PROGRAMFILES(X86)'])/'Microsoft/Edge/Application/msedge.exe',
              Path(os.environ['PROGRAMFILES'])/'Microsoft/Edge/Application/msedge.exe'])
    executable = next(path for path in paths if path.exists())
    subprocess.Popen([str(executable), '--new-tab', url], creationflags=subprocess.CREATE_NO_WINDOW)


class Checks:
    def __init__(self):
        self.rows = []
        self.samples = {}
        self.browser = None
        self.foreground_baseline = None
        self.notes = []

    async def call(self, client, name, arguments=None, *, error=None, sample=False, allowed_error=None):
        (OUT/'progress.txt').write_text(f'{self.browser}: {name}, completed={len(self.rows)}, expected_error={error}\n',encoding='utf-8')
        before = foreground()
        started = time.monotonic()
        result = await client.call_tool('browser_'+name, arguments or {})
        wire = result.model_dump(mode='json', by_alias=True, exclude_none=True)
        failed = wire.get('isError', False)
        text = '\n'.join(item['text'] for item in wire.get('content', []) if item['type'] == 'text')
        if failed and allowed_error:
            assert allowed_error.lower() in text.lower(), (name, text)
        elif error:
            assert failed and error.lower() in text.lower(), (name, error, text)
        else:
            assert not failed, (name, text)
        after = foreground()
        self.rows.append({'browser': self.browser, 'tool': name, 'expected_error': error or (allowed_error if failed else None),
                          'passed': True, 'elapsed_ms': round((time.monotonic()-started)*1000),
                          'foreground_unchanged': before == after,
                          'foreground_before': before, 'foreground_after': after,
                          'background_baseline_unchanged': after == self.foreground_baseline if self.foreground_baseline else None,
                          'content_types': [item['type'] for item in wire.get('content', [])],
                          'duplicate_structured_content': 'structuredContent' in wire,
                          'background_capture_available': not failed if name=='screenshot' and self.foreground_baseline else None})
        if sample:
            stored = json.loads(json.dumps(wire))
            for item in stored.get('content', []):
                if item['type'] == 'image':
                    filename = f'{self.browser}-{name}-{len(self.rows)}.png'
                    (OUT / filename).write_bytes(base64.b64decode(item.pop('data')))
                    item['data_file'] = filename
            self.samples.setdefault(name, stored)
        if failed: return text
        if any(item['type'] == 'image' for item in wire['content']): return wire
        return json.loads(text)


async def run(families):
    OUT.mkdir(parents=True, exist_ok=True)
    checks = Checks()
    app = web.Application()
    port = 0
    async def page(request):
        return web.Response(text=HTML.replace('__PORT__', str(port)), content_type='text/html')
    app.router.add_get('/', page)
    app.router.add_get('/observer', lambda request: web.Response(text='<title>Observer - keep foreground</title><h1>Observer</h1><p>Browser Bridge operates a different, inactive tab.</p>', content_type='text/html'))
    app.router.add_get('/frame', lambda request: web.Response(text='<button onclick="parent.postMessage(\'frame-click\',\'*\')">Frame action</button>', content_type='text/html'))
    app.router.add_get('/large', lambda request: web.Response(text='<title>Large local fixture</title>'+''.join(f'<button>{i}: '+('长文本\\"'*100)+'</button>' for i in range(180)), content_type='text/html'))
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    parameters = StdioServerParameters(command=str(ROOT/'.venv/Scripts/python.exe'), cwd=str(ROOT), args=['-m','browser_bridge.mcp_server'])
    try:
        async with stdio_client(parameters) as (read, write), stdio_client(parameters) as (read2, write2):
            async with ClientSession(read, write) as client, ClientSession(read2, write2) as other:
                await client.initialize(); await other.initialize()
                tool_list = await client.list_tools()
                checks.samples['tool_definitions'] = tool_list.model_dump(mode='json', by_alias=True, exclude_none=True)
                assert len(tool_list.tools) == 13
                browsers = (await checks.call(client, 'list_browsers', sample=True))['browsers']
                for family in families:
                    checks.browser = family
                    checks.foreground_baseline = None
                    browser = next(item for item in browsers if item['family'] == family)
                    browser_id = browser['browser_id']
                    url = f'http://127.0.0.1:{port}/?boundary={secrets.token_hex(5)}'
                    launch(family, url)
                    target = None
                    for _ in range(50):
                        tabs = (await checks.call(client, 'list_tabs', {'browser_id':browser_id}))['tabs']
                        target = next((tab for tab in tabs if tab['url'] == url and tab['title']=='Browser Bridge boundary fixture'), None)
                        if target: break
                        await asyncio.sleep(0.1)
                    assert target, 'No fixture tab'
                    args = {'browser_id':browser_id,'tab_id':target['tab_id'],'expected_url':url,'expected_title':target['title']}
                    await checks.call(client,'claim_tab',{**args,'expected_title':'wrong'},error='exact')
                    claim = await checks.call(client,'claim_tab',args,sample=True)
                    assert not claim.get('visual_warning'), claim
                    handle = claim['tab_handle']
                    h = {'tab_handle':handle}
                    try:
                        assert (await checks.call(client,'claim_tab',args))['tab_handle'] == handle
                        await checks.call(other,'list_tabs',{'browser_id':browser_id})
                        await checks.call(other,'claim_tab',args,error='another MCP session')
                        await checks.call(other,'read_text',h,error='belongs to another')
                        async def snap_ref(role, name, **extra):
                            snapshot = await checks.call(client,'snapshot',{**h,**extra},sample=True)
                            match = re.search(r'\[([^\]]+)\] '+re.escape(role)+r' '+re.escape(json.dumps(name,ensure_ascii=False)),snapshot['snapshot'])
                            assert match, (role,name,snapshot['snapshot'])
                            return match.group(1)
                        async def state():
                            text = await checks.call(client,'read_text',h,sample=True)
                            assert 'Agent 已接管' not in text['text'], 'Indicator leaked into visible text'
                            return json.loads(text['text'].split('STATE:',1)[1].split('\n')[0])
                        # Establish screenshot format/visual correctness while the fixture is visible.
                        await checks.call(client,'click',{**h,'ref':await snap_ref('textbox','Name')})
                        active_shot=await checks.call(client,'screenshot',h,sample=True)
                        active_metadata=json.loads(active_shot['content'][0]['text'])
                        preview=await checks.call(client,'screenshot',{**h,'include_indicators':True})
                        for image_set,filename in [(active_shot,f'{family}-clean.png'),(preview,f'{family}-indicators.png')]:
                            for item in image_set['content']:
                                if item['type']=='image': (OUT/filename).write_bytes(base64.b64decode(item['data']))
                        # A new observer becomes active; the actual target stays inactive.
                        await checks.call(client,'click',{**h,'ref':await snap_ref('link','Open observer tab')})
                        for _ in range(40):
                            tabs = (await checks.call(client,'list_tabs',{'browser_id':browser_id},sample=True))['tabs']
                            if not next(tab for tab in tabs if tab['tab_id']==target['tab_id'])['active']: break
                            await asyncio.sleep(0.05)
                        assert not next(tab for tab in tabs if tab['tab_id']==target['tab_id'])['active']
                        # Put the OTHER browser window in front as well.
                        opposite = 'edge' if family == 'chrome' else 'chrome'
                        launch(opposite,f'http://127.0.0.1:{port}/observer?front={secrets.token_hex(5)}')
                        await asyncio.sleep(0.5)
                        checks.foreground_baseline = foreground()
                        await checks.call(client,'snapshot',{**h,'max_nodes':9},error='greater than or equal to 10')
                        await checks.call(client,'snapshot',{**h,'max_nodes':3001},error='less than or equal to 3000')
                        small = await checks.call(client,'snapshot',{**h,'max_nodes':10})
                        assert small['node_count']<=10 and small['truncated']
                        snapshot = await checks.call(client,'snapshot',h,sample=True)
                        assert 'Agent 已接管' not in snapshot['snapshot']
                        if not ('localhost:' in snapshot['snapshot'] or any('localhost:' in frame['url'] for frame in snapshot['omitted_frames'])):
                            checks.notes.append({'browser':family,'issue':'Cross-origin frame was not reported in coverage'})
                        ref = await snap_ref('textbox','Name')
                        await checks.call(client,'fill',{**h,'ref':ref,'text':'中文 Background'},sample=True)
                        current = await state()
                        assert current['name']=='中文 Background' and current['trusted']
                        assert current['markers']==1 and current['markerVisible']
                        await checks.call(client,'fill',{**h,'ref':ref,'text':'stale'},error='stale')
                        for label,reason in [('Disabled','disabled'),('Read only','read-only'),('Number','cannot be filled')]:
                            await checks.call(client,'fill',{**h,'ref':await snap_ref('spinbutton' if label=='Number' else 'textbox',label),'text':'invalid'},error=reason)
                        await checks.call(client,'fill',{**h,'ref':await snap_ref('textbox','Notes'),'text':'line 1\n第二行'})
                        await checks.call(client,'fill',{**h,'ref':await snap_ref('textbox','Editable'),'text':'editable 中文'})
                        current = await state(); assert current['notes']=='line 1\n第二行' and current['editable']=='editable 中文'
                        await checks.call(client,'fill',{**h,'ref':await snap_ref('textbox','Name'),'text':'select me'})
                        await checks.call(client,'press_key',{**h,'key':'Control+A'},sample=True)
                        await checks.call(client,'press_key',{**h,'key':'Backspace'})
                        assert (await state())['name']==''
                        await checks.call(client,'press_key',{**h,'key':'F99'},error='Unsupported key')
                        await checks.call(client,'click',{**h,'ref':'unknown'},error='stale')
                        await checks.call(client,'click',{**h,'x':-1,'y':1},error='viewport')
                        await checks.call(client,'click',{**h,'x':1},error='both x and y')
                        await checks.call(client,'click',{**h,'ref':await snap_ref('button','Covered')},error='covers')
                        # Same-process iframe semantic click is independently checked.
                        await checks.call(client,'click',{**h,'ref':await snap_ref('button','Frame action')})
                        for _ in range(20):
                            if (await state())['frameCount']==1: break
                            await asyncio.sleep(0.05)
                        assert (await state())['frameCount']==1
                        await checks.call(client,'click',{**h,'ref':await snap_ref('button','Increment')},sample=True)
                        assert (await state())['count']==1
                        shot = await checks.call(client,'screenshot',h,allowed_error='Screenshot did not finish')
                        metadata = json.loads(shot['content'][0]['text']) if isinstance(shot,dict) else active_metadata
                        assert metadata['capture']['agent_indicators_included'] is False
                        point = (await state())['clickPoint']
                        mapping = metadata['capture']['image_to_viewport_css']
                        image_x = (point['x']-mapping['offset_x'])/mapping['scale_x']
                        image_y = (point['y']-mapping['offset_y'])/mapping['scale_y']
                        await checks.call(client,'click',{**h,'x':image_x*mapping['scale_x']+mapping['offset_x'], 'y':image_y*mapping['scale_y']+mapping['offset_y']})
                        assert (await state())['count']==2
                        pane = (await state())['panePoint']
                        scroll=await checks.call(client,'scroll',{**h,'delta_y':180,**pane},sample=True)
                        assert scroll['scope']=='element' and scroll['after']['y']>scroll['before']['y']
                        # A hidden document may defer its scroll event handler; the
                        # tool returns the actual scroll position, not a cached event log.
                        await checks.call(client,'read_text',{**h,'max_chars':1})
                        one = await checks.call(client,'read_text',{**h,'max_chars':1}); assert len(one['text'])==1 and one['truncated']
                        await checks.call(client,'read_text',{**h,'max_chars':0},error='greater than or equal to 1')
                        for label,kind in [('Confirm','confirm'),('Prompt','prompt')]:
                            try: await checks.call(client,'click',{**h,'ref':await snap_ref('button',label)})
                            except AssertionError as error:
                                if 'opened a JavaScript dialog' not in str(error): raise
                            dialog = await checks.call(client,'snapshot',h)
                            assert dialog['dialog']['type']==kind
                            await checks.call(client,'handle_dialog',{**h,'accept':kind=='prompt','prompt_text':'dialog 中文' if kind=='prompt' else None},sample=True)
                        assert (await state())['dialog']=='dialog 中文'
                        await checks.call(client,'handle_dialog',{**h,'accept':False},error='No dialog')
                        await checks.call(client,'screenshot',{**h,'full_page':True},allowed_error='Screenshot did not finish')
                        await checks.call(client,'navigate',{**h,'url':'javascript:alert(1)'},error='http')
                        stale_ref = await snap_ref('textbox','Name')
                        await checks.call(client,'navigate',{**h,'url':f'http://127.0.0.1:{port}/large'},sample=True)
                        for _ in range(30):
                            text = await checks.call(client,'read_text',h)
                            if text['title']=='Large local fixture': break
                            await asyncio.sleep(0.05)
                        await checks.call(client,'click',{**h,'ref':stale_ref},error='stale')
                        large = await checks.call(client,'snapshot',{**h,'max_nodes':3000})
                        assert large['truncated'] and large['truncation_reason']=='text_budget'
                        assert len(json.dumps(large,ensure_ascii=False))<22000
                        await checks.call(client,'navigate',{**h,'url':url})
                        for _ in range(30):
                            text = await checks.call(client,'read_text',h)
                            if text['title']=='Browser Bridge boundary fixture': break
                            await asyncio.sleep(0.05)
                        assert (await state())['markers']==1, 'Navigation must restore exactly one indicator'
                        tabs = (await checks.call(client,'list_tabs',{'browser_id':browser_id}))['tabs']
                        assert not next(tab for tab in tabs if tab['tab_id']==target['tab_id'])['active'], 'A browser operation activated the target tab'
                        background_rows = [row for row in checks.rows if row['browser']==family and row['background_baseline_unchanged'] is not None]
                        assert all(row['foreground_unchanged'] and row['background_baseline_unchanged'] for row in background_rows), 'An operation changed the foreground window'
                    finally:
                        await checks.call(client,'release_tab',h,sample=True)
                    await checks.call(client,'read_text',h,error='expired')
                    await checks.call(client,'release_tab',h,error='expired')
                    print(f'PASS {family}: all 13 tool contracts and boundaries; background capture availability recorded separately',flush=True)
    finally:
        (OUT/'results.json').write_text(json.dumps({'checks':checks.rows,'samples':checks.samples,'notes':checks.notes},ensure_ascii=False,indent=2),encoding='utf-8')
        await runner.cleanup()


if __name__=='__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('--family',choices=['chrome','edge','both'],default='both')
    args=parser.parse_args()
    asyncio.run(run(['chrome','edge'] if args.family=='both' else [args.family]))
