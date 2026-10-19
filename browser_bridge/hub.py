"""Loopback-only rendezvous and exclusive tab ownership across MCP clients."""

import argparse
import asyncio
import hmac
import json
import logging
import secrets
from dataclasses import dataclass, field

from aiohttp import WSMsgType, web

from .config import DEFAULT_CONFIG, load_config

LOG = logging.getLogger("browser_bridge")
MAX_MESSAGE = 24 * 1024 * 1024


class OperationTimeout(RuntimeError):
    pass


@dataclass(eq=False)
class Browser:
    id: str
    socket: web.WebSocketResponse
    info: dict
    pending: dict[str, asyncio.Future] = field(default_factory=dict)

    async def request(self, owner: str, command: str, arguments: dict) -> dict:
        request_id = secrets.token_hex(12)
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        try:
            await self.socket.send_json({"id": request_id, "owner": owner, "command": command, "arguments": arguments})
            async with asyncio.timeout(45):
                return await future
        except TimeoutError:
            raise OperationTimeout("Browser operation timed out; its outcome may be unknown. This connection will release its tabs. List and claim again before another action.") from None
        finally:
            self.pending.pop(request_id, None)


class Hub:
    def __init__(self, config: dict):
        self.config = config
        self.browsers: dict[str, Browser] = {}
        self.claims: dict[str, dict] = {}
        self.tab_claims: dict[tuple[str, int], str] = {}
        self.locks: dict[tuple[str, int], asyncio.Lock] = {}
        self.clients: set[web.WebSocketResponse] = set()

    def authorized(self, token: object) -> bool:
        return isinstance(token, str) and hmac.compare_digest(token, self.config["token"])

    async def health(self, request: web.Request) -> web.Response:
        if not self.authorized(request.headers.get("Authorization", "").removeprefix("Bearer ")):
            raise web.HTTPUnauthorized()
        return web.json_response({"service": "browser-bridge", "version": "0.1.0", "browsers": len(self.browsers)})

    async def stop(self, request: web.Request) -> web.Response:
        if request.headers.get("Origin") or not self.authorized(request.headers.get("Authorization", "").removeprefix("Bearer ")):
            raise web.HTTPForbidden()
        request.app[STOP_EVENT].set()
        return web.json_response({"stopping": True})

    async def extension(self, request: web.Request) -> web.WebSocketResponse:
        expected = f"chrome-extension://{self.config['extension_id']}"
        if request.headers.get("Origin") != expected:
            raise web.HTTPForbidden(text="Extension origin is not paired")
        ws = web.WebSocketResponse(max_msg_size=MAX_MESSAGE, heartbeat=25)
        await ws.prepare(request)
        browser = None
        try:
            async with asyncio.timeout(5):
                message = await ws.receive_json()
            if not self.authorized(message.get("token")) or message.get("type") != "hello":
                await ws.close(code=1008, message=b"Pairing failed")
                return ws
            info = message.get("browser", {})
            if (info.get("family") not in {"chrome", "edge"}
                    or not all(isinstance(info.get(k), str) and 1 <= len(info[k]) <= 128
                               for k in ("instance_id", "run_id", "profile_name"))):
                raise ValueError("Invalid browser identity")
            browser_id = f"{info['instance_id']}:{info['run_id']}"
            if browser_id in self.browsers:
                await ws.close(code=1008, message=b"Browser instance is already connected")
                return ws
            browser = Browser(browser_id, ws, info)
            self.browsers[browser_id] = browser
            LOG.info("Browser connected: %s (%s)", info["family"], info["profile_name"])
            await ws.send_json({"type": "connected", "browser_id": browser_id})
            async for item in ws:
                if item.type != WSMsgType.TEXT:
                    continue
                data = json.loads(item.data)
                if data.get("type") == "ping":
                    await ws.send_json({"type": "pong"})
                elif data.get("type") == "detached":
                    handle = self.tab_claims.get((browser_id, data.get("tab_id")))
                    if handle:
                        self.forget_claim(handle)
                elif data.get("id") in browser.pending:
                    future = browser.pending[data["id"]]
                    if not future.done():
                        if "error" in data:
                            future.set_exception(RuntimeError(str(data["error"])))
                        else:
                            future.set_result(data.get("result", {}))
        except (ValueError, TimeoutError, ConnectionError) as error:
            LOG.warning("Extension connection ended: %s", error)
        finally:
            if browser and self.browsers.get(browser.id) is browser:
                del self.browsers[browser.id]
                for future in browser.pending.values():
                    if not future.done():
                        future.set_exception(ConnectionError("Browser disconnected; observe again after reconnecting"))
                for handle, claim in list(self.claims.items()):
                    if claim["browser_id"] == browser.id:
                        self.forget_claim(handle)
                for key in list(self.locks):
                    if key[0] == browser.id:
                        self.locks.pop(key, None)
            await ws.close()
        return ws

    def forget_claim(self, handle: str) -> None:
        claim = self.claims.pop(handle, None)
        if claim:
            self.tab_claims.pop((claim["browser_id"], claim["tab_id"]), None)

    async def client(self, request: web.Request) -> web.WebSocketResponse:
        # Websites must not be able to use the privileged MCP endpoint.
        if request.headers.get("Origin") or not self.authorized(request.headers.get("Authorization", "").removeprefix("Bearer ")):
            raise web.HTTPForbidden()
        # This socket's receive loop executes a request before reading the next
        # frame. A heartbeat here would mistake a slow screenshot for a dead peer.
        ws = web.WebSocketResponse(max_msg_size=MAX_MESSAGE)
        await ws.prepare(request)
        self.clients.add(ws)
        owner = secrets.token_hex(24)
        observed: dict[tuple[str, int], dict] = {}
        try:
            async for message in ws:
                if message.type != WSMsgType.TEXT:
                    continue
                request_data = json.loads(message.data)
                try:
                    result = await self.execute(owner, observed, request_data["method"], request_data.get("arguments", {}))
                    await ws.send_json({"id": request_data["id"], "result": result})
                except Exception as error:
                    await ws.send_json({"id": request_data.get("id"), "error": str(error)})
                    if isinstance(error, OperationTimeout):
                        break
        finally:
            self.clients.discard(ws)
            # Browser extension owns actual debugger detachment. Cleanup is queued
            # behind in-flight commands there, rather than racing an input event.
            await asyncio.gather(*(browser.request(owner, "release_owner", {})
                                   for browser in list(self.browsers.values())), return_exceptions=True)
            for handle, claim in list(self.claims.items()):
                if claim["owner"] == owner:
                    self.forget_claim(handle)
            await ws.close()
        return ws

    async def execute(self, owner: str, observed: dict, method: str, args: dict) -> dict:
        if method == "list_browsers":
            return {"browsers": [{"browser_id": browser.id, **browser.info,
                                  "capabilities": ["tabs", "claim", "ax_snapshot", "text", "click", "fill", "keyboard", "scroll", "navigate", "screenshot", "handle_dialog", "visual_indicator"]}
                                 for browser in self.browsers.values()],
                    "hint": "Load the paired extension in each Chrome/Edge profile if the list is empty."}
        if method in {"list_tabs", "claim_tab"}:
            browser_id = args["browser_id"]
            browser = self.browsers.get(browser_id)
            if browser is None:
                raise ValueError("Browser is not connected; call browser_list_browsers again")
            if method == "list_tabs":
                result = await browser.request(owner, "list_tabs", {})
                for key in list(observed):
                    if key[0] == browser_id:
                        observed.pop(key)
                for tab in result["tabs"]:
                    observed[(browser_id, tab["tab_id"])] = tab
                    handle = self.tab_claims.get((browser_id, tab["tab_id"]))
                    tab["control"] = "available" if handle is None else ("yours" if self.claims[handle]["owner"] == owner else "another_session")
                return result
            tab_id = args["tab_id"]
            snapshot = observed.get((browser_id, tab_id))
            if snapshot is None or snapshot["url"] != args["expected_url"] or snapshot["title"] != args["expected_title"]:
                raise ValueError("Claim requires an exact URL/title from this session's latest browser_list_tabs result")
            key = (browser_id, tab_id)
            async with self.locks.setdefault(key, asyncio.Lock()):
                existing = self.tab_claims.get(key)
                if existing:
                    if self.claims[existing]["owner"] != owner:
                        raise PermissionError("Tab is controlled by another MCP session; release it there first")
                    return {"claimed": True, "activation_requested": False, "tab_handle": existing,
                            "browser_id": browser_id, "tab_id": tab_id, "title": snapshot["title"], "url": snapshot["url"]}
                handle = secrets.token_urlsafe(24)
                result = await browser.request(owner, "claim_tab", {**args, "tab_handle": handle})
                self.claims[handle] = {"owner": owner, "browser_id": browser_id, "tab_id": tab_id}
                self.tab_claims[key] = handle
                return {**result, "tab_handle": handle, "browser_id": browser_id, "tab_id": tab_id,
                        "title": snapshot["title"], "url": snapshot["url"]}
        allowed = {"release_tab", "snapshot", "read_text", "click", "fill", "press_key", "scroll", "navigate", "screenshot", "handle_dialog"}
        if method not in allowed:
            raise ValueError(f"Unknown browser operation: {method}")
        handle = args.get("tab_handle")
        claim = self.claims.get(handle)
        if claim is None or claim["owner"] != owner:
            raise PermissionError("Tab handle is absent, expired or belongs to another MCP session; list and claim again")
        key = (claim["browser_id"], claim["tab_id"])
        async with self.locks.setdefault(key, asyncio.Lock()):
            if self.claims.get(handle) is not claim:
                raise ValueError("Tab was released while this operation was waiting")
            browser = self.browsers.get(claim["browser_id"])
            if browser is None:
                raise ConnectionError("Browser disconnected")
            result = await browser.request(owner, method, {**args, "tab_id": claim["tab_id"]})
            if method == "release_tab":
                self.forget_claim(handle)
            return {**result, "tab_handle": handle, "tab_id": claim["tab_id"]}

    async def shutdown(self, app: web.Application) -> None:
        await asyncio.gather(*(ws.close(code=1001) for ws in list(self.clients)), return_exceptions=True)
        await asyncio.gather(*(browser.socket.close(code=1001) for browser in list(self.browsers.values())), return_exceptions=True)


STOP_EVENT = web.AppKey("stop_event", asyncio.Event)


def application(config: dict) -> web.Application:
    hub = Hub(config)
    app = web.Application(client_max_size=MAX_MESSAGE)
    app[STOP_EVENT] = asyncio.Event()
    app.add_routes([web.get("/health", hub.health), web.get("/extension", hub.extension), web.get("/client", hub.client), web.post("/shutdown", hub.stop)])
    app.on_shutdown.append(hub.shutdown)
    return app


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    args = parser.parse_args()
    config = load_config(args.config)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    async def serve():
        app = application(config)
        runner = web.AppRunner(app, access_log=None, shutdown_timeout=5)
        await runner.setup()
        await web.TCPSite(runner, "127.0.0.1", config["port"]).start()
        LOG.info("Browser Bridge listening on loopback port %s", config["port"])
        try:
            await app[STOP_EVENT].wait()
        finally:
            await runner.cleanup()
    asyncio.run(serve())


if __name__ == "__main__":
    main()
