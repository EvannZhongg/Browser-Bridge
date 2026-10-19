import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import aiohttp

from .config import ROOT, load_config


async def hub_is_running(config: dict) -> bool:
    try:
        async with aiohttp.ClientSession(trust_env=False) as session:
            async with session.get(f"http://127.0.0.1:{config['port']}/health",
                                   headers={"Authorization": f"Bearer {config['token']}"},
                                   timeout=aiohttp.ClientTimeout(total=1)) as response:
                if response.status != 200:
                    raise RuntimeError("Browser Bridge port is occupied by an unpaired service")
                return (await response.json()).get("service") == "browser-bridge"
    except (aiohttp.ClientConnectorError, TimeoutError):
        return False


async def ensure_hub(config_path: Path) -> dict:
    config = load_config(config_path)
    if await hub_is_running(config):
        return config
    log_path = config_path.parent / "hub.log"
    kwargs = {}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    with log_path.open("ab") as log:
        subprocess.Popen([sys.executable, "-m", "browser_bridge.hub", "--config", str(config_path)],
                         cwd=ROOT, stdin=subprocess.DEVNULL, stdout=log, stderr=log, **kwargs)
    for _ in range(40):
        await asyncio.sleep(0.15)
        if await hub_is_running(config):
            return config
    raise RuntimeError(f"Browser Bridge did not start. See {log_path}")


class BridgeClient:
    def __init__(self, config: dict):
        self.config = config
        self.session: aiohttp.ClientSession | None = None
        self.socket: aiohttp.ClientWebSocketResponse | None = None
        self.lock = asyncio.Lock()
        self.counter = 0

    async def connect(self) -> None:
        if self.session is None:
            self.session = aiohttp.ClientSession(trust_env=False)
        if self.socket is None or self.socket.closed:
            self.socket = await self.session.ws_connect(
                f"http://127.0.0.1:{self.config['port']}/client",
                headers={"Authorization": f"Bearer {self.config['token']}"},
                max_msg_size=24 * 1024 * 1024,
            )

    async def call(self, method: str, arguments: dict | None = None) -> dict:
        async with self.lock:
            await self.connect()
            self.counter += 1
            try:
                await self.socket.send_json({"id": self.counter, "method": method, "arguments": arguments or {}})
                async with asyncio.timeout(50):
                    item = await self.socket.receive()
                if item.type != aiohttp.WSMsgType.TEXT:
                    raise ConnectionError("Browser Bridge connection closed; list and claim again")
                result = json.loads(item.data)
                if result.get("id") != self.counter:
                    raise RuntimeError("Browser Bridge response ID did not match")
                if "error" in result:
                    raise RuntimeError(result["error"])
                return result["result"]
            except (asyncio.CancelledError, TimeoutError, ConnectionError, aiohttp.ClientError):
                # Do not replay input. Closing this client relinquishes its tab claims.
                await self.socket.close()
                self.socket = None
                raise

    async def close(self) -> None:
        if self.socket is not None:
            await self.socket.close()
        if self.session is not None:
            await self.session.close()
