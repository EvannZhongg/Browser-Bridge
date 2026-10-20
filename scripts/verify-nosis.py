"""Optional integration test. Run with Nosis's Python, not a Bridge runtime dependency."""
import argparse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--nosis-root', type=Path, required=True)
    parser.add_argument('--config-dir', type=Path, default=Path.home() / '.nosis')
    parser.add_argument('--family', choices=['chrome', 'edge'], default='chrome')
    args = parser.parse_args()
    sys.path.insert(0, str(args.nosis_root.resolve()))
    from agent_core.mcp.config import load_mcp_config
    from agent_core.mcp.manager import McpClientManager
    from agent_core.tools import ToolCatalog, ToolCall, ToolExecutionContext
    from agent_core.session import Session
    from agent_core.workspace import Workspace
    from agent_core.tool_result import ToolResultNormalizer
    from agent_core.tool_batch import ToolBatchExecutor
    from agent_core.providers.base import _message_to_dict
    from agent_core.tools.builtin.read_file import ReadFileTool
    from agent_core.media import MAX_IMAGE_BYTES

    run_id = uuid.uuid4().hex[:10]
    work = ROOT / '.local' / 'nosis-validation' / run_id
    work.mkdir(parents=True)
    fixture_text = 'Bridge Nosis local upload 测试\n'
    file = work / '中文 upload.txt'
    file.write_text(fixture_text, encoding='utf-8')
    long_text = '\n'.join(f'LINE-{n:04d} ' + 'readable content ' * 8 for n in range(350)) + '\nTAILMARK'
    html = '''<!doctype html><meta charset="utf-8"><title>Nosis Bridge contract fixture</title>
<label>Name<input id="name"></label><input type="file" id="file" hidden>
<button onclick="document.querySelector('#file').click()">Choose file</button>
<button onclick="confirm('Nosis fixture confirm')">Confirm</button><pre id="state"></pre>
<div style="height:1600px">scroll area</div><script>
const state={text:'',file:null};function sync(){document.querySelector('#state').textContent='STATE:'+JSON.stringify(state)}
document.querySelector('#name').oninput=e=>{state.text=e.target.value;sync()};
document.querySelector('#file').onchange=async e=>{const file=e.target.files[0];state.file={name:file.name,text:await file.text()};sync()};sync();
</script>'''

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            body = ('<!doctype html><meta charset="utf-8"><title>Nosis Bridge large text</title><pre>' + long_text + '</pre>') if self.path.endswith('/large') else html
            payload = body.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_):
            pass

    http = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=http.serve_forever, daemon=True).start()
    url = f'http://127.0.0.1:{http.server_port}/{run_id}'
    settings = json.loads((args.config_dir / 'agent_config.json').read_text(encoding='utf-8-sig'))['mcp']['servers']['browser_bridge']
    config = load_mcp_config({'enabled': True, 'servers': {'browser_bridge': settings}})
    statuses = []
    client = McpClientManager(config, work, on_status=lambda event: statuses.append(vars(event)))
    samples, errors, handles = [], [], []
    session = Session('bridge-' + run_id)
    context = ToolExecutionContext(workspace=Workspace(work), session=session, mcp=client, vision_input=True,
        sessions_directory=work / '.nosis/sessions')
    normalizer = ToolResultNormalizer(context.workspace, session.session_id, sessions_directory=context.sessions_directory)
    try:
        client.start()
        definitions = client.wait_ready()
        assert len(definitions) == 17, statuses
        tools = ToolCatalog(definitions).select(client.tool_names, context)

        def call(method, arguments=None, allow_error=False):
            result = tools.execute(ToolCall(uuid.uuid4().hex, 'mcp__browser_bridge__browser_' + method, arguments or {}))
            model_text = normalizer.normalize(result)
            assert 'iVBORw0' not in model_text
            if result.error:
                errors.append({'method': method, 'error_type': result.error.type, 'message': result.error.message})
                assert allow_error, result.error
                assert json.loads(model_text)['ok'] is False
                return result, None
            assert result.output.get('structured_content') is None
            data = json.loads(result.output['content'][0]['text'])
            samples.append({'method': method, 'model_chars': len(model_text), 'attachments': len(result.attachments),
                'artifact': 'artifact_path' in json.loads(model_text)})
            return result, data

        _, browsers = call('list_browsers')
        selected = [b for b in browsers['browsers'] if b['family'] == args.family]
        assert len(selected) == 1, 'Select exactly one paired profile for this test'
        browser_id = selected[0]['browser_id']
        exe = (Path(os.environ['PROGRAMFILES']) / 'Google/Chrome/Application/chrome.exe') if args.family == 'chrome' else (
            Path(os.environ['PROGRAMFILES(X86)']) / 'Microsoft/Edge/Application/msedge.exe')
        subprocess.Popen([str(exe), url], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        deadline = time.monotonic() + 15
        tab = None
        while time.monotonic() < deadline:
            _, tabs = call('list_tabs', {'browser_id': browser_id})
            tab = next((tab for tab in tabs['tabs'] if tab['url'] == url and tab['title'] == 'Nosis Bridge contract fixture'), None)
            if tab:
                break
            time.sleep(.1)
        assert tab, 'Local fixture tab was not found'
        _, claimed = call('claim_tab', {'browser_id': browser_id, 'tab_id': tab['tab_id'],
            'expected_url': tab['url'], 'expected_title': tab['title']})
        h = {'tab_handle': claimed['tab_handle']}
        handles.append(h)

        _, extra = call('open_tab', {'browser_id': browser_id, 'url': url + '/extra', 'active': False})
        for _ in range(100):
            _, listed = call('list_tabs', {'browser_id': browser_id})
            extra_tab = next((item for item in listed['tabs'] if item['tab_id'] == extra['tab_id']
                and item['title'] == 'Nosis Bridge contract fixture'), None)
            if extra_tab:
                break
            time.sleep(.1)
        assert extra_tab, 'Extra fixture tab did not load'
        _, extra_claim = call('claim_tab', {'browser_id': browser_id, 'tab_id': extra_tab['tab_id'],
            'expected_url': extra_tab['url'], 'expected_title': extra_tab['title']})
        extra_h = {'tab_handle': extra_claim['tab_handle']}
        handles.append(extra_h)
        call('activate_tab', {**extra_h, 'focus_window': False})
        call('close_tab', extra_h)
        handles.remove(extra_h)
        call('snapshot', extra_h, allow_error=True)
        call('activate_tab', {**h, 'focus_window': False})

        def ref(name, role):
            _, snapshot = call('snapshot', h)
            match = re.search(r'\[([^\]]+)\] ' + role + ' ' + re.escape(json.dumps(name)), snapshot['snapshot'])
            assert match, snapshot['snapshot']
            return match[1]

        _, filled = call('fill', {**h, 'ref': ref('Name', 'textbox'), 'text': 'Nosis 测试'})
        assert filled['value_verified'] is True
        _, dom_filled = call('fill', {**h, 'ref': ref('Name', 'textbox'), 'text': 'Nosis DOM 测试', 'mode': 'dom'})
        assert dom_filled['value_verified'] is True and dom_filled['events_trusted'] is False
        call('press_key', {**h, 'key': 'Tab'})
        call('click', {**h, 'ref': ref('Choose file', 'button')})
        _, chooser = call('snapshot', h)
        assert chooser['file_chooser']['pending'] is True
        call('upload_file', {**h, 'files': [str(file)]})
        for _ in range(40):
            _, state = call('read_text', h)
            if 'Bridge Nosis local upload' in state['text']:
                break
            time.sleep(.05)
        assert 'Bridge Nosis local upload' in state['text']
        screenshot_ref = uuid.uuid4().hex
        turn_id = session.begin_turn('screenshot-turn')
        executor = ToolBatchExecutor(tools, session, normalizer, now=lambda: datetime.now(timezone.utc))
        image_results = []
        executor.execute((ToolCall(screenshot_ref, 'mcp__browser_bridge__browser_screenshot', h),), turn_id=turn_id,
            on_result=lambda result, *_: image_results.append(result))
        image_result = image_results[0]
        assert image_result.error is None, image_result.error
        assert len(image_result.attachments) == 1
        assert session.items[-1].origin == 'tool_media'
        image_message = _message_to_dict(session.items[-1], media_root=work, include_images=True)
        assert any(item['type'] == 'image_url' and item['image_url']['url'].startswith('data:image/png;base64,') for item in image_message['content'])
        text_only = _message_to_dict(session.items[-1], media_root=work, include_images=False)
        assert isinstance(text_only['content'], str) and 'base64' not in text_only['content']
        assert 'iVBORw0' not in session.items[-2].content
        metadata = json.loads(image_result.output['content'][0]['text'])
        assert metadata['capture']['image_to_viewport_css']['scale_x'] > 0
        samples.append({'method': 'screenshot', 'model_chars': len(session.items[-2].content), 'attachments': 1,
            'image_bytes': image_result.attachments[0].size_bytes, 'provider_image_url': True, 'artifact': False})
        call('scroll', {**h, 'delta_y': 300})
        call('click', {**h, 'ref': ref('Confirm', 'button')}, allow_error=True)
        _, dialog = call('snapshot', h)
        assert dialog['dialog']['type'] == 'confirm'
        call('handle_dialog', {**h, 'accept': False})
        call('read_text', {'tab_handle': 'expired-contract-handle'}, allow_error=True)
        call('list_browsers')  # A tool error must not poison the physical connection.
        call('navigate', {**h, 'url': url + '/large'})
        for _ in range(40):
            result, body = call('read_text', {**h, 'max_chars': 100000})
            if 'TAILMARK' in body['text']:
                break
            time.sleep(.05)
        assert 'TAILMARK' in body['text']
        artifact = json.loads(normalizer.normalize(result))
        assert 'artifact_path' in artifact
        offset, pages, truncated_line = 1, [], False
        for _ in range(20):
            read = ReadFileTool().execute({'path': artifact['artifact_path'], 'offset': offset}, context)
            pages.append(read['content'])
            truncated_line |= '该行被截断' in read['content']
            following = re.search(r'Use offset=(\d+) to continue', read['content'])
            if not following:
                break
            offset = int(following[1])
        paging_limitation = truncated_line and 'TAILMARK' not in '\n'.join(pages)
        call('release_tab', h)
        handles.clear()
        assert set(sample['method'] for sample in samples) == {
            'list_browsers','list_tabs','open_tab','activate_tab','close_tab','claim_tab','release_tab','snapshot','read_text','click','fill','press_key',
            'scroll','navigate','handle_dialog','upload_file','screenshot'}
        report = {'family': args.family, 'tools': len(definitions), 'statuses': statuses, 'samples': samples,
            'command': settings['command'], 'args': settings.get('args', []),
            'errors': errors, 'media_origin': 'tool_media', 'text_only_image_notice': True, 'image_limit_bytes': MAX_IMAGE_BYTES,
            'oversized_text_artifact': True, 'artifact_pages': len(pages), 'artifact_paging_limitation': paging_limitation}
        out = ROOT / 'test-results'
        out.mkdir(exist_ok=True)
        report_path = out / f'nosis-contract-{args.family}.json'
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({'report':str(report_path),'tools':len(definitions),'samples':len(samples),'errors':errors,
            'media_origin':'tool_media','provider_image_url':True,'artifact_paging_limitation':paging_limitation}, ensure_ascii=False))
    finally:
        for h in handles:
            try:
                client.call_tool('browser_bridge', 'browser_release_tab', h)
            except Exception:
                pass
        client.close()
        http.shutdown()
        http.server_close()


if __name__ == '__main__':
    main()
