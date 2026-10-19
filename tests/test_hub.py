import asyncio
import base64
import json
from pathlib import Path
import sys
import tempfile
import unittest

import aiohttp
from aiohttp import web
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from browser_bridge.client import BridgeClient
from browser_bridge.config import ROOT
from browser_bridge.hub import application

PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1kAAAAASUVORK5CYII='


class HubTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.config = {"port": 47831, "token": "test-pairing-token-" * 4, "extension_id": "a" * 32}
        self.app = application(self.config)
        self.runner = web.AppRunner(self.app, shutdown_timeout=1)
        await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await site.start()
        self.config["port"] = site._server.sockets[0].getsockname()[1]
        self.http = aiohttp.ClientSession()
        self.clients = []
        self.extensions = []
        self.requests = []
        self.released = set()
        self.tabs = [{"tab_id": 9, "url": "http://localhost:8000/", "title": "Demo", "controllable": True},
                     {"tab_id": 10, "url": "https://example.com/", "title": "Example", "controllable": True}]

    async def asyncTearDown(self):
        for client in self.clients:
            await client.close()
        await asyncio.sleep(0.05)
        for ws, task in self.extensions:
            await ws.close()
            await task
        await self.http.close()
        await self.runner.cleanup()

    async def extension(self, family="chrome", instance="profile-1", run="run-1"):
        ws = await self.http.ws_connect(f"http://127.0.0.1:{self.config['port']}/extension",
                                       origin=f"chrome-extension://{self.config['extension_id']}")
        await ws.send_json({"type": "hello", "token": self.config["token"], "browser": {
            "family": family, "instance_id": instance, "run_id": run, "profile_name": f"{family} test"}})
        connected = await ws.receive_json()
        async def run_extension():
            async for item in ws:
                if item.type != aiohttp.WSMsgType.TEXT:
                    continue
                data = json.loads(item.data)
                self.requests.append(data)
                command = data.get("command")
                if command == "list_tabs":
                    result = {"tabs": [dict(tab) for tab in self.tabs]}
                elif command == "release_owner":
                    self.released.add(data["owner"])
                    result = {"released": True}
                elif command == "snapshot":
                    result = {"snapshot": '[s1:1] button "Test"', "url": self.tabs[0]["url"]}
                elif command == "screenshot":
                    result = {"data": PNG, "capture": {"scope": "viewport", "css_width": 1, "css_height": 1,
                              "image_origin_css": {"x": 0, "y": 0}, "viewport": {"scroll_x": 0, "scroll_y": 0}}}
                else:
                    result = {"ok": True}
                await ws.send_json({"id": data["id"], "result": result})
        task = asyncio.create_task(run_extension())
        self.extensions.append((ws, task))
        return connected["browser_id"]

    async def client(self):
        client = BridgeClient(self.config)
        self.clients.append(client)
        return client

    async def claim(self, client, browser, tab_id=9):
        tabs = await client.call("list_tabs", {"browser_id": browser})
        tab = next(tab for tab in tabs["tabs"] if tab["tab_id"] == tab_id)
        return await client.call("claim_tab", {"browser_id": browser, "tab_id": tab_id,
                                 "expected_url": tab["url"], "expected_title": tab["title"]})

    async def test_pairing_and_origin_are_required(self):
        with self.assertRaises(aiohttp.WSServerHandshakeError):
            await self.http.ws_connect(f"http://127.0.0.1:{self.config['port']}/extension", origin="https://evil.test")
        with self.assertRaises(aiohttp.WSServerHandshakeError):
            await self.http.ws_connect(f"http://127.0.0.1:{self.config['port']}/client",
                                      origin="https://evil.test", headers={"Authorization": f"Bearer {self.config['token']}"})
        with self.assertRaises(aiohttp.WSServerHandshakeError):
            await self.http.ws_connect(f"http://127.0.0.1:{self.config['port']}/client")
        async with self.http.get(f"http://127.0.0.1:{self.config['port']}/health") as response:
            self.assertEqual(response.status, 401)

    async def test_chrome_and_edge_profiles_are_separately_discovered(self):
        chrome = await self.extension()
        edge = await self.extension("edge", "profile-2")
        result = await (await self.client()).call("list_browsers")
        self.assertEqual({item["browser_id"] for item in result["browsers"]}, {chrome, edge})

    async def test_claim_requires_a_fresh_exact_observation(self):
        browser = await self.extension()
        client = await self.client()
        arguments = {"browser_id": browser, "tab_id": 9, "expected_url": self.tabs[0]["url"], "expected_title": "Demo"}
        with self.assertRaisesRegex(RuntimeError, "latest"):
            await client.call("claim_tab", arguments)
        await client.call("list_tabs", {"browser_id": browser})
        with self.assertRaisesRegex(RuntimeError, "exact"):
            await client.call("claim_tab", {**arguments, "expected_title": "Changed"})
        self.assertFalse(any(item["command"] == "claim_tab" for item in self.requests))

    async def test_ownership_is_exclusive_and_handles_are_connection_scoped(self):
        browser = await self.extension()
        first, second = await self.client(), await self.client()
        claim = await self.claim(first, browser)
        with self.assertRaisesRegex(RuntimeError, "another MCP session"):
            await self.claim(second, browser)
        with self.assertRaisesRegex(RuntimeError, "belongs to another"):
            await second.call("click", {"tab_handle": claim["tab_handle"], "x": 1, "y": 1})
        await self.claim(second, browser, 10)
        await first.call("release_tab", {"tab_handle": claim["tab_handle"]})
        await self.claim(second, browser)

    async def test_disconnect_releases_owner_and_allows_a_new_claim(self):
        browser = await self.extension()
        first = await self.client()
        await self.claim(first, browser)
        await first.close()
        for _ in range(40):
            if self.released:
                break
            await asyncio.sleep(0.01)
        self.assertTrue(self.released)
        await self.claim(await self.client(), browser)

    async def test_browser_restart_expires_handles_and_browser_identity(self):
        browser = await self.extension()
        client = await self.client()
        claim = await self.claim(client, browser)
        await self.extensions[0][0].close()
        await asyncio.sleep(0.02)
        new_browser = await self.extension(run="run-2")
        self.assertNotEqual(browser, new_browser)
        with self.assertRaisesRegex(RuntimeError, "expired"):
            await client.call("snapshot", {"tab_handle": claim["tab_handle"]})

    async def test_real_stdio_mcp_discovery_calls_and_image_content(self):
        browser = await self.extension()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            path.write_text(json.dumps(self.config), encoding="utf-8")
            parameters = StdioServerParameters(command=sys.executable, cwd=str(ROOT),
                         args=["-m", "browser_bridge.mcp_server", "--config", str(path)])
            async with stdio_client(parameters) as (read, write):
                async with ClientSession(read, write) as mcp:
                    await mcp.initialize()
                    names = {tool.name for tool in (await mcp.list_tools()).tools}
                    self.assertEqual(len(names), 13)
                    result = await mcp.call_tool("browser_list_browsers", {})
                    self.assertFalse(result.isError)
                    self.assertIsNone(result.structuredContent)
                    self.assertEqual(json.loads(result.content[0].text)["browsers"][0]["browser_id"], browser)
                    await mcp.call_tool("browser_list_tabs", {"browser_id": browser})
                    claim_result = await mcp.call_tool("browser_claim_tab", {"browser_id": browser, "tab_id": 9,
                                     "expected_title": "Demo", "expected_url": self.tabs[0]["url"]})
                    handle = json.loads(claim_result.content[0].text)["tab_handle"]
                    snapshot = await mcp.call_tool("browser_snapshot", {"tab_handle": handle})
                    self.assertIn('button', snapshot.content[0].text)
                    image = await mcp.call_tool("browser_screenshot", {"tab_handle": handle})
                    self.assertEqual(image.content[0].type, "text")
                    self.assertEqual(image.content[1].type, "image")
                    self.assertEqual(image.content[1].mimeType, "image/png")
                    self.assertEqual(json.loads(image.content[0].text)["capture"]["image_to_viewport_css"]["scale_x"], 1)
                    self.assertEqual(base64.b64decode(image.content[1].data), base64.b64decode(PNG))


if __name__ == "__main__":
    unittest.main()
