import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = ROOT / ".local" / "config.json"


def load_config(path: str | Path = DEFAULT_CONFIG) -> dict:
    config = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(config.get("token"), str) or len(config["token"]) < 32:
        raise ValueError("Invalid local pairing token; run browser-bridge setup")
    if not isinstance(config.get("port"), int) or not 1024 <= config["port"] <= 65535:
        raise ValueError("Invalid local port")
    return config
