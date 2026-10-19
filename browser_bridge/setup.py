"""Local pairing and optional MCP configuration; never imports the agent host."""
import argparse
import asyncio
import base64
import getpass
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
from datetime import datetime

import aiohttp
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from .client import ensure_hub, hub_is_running
from .config import DEFAULT_CONFIG, ROOT, load_config


def private_access(path: Path) -> None:
    if os.name == "nt":
        account = f"{os.environ['USERDOMAIN']}\\{getpass.getuser()}"
        grants = [f"{account}:(OI)(CI)F", "*S-1-5-18:(OI)(CI)F"] if path.is_dir() else [f"{account}:F", "*S-1-5-18:F"]
        subprocess.run(["icacls", str(path), "/inheritance:r", "/grant:r", *grants], check=True, capture_output=True)
    else:
        path.chmod(0o700 if path.is_dir() else 0o600)


def write_json(path: Path, data: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def pair(config_path: Path) -> dict:
    config_path.parent.mkdir(parents=True, exist_ok=True)
    private_access(config_path.parent)
    manifest_path = ROOT / "extension" / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if config_path.exists():
        config = load_config(config_path)
        if not manifest.get("key"):
            raise RuntimeError("Existing pairing has no extension key; restore the original extension manifest before setup")
    else:
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048).public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        manifest["key"] = base64.b64encode(key).decode()
        extension_id = "".join(chr(ord("a") + int(char, 16)) for char in hashlib.sha256(key).hexdigest()[:32])
        config = {"port": 47831, "token": secrets.token_urlsafe(48), "extension_id": extension_id}
        write_json(config_path, config)
    manifest["content_security_policy"] = {"extension_pages": f"script-src 'self'; object-src 'self'; connect-src ws://127.0.0.1:{config['port']}"}
    write_json(manifest_path, manifest)
    generated = ROOT / "extension" / "config.generated.js"
    generated.write_text("// Generated per machine; contains a local pairing secret. Do not publish.\nexport const CONNECTION = "
                         + json.dumps({"url": f"ws://127.0.0.1:{config['port']}/extension", "token": config["token"]}) + ";\n", encoding="utf-8")
    private_access(config_path)
    private_access(generated)
    return config


def mcp_settings(config_path: Path) -> dict:
    return {"command": sys.executable, "args": ["-u", "-m", "browser_bridge.mcp_server", "--config", str(config_path)],
            "cwd": str(ROOT), "scope": "session", "startup_timeout_seconds": 20,
            "call_timeout_seconds": 60, "tools": {"approval": "always"}}


def configure_nosis(directory: Path, config_path: Path) -> Path:
    path = directory / "agent_config.json"
    if not path.exists():
        raise FileNotFoundError(f"Nosis configuration was not found: {path}")
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    mcp = data.setdefault("mcp", {"enabled": True, "servers": {}})
    settings = mcp_settings(config_path)
    existing = mcp.setdefault("servers", {}).get("browser_bridge")
    if existing != settings or not mcp.get("enabled"):
        backup = path.with_name(f"agent_config.browser-bridge-{datetime.now():%Y%m%d-%H%M%S-%f}.bak.json")
        shutil.copy2(path, backup)
        mcp["enabled"] = True
        mcp["servers"]["browser_bridge"] = settings
        write_json(path, data)
        print(f"Nosis configuration backup: {backup}")
    return path


async def status(config_path: Path) -> None:
    from .client import BridgeClient
    config = load_config(config_path)
    if not await hub_is_running(config):
        print("Local hub is stopped. Start an MCP client or run: browser-bridge start")
        return
    client = BridgeClient(config)
    try:
        print(json.dumps(await client.call("list_browsers"), ensure_ascii=False, indent=2))
    finally:
        await client.close()


async def stop(config_path: Path) -> None:
    config = load_config(config_path)
    async with aiohttp.ClientSession(trust_env=False) as session:
        async with session.post(f"http://127.0.0.1:{config['port']}/shutdown",
                                headers={"Authorization": f"Bearer {config['token']}"}) as response:
            response.raise_for_status()
    print("Local hub stopped; extension control released.")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["setup", "start", "status", "stop"])
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--nosis", type=Path, nargs="?", const=Path.home() / ".nosis")
    args = parser.parse_args()
    if args.action == "setup":
        config = pair(args.config)
        exported = {"mcpServers": {"browser_bridge": {key: value for key, value in mcp_settings(args.config).items()
                    if key in {"command", "args", "cwd"}}}}
        write_json(ROOT / "mcp-config.json", exported)
        if args.nosis:
            print(f"Configured Nosis: {configure_nosis(args.nosis, args.config)}")
        print(f"Extension folder: {ROOT / 'extension'}")
        print(f"Extension ID: {config['extension_id']}")
        print(f"Pairing configuration: {args.config} (token is not printed)")
        asyncio.run(ensure_hub(args.config))
    elif args.action == "start":
        asyncio.run(ensure_hub(args.config))
        print("Local hub started on loopback.")
    elif args.action == "status":
        asyncio.run(status(args.config))
    else:
        asyncio.run(stop(args.config))


if __name__ == "__main__":
    main()
