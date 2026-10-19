"""Exercise the real extension through stdio MCP on disposable local test pages."""
import argparse
import asyncio
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys

from aiohttp import web
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

ROOT = Path(__file__).resolve().parent.parent

HTML = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Browser Bridge live test</title>
<style>body{font:18px system-ui;margin:48px;max-width:800px}button,input{font:inherit;padding:12px;margin:12px 0}label{display:block}output{display:block;margin:20px 0}iframe{width:500px;height:100px}</style>
<h1>Browser Bridge live test</h1><p>临时本地测试页，不连接外部服务。</p>
<label for="name">测试姓名</label><input id="name"><output id="echo">尚未输入</output>
<button id="increment">增加计数</button><output id="count">计数：0</output>
<button id="dialog">显示确认框</button><output id="dialogResult">尚未处理对话框</output>
<iframe src="/frame" title="测试框架"></iframe>
<script>let count=0;document.querySelector('#name').addEventListener('input',e=>document.querySelector('#echo').textContent='输入：'+e.target.value);
document.querySelector('#increment').onclick=()=>document.querySelector('#count').textContent='计数：'+(++count);
document.querySelector('#dialog').onclick=()=>document.querySelector('#dialogResult').textContent=confirm('本地测试确认框')?'已确认':'已取消';</script></html>'''


async def main(families):
    app = web.Application()
    app.router.add_get('/', lambda request: web.Response(text=HTML, content_type='text/html'))
    app.router.add_get('/frame', lambda request: web.Response(text='<button>框架按钮</button>', content_type='text/html'))
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    try:
        params = StdioServerParameters(command=sys.executable, cwd=str(ROOT), args=['-m', 'browser_bridge.mcp_server'])
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as mcp:
                await mcp.initialize()
                async def call(name, **arguments):
                    result = await mcp.call_tool('browser_' + name, arguments)
                    if result.isError:
                        raise RuntimeError(str(result.content))
                    return result if any(item.type == 'image' for item in result.content) else json.loads(result.content[0].text)
                browsers = (await call('list_browsers'))['browsers']
                for family in families:
                    candidates = [browser for browser in browsers if browser['family'] == family]
                    if len(candidates) != 1:
                        raise RuntimeError(f'Expected one connected {family} profile; found {len(candidates)}')
                    browser_id = candidates[0]['browser_id']
                    url = f'http://127.0.0.1:{port}/?test={secrets.token_hex(6)}'
                    print(f'{family} local test URL: {url}', flush=True)
                    paths = ([Path(os.environ['PROGRAMFILES']) / 'Google/Chrome/Application/chrome.exe',
                              Path(os.environ['LOCALAPPDATA']) / 'Google/Chrome/Application/chrome.exe'] if family == 'chrome' else
                             [Path(os.environ['PROGRAMFILES(X86)']) / 'Microsoft/Edge/Application/msedge.exe',
                              Path(os.environ['PROGRAMFILES']) / 'Microsoft/Edge/Application/msedge.exe'])
                    executable = next(path for path in paths if path.exists())
                    # Existing browser receives this new local test tab in its normal profile.
                    subprocess.Popen([str(executable), '--new-tab', url], creationflags=subprocess.CREATE_NO_WINDOW)
                    tab = None
                    for _ in range(50):
                        tabs = (await call('list_tabs', browser_id=browser_id))['tabs']
                        tab = next((tab for tab in tabs if tab['url'] == url and tab['title'] == 'Browser Bridge live test'), None)
                        if tab: break
                        await asyncio.sleep(0.1)
                    if not tab:
                        raise RuntimeError(f'{family} test tab was not found in the connected profile')
                    claim = await call('claim_tab', browser_id=browser_id, tab_id=tab['tab_id'], expected_url=tab['url'], expected_title=tab['title'])
                    handle = claim['tab_handle']
                    async def snapshot_ref(role, name):
                        snap = await call('snapshot', tab_handle=handle)
                        match = re.search(r'\[([^\]]+)\] '+re.escape(role)+r' '+re.escape(json.dumps(name,ensure_ascii=False)), snap['snapshot'])
                        if not match: raise RuntimeError(f'{role} {name} missing from AX snapshot')
                        return match.group(1)
                    try:
                        await call('fill', tab_handle=handle, ref=await snapshot_ref('textbox', '测试姓名'), text='中文 Browser Bridge')
                        text = await call('read_text', tab_handle=handle)
                        assert '输入：中文 Browser Bridge' in text['text'], text
                        await call('click', tab_handle=handle, ref=await snapshot_ref('button', '增加计数'))
                        text = await call('read_text', tab_handle=handle)
                        assert '计数：1' in text['text'], text
                        await call('press_key', tab_handle=handle, key='Tab')
                        await call('scroll', tab_handle=handle, delta_y=100)
                        # A site may keep Input.dispatchMouseEvent pending while confirm() is open.
                        try:
                            await call('click', tab_handle=handle, ref=await snapshot_ref('button', '显示确认框'))
                        except RuntimeError as error:
                            if 'opened a JavaScript dialog' not in str(error): raise
                        dialog = await call('snapshot', tab_handle=handle)
                        assert dialog['dialog']['type'] == 'confirm', dialog
                        await call('handle_dialog', tab_handle=handle, accept=False)
                        text = await call('read_text', tab_handle=handle)
                        assert '已取消' in text['text'], text
                        screenshot = await call('screenshot', tab_handle=handle)
                        import base64
                        path = ROOT / 'test-results' / f'{family}.png'
                        path.parent.mkdir(exist_ok=True)
                        path.write_bytes(base64.b64decode(next(item.data for item in screenshot.content if item.type == 'image')))
                        await call('screenshot', tab_handle=handle, full_page=True)
                        print(f'PASS {family}: claim, AX/iframe, Chinese fill, click, key, scroll, modal, viewport/full PNG ({path.stat().st_size} bytes)', flush=True)
                    finally:
                        await call('release_tab', tab_handle=handle)
    finally:
        await runner.cleanup()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--family', choices=['chrome', 'edge', 'both'], default='both')
    args = parser.parse_args()
    asyncio.run(main(['chrome', 'edge'] if args.family == 'both' else [args.family]))
