"""
ProxMenux Federation — peer configuration store.

Persists the list of remote ProxMenux nodes that the central instance
aggregates. Stored as JSON at /usr/local/share/proxmenux/federation.json
with 0600 permissions (it holds long-lived peer API tokens).

A node WITHOUT this file behaves exactly like a standalone install — the
federation feature is purely additive.
"""

import json
import os
import threading

DEFAULT_CONFIG_PATH = "/usr/local/share/proxmenux/federation.json"

_lock = threading.Lock()


def config_path():
    return os.environ.get("PROXMENUX_FEDERATION_CONFIG", DEFAULT_CONFIG_PATH)


def _validate_peer(peer):
    """Return a normalized peer dict, or raise ValueError."""
    if not isinstance(peer, dict):
        raise ValueError("peer must be an object")
    name = str(peer.get("name") or "").strip()
    host = str(peer.get("host") or "").strip()
    token = str(peer.get("token") or "").strip()
    if not name:
        raise ValueError("name is required")
    if not host:
        raise ValueError("host is required")
    if not token:
        raise ValueError("token is required")
    try:
        port = int(peer.get("port", 8008))
    except (TypeError, ValueError):
        raise ValueError("port must be an integer")
    if not (1 <= port <= 65535):
        raise ValueError("port must be between 1 and 65535")
    return {
        "name": name,
        "host": host,
        "port": port,
        "token": token,
        "enabled": bool(peer.get("enabled", True)),
    }


def load_peers():
    """Return the list of configured peers (empty list if no/invalid config)."""
    path = config_path()
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r") as fh:
            data = json.load(fh)
    except (json.JSONDecodeError, OSError):
        return []
    raw = data.get("peers", []) if isinstance(data, dict) else []
    result = []
    for p in raw:
        try:
            result.append(_validate_peer(p))
        except ValueError:
            continue
    return result


def save_peers(peers):
    """Atomically write the peer list with 0600 perms. Rejects dup names."""
    normalized = [_validate_peer(p) for p in peers]
    names = [p["name"] for p in normalized]
    if len(names) != len(set(names)):
        raise ValueError("duplicate peer names are not allowed")
    path = config_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with _lock:
        with open(tmp, "w") as fh:
            json.dump({"peers": normalized}, fh, indent=2)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    return normalized


def add_peer(peer):
    peer = _validate_peer(peer)
    peers = load_peers()
    if any(p["name"] == peer["name"] for p in peers):
        raise ValueError("peer '{}' already exists".format(peer["name"]))
    peers.append(peer)
    save_peers(peers)
    return peer


def remove_peer(name):
    peers = load_peers()
    remaining = [p for p in peers if p["name"] != name]
    if len(remaining) == len(peers):
        return False
    save_peers(remaining)
    return True


def get_peer(name):
    for p in load_peers():
        if p["name"] == name:
            return p
    return None
