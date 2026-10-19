"""Run with the Nosis Python environment to inspect its real MCP/media/Artifact path.

The standalone extension and MCP do not import Nosis; this is an integration check.
"""
import argparse
import asyncio
import base64
import json
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT/'test-results/boundaries'


async def check_live_connection():
    from agent_core.mcp.connection import McpConnection, McpConnectionParameters
    settings = json.loads((Path.home()/'.nosis/agent_config.json').read_text(encoding='utf-8-sig'))['mcp']['servers']['browser_bridge']
    connection = McpConnection(McpConnectionParameters(
        transport='stdio', command=settings['command'],
        args=settings['args'], cwd=settings['cwd']))
    task = asyncio.create_task(connection.run())
    try:
        definitions = await asyncio.wait_for(asyncio.shield(connection.ready), 20)
        assert len(definitions)==13
        result = await connection.call_tool('browser_list_browsers', {})
        assert len(json.loads(result['content'][0]['text'])['browsers'])>=2
        try:
            await connection.call_tool('browser_read_text', {'tab_handle':'expired-integration-check'})
        except RuntimeError as error:
            assert 'expired' in str(error).lower()
            return {'type':type(error).__name__, 'message':str(error)}
        raise AssertionError('MCP isError did not become a Nosis exception')
    finally:
        connection.stop.set()
        await asyncio.wait_for(task, 20)


def check_live_broker():
    from agent_core.mcp.config import load_mcp_config
    from agent_runtime.mcp.client import McpClient
    import uuid
    directory=Path.home()/'.nosis'
    settings=json.loads((directory/'agent_config.json').read_text(encoding='utf-8-sig'))['mcp']['servers']['browser_bridge']
    config=load_mcp_config({'enabled':True,'servers':{'browser_bridge':settings}})
    statuses=[]
    client=McpClient(directory,on_status=lambda event: statuses.append(
        {'server':event.server,'status':event.status,'tool_count':event.tool_count,'error':event.error}))
    try:
        handle=client.bind(config,ROOT,'browser-startup-check-'+uuid.uuid4().hex)
        handle.acquire()
        assert len(handle.wait_ready())==13, statuses
        result=handle.call_tool('browser_bridge','browser_list_browsers',{})
        families=sorted(browser['family'] for browser in json.loads(result['content'][0]['text'])['browsers'])
        assert 'chrome' in families and 'edge' in families
        return {'statuses':statuses,'browsers':families,'uses_saved_nosis_config':True}
    finally:
        client.close()


def main(nosis_root):
    sys.path.insert(0, str(nosis_root))
    from mcp.types import CallToolResult
    from agent_core.mcp.tool import _adapt_result_media
    from agent_core.tools.base import ToolError, ToolOutput, ToolResult
    from agent_core.tools.context import ToolExecutionContext
    from agent_core.tool_result import ToolResultNormalizer
    from agent_core.workspace import Workspace
    from agent_core.session import Session
    from PIL import Image

    data = json.loads((OUT/'results.json').read_text(encoding='utf-8'))
    live_error = asyncio.run(check_live_connection())
    live_broker = check_live_broker()
    report = []
    with tempfile.TemporaryDirectory() as directory:
        workspace = Workspace(Path(directory))
        context = ToolExecutionContext(workspace=workspace, session=Session())
        sessions = Path(directory)/'sessions'
        normalizer = ToolResultNormalizer(workspace, 'browser-contract', sessions_directory=sessions)
        for name, sample in data['samples'].items():
            if name=='tool_definitions': continue
            wire = json.loads(json.dumps(sample))
            for item in wire['content']:
                if item['type']=='image': item['data'] = base64.b64encode((OUT/item.pop('data_file')).read_bytes()).decode()
            # Use the same MCP SDK conversion that agent_core.mcp.connection uses.
            result = CallToolResult.model_validate(wire).model_dump(mode='json', exclude_none=True)
            assert not result.get('structured_content'), 'Duplicate structured content reached Nosis'
            adapted = _adapt_result_media(result, context)
            if isinstance(adapted, ToolOutput):
                tool_result = ToolResult('browser-'+name, 'mcp__browser_bridge__browser_'+name,
                                         output=adapted.output, attachments=adapted.attachments)
            else:
                tool_result = ToolResult('browser-'+name, 'mcp__browser_bridge__browser_'+name, output=adapted)
            model_text = normalizer.normalize(tool_result)
            assert 'iVBORw0' not in model_text, 'PNG base64 leaked into model text'
            row = {'tool':name,'envelope_chars':len(model_text),'attachments':len(tool_result.attachments),
                   'inline':not ('artifact_path' in json.loads(model_text)), 'nosis_envelope':json.loads(model_text)}
            if name=='screenshot':
                assert row['attachments']==1
                metadata=json.loads(result['content'][0]['text'])
                assert 'image_to_viewport_css' in metadata['capture']
            report.append(row)
        assert len(report)==13, {row['tool'] for row in report}
        # Oversized output must still use the host's Artifact budget, without server-side truncation hacks.
        oversized = ToolResult('oversized','mcp__browser_bridge__browser_read_text',output={'content':[{'type':'text','text':'长文本'*20000}]})
        spilled=json.loads(normalizer.normalize(oversized))
        assert 'artifact_path' in spilled
        error_envelope=json.loads(normalizer.normalize(ToolResult(
            'expired-integration-check','mcp__browser_bridge__browser_read_text',error=ToolError(**live_error))))
        assert error_envelope['ok'] is False and error_envelope['error']['type']=='RuntimeError'
    pixel_checks=[]
    for family in ['chrome','edge']:
        clean=OUT/f'{family}-clean.png'; preview=OUT/f'{family}-indicators.png'
        if not clean.exists() or not preview.exists(): continue
        with Image.open(clean) as a, Image.open(preview) as b:
            assert a.size==b.size
            # The takeover badge is at the page's upper right, outside the fixture content.
            box=(max(0,a.width-320),0,a.width-20,min(110,a.height))
            av=list(a.convert('RGB').crop(box).getdata()); bv=list(b.convert('RGB').crop(box).getdata())
            green=lambda colors:sum(1 for r,g,blue in colors if g>r*1.5 and g>blue*1.1 and g<180)
            assert green(bv)>100 and green(av)<20, (family,green(av),green(bv))
            pixel_checks.append({'browser':family,'indicator_visible_in_preview':True,'excluded_from_clean_screenshot':True})
    summary={'tools':report,'oversized_output_uses_nosis_artifact':True,'image_checks':pixel_checks,
             'live_nosis_connection_verified':True,'live_nosis_broker':live_broker,'error_envelope':error_envelope}
    (OUT/'nosis-data.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'verified_tools':len(report),'largest_inline_envelope_chars':max(row['envelope_chars'] for row in report),
                      'png_base64_in_text':False,'oversized_output_uses_artifact':True,'image_checks':pixel_checks,
                      'live_nosis_connection_verified':True,'live_nosis_broker':live_broker,'error_envelope':error_envelope},ensure_ascii=False))


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--nosis-root',type=Path,default=Path('F:/Nosis'))
    args=parser.parse_args();main(args.nosis_root)
