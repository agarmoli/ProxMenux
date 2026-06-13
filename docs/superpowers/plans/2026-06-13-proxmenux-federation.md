# ProxMenux Federation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an additive "federation" layer so one ProxMenux node (the *central* node) presents every node of a single Proxmox cluster in one dashboard, reusing each node's existing data collection and REST API.

**Architecture:** Each node keeps running ProxMenux unchanged (it collects its own local data — temps, SMART, hardware, health — and serves it over its authenticated REST API). The central node gains: (1) a peer-config store, (2) an HTTP peer client that verifies TLS against the Proxmox cluster CA, (3) a Flask blueprint exposing aggregate endpoints (`/api/federation/*`) and a reverse proxy (`/api/proxy/<node>/...`), and (4) frontend wiring (node selector, Cluster overview, Federation settings). With no peer config present, behavior is byte-for-byte the current single-node experience.

**Tech Stack:** Python 3 / Flask (backend, bundled libs: `requests`, `PyJWT`, `gevent`), pytest (new — dev only), Next.js 15 / React 19 / TypeScript / shadcn-ui (frontend).

---

## Key facts established from the codebase

- Blueprints carry full paths (no `url_prefix`) and are registered in `AppImage/scripts/flask_server.py:206-213`; imports at lines `72-81`. Mirror `flask_health_routes.py`.
- Auth decorator: `from jwt_middleware import require_auth` (`AppImage/scripts/jwt_middleware.py:12`). When auth is disabled/declined it passes through. A stricter `require_admin_scope` exists for mutating routes; API tokens default to `read_only` scope (`flask_auth_routes.py:580`). **Consequence:** to allow remote VM control through the proxy, the peer token stored on the central node must be generated with `scope: full_admin`.
- `/api/system` returns keys incl. `cpu_usage`, `memory_usage`, `temperature`, `uptime`, `proxmox_node` (`flask_server.py:7691-7712`).
- `/api/health/status` returns `{status, summary, critical_count, warning_count, ok_count}` (`health_monitor.py:707-714`).
- `/api/vms` returns a **JSON array** (`flask_server.py:9821`, `get_proxmox_vms()` returns `all_vms`).
- Frontend funnels every call through `getApiUrl`/`fetchApi` in `AppImage/lib/api-config.ts` — single choke point for routing to a node.
- Bundled Python deps include `requests`, `PyJWT`, `gevent` (`AppImage/scripts/build_appimage.sh:272-309`). gevent `monkey.patch_all()` is active (`flask_server.py:29-33`), so `requests` cooperates with the event loop.
- New `.py` files are **not** auto-globbed into the AppImage — each needs an explicit `cp` line in `build_appimage.sh` (~lines 115-144).
- No test framework exists today. We introduce pytest **for the new backend modules only** (dev-time; not bundled). Frontend changes are verified manually (build + browser) — adding a JS test runner is out of scope.

## File structure

**Create (backend):**
- `AppImage/scripts/federation_config.py` — peer list persistence + validation (`/usr/local/share/proxmenux/federation.json`, `0600`).
- `AppImage/scripts/peer_client.py` — HTTP client to peers; TLS via `/etc/pve/pve-root-ca.pem`.
- `AppImage/scripts/flask_federation_routes.py` — `federation_bp` blueprint (peers CRUD/test, nodes, overview, vms, proxy).
- `AppImage/scripts/tests/conftest.py` — puts `scripts/` on `sys.path`.
- `AppImage/scripts/tests/requirements-dev.txt` — `pytest`.
- `AppImage/scripts/tests/test_federation_config.py`
- `AppImage/scripts/tests/test_peer_client.py`
- `AppImage/scripts/tests/test_federation_routes.py`

**Create (frontend):**
- `AppImage/components/node-selector.tsx` — header dropdown to pick the active node.
- `AppImage/components/cluster-overview.tsx` — per-node summary cards (the "Cluster" tab).
- `AppImage/components/federation-setup.tsx` — settings panel to add/remove/test peers.

**Modify:**
- `AppImage/scripts/flask_server.py` — import + register `federation_bp`.
- `AppImage/scripts/build_appimage.sh` — `cp` the 3 new `.py` files.
- `AppImage/lib/api-config.ts` — active-node helpers + proxy routing in `getApiUrl`.
- `AppImage/components/proxmox-dashboard.tsx` — mount node selector, add "Cluster" tab, disable terminal on remote nodes.
- `AppImage/components/settings.tsx` — mount `<FederationSetup />`.
- `README.md`, `CHANGELOG.md` — document the feature.

---

## Phase 1 — Backend: peer config store

### Task 1: `federation_config.py` (peer persistence + validation)

**Files:**
- Create: `AppImage/scripts/federation_config.py`
- Create: `AppImage/scripts/tests/conftest.py`
- Create: `AppImage/scripts/tests/requirements-dev.txt`
- Test: `AppImage/scripts/tests/test_federation_config.py`

- [ ] **Step 1: Create the test bootstrap files**

`AppImage/scripts/tests/conftest.py`:

```python
import os
import sys

# Make the sibling modules (federation_config, peer_client, ...) importable
# when pytest is run from anywhere.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
```

`AppImage/scripts/tests/requirements-dev.txt`:

```
pytest>=8.0
```

- [ ] **Step 2: Write the failing tests**

`AppImage/scripts/tests/test_federation_config.py`:

```python
import os
import pytest
import federation_config as fc


@pytest.fixture
def cfg(tmp_path, monkeypatch):
    path = tmp_path / "federation.json"
    monkeypatch.setenv("PROXMENUX_FEDERATION_CONFIG", str(path))
    return path


def test_load_empty_when_no_file(cfg):
    assert fc.load_peers() == []


def test_add_and_get_peer(cfg):
    fc.add_peer({"name": "pve2", "host": "pve2.lan", "port": 8008, "token": "abc"})
    peers = fc.load_peers()
    assert len(peers) == 1
    assert peers[0]["name"] == "pve2"
    assert peers[0]["enabled"] is True
    assert fc.get_peer("pve2")["host"] == "pve2.lan"


def test_file_has_0600_perms(cfg):
    fc.add_peer({"name": "pve2", "host": "pve2.lan", "token": "abc"})
    assert oct(os.stat(cfg).st_mode & 0o777) == "0o600"


def test_reject_duplicate_name(cfg):
    fc.add_peer({"name": "pve2", "host": "pve2.lan", "token": "abc"})
    with pytest.raises(ValueError):
        fc.add_peer({"name": "pve2", "host": "other.lan", "token": "xyz"})


def test_missing_token_rejected(cfg):
    with pytest.raises(ValueError):
        fc.add_peer({"name": "pve2", "host": "pve2.lan", "token": ""})


def test_invalid_port_rejected(cfg):
    with pytest.raises(ValueError):
        fc.add_peer({"name": "pve2", "host": "pve2.lan", "token": "abc", "port": 99999})


def test_remove_peer(cfg):
    fc.add_peer({"name": "pve2", "host": "pve2.lan", "token": "abc"})
    assert fc.remove_peer("pve2") is True
    assert fc.load_peers() == []
    assert fc.remove_peer("nope") is False
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd AppImage/scripts && python -m pytest tests/test_federation_config.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'federation_config'`

- [ ] **Step 4: Write the implementation**

`AppImage/scripts/federation_config.py`:

```python
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd AppImage/scripts && python -m pytest tests/test_federation_config.py -v`
Expected: PASS (7 passed)

- [ ] **Step 6: Commit**

```bash
git add AppImage/scripts/federation_config.py AppImage/scripts/tests/
git commit -m "feat(federation): peer config store with validation"
```

---

## Phase 2 — Backend: peer HTTP client

### Task 2: `peer_client.py` (TLS-verified HTTP to peers)

**Files:**
- Create: `AppImage/scripts/peer_client.py`
- Test: `AppImage/scripts/tests/test_peer_client.py`

- [ ] **Step 1: Write the failing tests**

`AppImage/scripts/tests/test_peer_client.py`:

```python
import requests
from unittest.mock import patch, MagicMock
import peer_client

PEER = {"name": "pve2", "host": "pve2.lan", "port": 8008, "token": "tok"}


def _resp(status=200, json_data=None, ok=None):
    m = MagicMock()
    m.status_code = status
    m.ok = (200 <= status < 400) if ok is None else ok
    if json_data is None:
        m.json.side_effect = ValueError("no json")
    else:
        m.json.return_value = json_data
    return m


def test_fetch_json_success_sends_bearer_token():
    with patch("peer_client.requests.request", return_value=_resp(200, {"a": 1})) as rq:
        out = peer_client.fetch_json(PEER, "/api/system")
    assert out["online"] is True
    assert out["status"] == 200
    assert out["data"] == {"a": 1}
    assert out["error"] is None
    _, kwargs = rq.call_args
    assert kwargs["headers"]["Authorization"] == "Bearer tok"


def test_fetch_json_offline_on_network_error():
    with patch("peer_client.requests.request",
               side_effect=requests.exceptions.ConnectTimeout("boom")):
        out = peer_client.fetch_json(PEER, "/api/system")
    assert out["online"] is False
    assert out["data"] is None
    assert "boom" in out["error"]


def test_fetch_json_401_is_online_with_error():
    with patch("peer_client.requests.request",
               return_value=_resp(401, {"error": "x"}, ok=False)):
        out = peer_client.fetch_json(PEER, "/api/system")
    assert out["online"] is True
    assert out["status"] == 401
    assert out["error"] == "HTTP 401"


def test_raw_request_builds_https_url_with_token():
    with patch("peer_client.requests.request", return_value=_resp(200, {})) as rq:
        peer_client.raw_request(PEER, "GET", "/api/vms")
    args, kwargs = rq.call_args
    assert args[0] == "GET"
    assert args[1] == "https://pve2.lan:8008/api/vms"
    assert kwargs["headers"]["Authorization"] == "Bearer tok"
    assert kwargs["verify"] is not False  # never disable TLS verification
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd AppImage/scripts && python -m pytest tests/test_peer_client.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'peer_client'`

- [ ] **Step 3: Write the implementation**

`AppImage/scripts/peer_client.py`:

```python
"""
ProxMenux Federation — HTTP client for remote peers.

Talks to other ProxMenux instances over their authenticated REST API.
TLS is verified against the Proxmox cluster CA (/etc/pve/pve-root-ca.pem),
which signs every node's certificate inside a cluster and is available on
the central node. Verification is never disabled — connect to peers by
hostname/FQDN so the cert CN matches.
"""

import json
import os
import requests

PVE_CLUSTER_CA = "/etc/pve/pve-root-ca.pem"


def _verify_arg():
    # All nodes in a Proxmox cluster share this CA via the /etc/pve cluster
    # filesystem, so the central node can verify peer certificates against it.
    # Fall back to the system trust store when the file is absent (dev hosts).
    if os.path.exists(PVE_CLUSTER_CA):
        return PVE_CLUSTER_CA
    return True


def raw_request(peer, method, path, *, params=None, data=None,
                headers=None, timeout=15):
    """Forward a request to a peer and return the requests.Response.

    Raises requests.exceptions.RequestException on network failure; the
    caller (proxy route) maps that to a 502.
    """
    url = "https://{host}:{port}{path}".format(
        host=peer["host"], port=int(peer["port"]), path=path)
    h = {}
    if peer.get("token"):
        h["Authorization"] = "Bearer {}".format(peer["token"])
    if headers:
        h.update(headers)
    return requests.request(method, url, params=params, data=data,
                            headers=h, timeout=timeout, verify=_verify_arg())


def fetch_json(peer, path, *, method="GET", json_body=None, params=None,
               timeout=8):
    """Fetch JSON from a peer. Never raises. Returns:
        {"online": bool, "status": int|None, "data": Any, "error": str|None}
    online is False only on a network failure; an HTTP error (401/500) is
    still "online" with a populated error string.
    """
    headers = {"Accept": "application/json"}
    data = None
    if json_body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(json_body)
    try:
        resp = raw_request(peer, method, path, params=params, data=data,
                           headers=headers, timeout=timeout)
    except requests.exceptions.RequestException as exc:
        return {"online": False, "status": None, "data": None, "error": str(exc)}
    parsed = None
    try:
        parsed = resp.json()
    except ValueError:
        parsed = None
    return {
        "online": True,
        "status": resp.status_code,
        "data": parsed,
        "error": None if resp.ok else "HTTP {}".format(resp.status_code),
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd AppImage/scripts && python -m pytest tests/test_peer_client.py -v`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add AppImage/scripts/peer_client.py AppImage/scripts/tests/test_peer_client.py
git commit -m "feat(federation): TLS-verified peer HTTP client"
```

---

## Phase 3 — Backend: federation blueprint

### Task 3: Blueprint with peer CRUD + test, plus aggregate & proxy routes

**Files:**
- Create: `AppImage/scripts/flask_federation_routes.py`
- Test: `AppImage/scripts/tests/test_federation_routes.py`

- [ ] **Step 1: Write the failing tests**

`AppImage/scripts/tests/test_federation_routes.py`:

```python
import pytest
from flask import Flask
import flask_federation_routes as fed


@pytest.fixture
def client(monkeypatch):
    app = Flask(__name__)
    app.register_blueprint(fed.federation_bp)
    # Avoid the request-time circular import of flask_server in unit tests.
    monkeypatch.setattr(fed, "_self_node_name", lambda: "pve1")
    return app.test_client()


def test_list_peers_empty(client, monkeypatch):
    monkeypatch.setattr(fed.federation_config, "load_peers", lambda: [])
    r = client.get("/api/federation/peers")
    assert r.status_code == 200
    assert r.get_json() == {"peers": []}


def test_list_peers_hides_token(client, monkeypatch):
    monkeypatch.setattr(
        fed.federation_config, "load_peers",
        lambda: [{"name": "pve2", "host": "h", "port": 8008,
                  "token": "SECRET", "enabled": True}])
    body = client.get("/api/federation/peers").get_json()
    assert body["peers"][0]["name"] == "pve2"
    assert "token" not in body["peers"][0]


def test_add_peer_validation_error(client, monkeypatch):
    def boom(_):
        raise ValueError("token is required")
    monkeypatch.setattr(fed.federation_config, "add_peer", boom)
    r = client.post("/api/federation/peers", json={"name": "pve2", "host": "h"})
    assert r.status_code == 400
    assert "token" in r.get_json()["error"]


def test_proxy_unknown_node_404(client, monkeypatch):
    monkeypatch.setattr(fed.federation_config, "get_peer", lambda n: None)
    r = client.get("/api/proxy/ghost/api/system")
    assert r.status_code == 404


def test_proxy_forwards_and_returns_peer_response(client, monkeypatch):
    peer = {"name": "pve2", "host": "h", "port": 8008, "token": "t", "enabled": True}
    monkeypatch.setattr(fed.federation_config, "get_peer", lambda n: peer)

    class FakeResp:
        status_code = 200
        content = b'{"cpu_usage": 5}'
        headers = {"Content-Type": "application/json"}

    captured = {}

    def fake_raw(p, method, path, **kw):
        captured["path"] = path
        captured["method"] = method
        return FakeResp()

    monkeypatch.setattr(fed.peer_client, "raw_request", fake_raw)
    r = client.get("/api/proxy/pve2/api/system")
    assert r.status_code == 200
    assert r.get_json() == {"cpu_usage": 5}
    assert captured == {"path": "/api/system", "method": "GET"}


def test_proxy_refuses_to_proxy_auth_endpoints(client, monkeypatch):
    peer = {"name": "pve2", "host": "h", "port": 8008, "token": "t", "enabled": True}
    monkeypatch.setattr(fed.federation_config, "get_peer", lambda n: peer)
    r = client.post("/api/proxy/pve2/api/auth/login")
    assert r.status_code == 403


def test_overview_merges_self_and_peer(client, monkeypatch):
    monkeypatch.setattr(
        fed.federation_config, "load_peers",
        lambda: [{"name": "pve2", "host": "h", "port": 8008,
                  "token": "t", "enabled": True}])

    def fake_local(path, auth):
        data = {"cpu_usage": 1} if path == "/api/system" else (
            {"status": "OK"} if "health" in path else [])
        return {"online": True, "status": 200, "data": data, "error": None}

    def fake_fetch(peer, path, **kw):
        data = {"cpu_usage": 2} if path == "/api/system" else (
            {"status": "OK"} if "health" in path else [{"vmid": 100}])
        return {"online": True, "status": 200, "data": data, "error": None}

    monkeypatch.setattr(fed, "_fetch_local", fake_local)
    monkeypatch.setattr(fed.peer_client, "fetch_json", fake_fetch)
    nodes = client.get("/api/federation/overview").get_json()["nodes"]
    assert len(nodes) == 2
    assert nodes[0]["is_self"] is True
    assert nodes[0]["system"]["cpu_usage"] == 1
    assert nodes[1]["node"] == "pve2"
    assert nodes[1]["vm_count"] == 1


def test_overview_marks_offline_peer(client, monkeypatch):
    monkeypatch.setattr(
        fed.federation_config, "load_peers",
        lambda: [{"name": "pve2", "host": "h", "port": 8008,
                  "token": "t", "enabled": True}])
    monkeypatch.setattr(
        fed, "_fetch_local",
        lambda p, a: {"online": True, "status": 200, "data": {}, "error": None})
    monkeypatch.setattr(
        fed.peer_client, "fetch_json",
        lambda peer, path, **kw: {"online": False, "status": None,
                                  "data": None, "error": "timeout"})
    nodes = client.get("/api/federation/overview").get_json()["nodes"]
    assert nodes[1]["online"] is False
    assert nodes[1]["error"] == "timeout"


def test_federation_vms_tags_origin_node(client, monkeypatch):
    monkeypatch.setattr(
        fed.federation_config, "load_peers",
        lambda: [{"name": "pve2", "host": "h", "port": 8008,
                  "token": "t", "enabled": True}])
    monkeypatch.setattr(
        fed, "_fetch_local",
        lambda p, a: {"online": True, "status": 200,
                      "data": [{"vmid": 1}], "error": None})
    monkeypatch.setattr(
        fed.peer_client, "fetch_json",
        lambda peer, path, **kw: {"online": True, "status": 200,
                                  "data": [{"vmid": 2}], "error": None})
    vms = client.get("/api/federation/vms").get_json()["vms"]
    by_node = {v["vmid"]: v["_node"] for v in vms}
    assert by_node == {1: "pve1", 2: "pve2"}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd AppImage/scripts && python -m pytest tests/test_federation_routes.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'flask_federation_routes'`

- [ ] **Step 3: Write the implementation**

`AppImage/scripts/flask_federation_routes.py`:

```python
"""
ProxMenux Federation — REST API blueprint.

Adds a thin aggregation + reverse-proxy layer on top of the existing
single-node Monitor so one "central" node can present every node of a
Proxmox cluster from a single dashboard. Purely additive: with no peers
configured, only the local node is returned.

Routes:
  GET    /api/federation/peers          list configured peers (no tokens)
  POST   /api/federation/peers          add a peer
  DELETE /api/federation/peers/<name>   remove a peer
  POST   /api/federation/peers/test     test connectivity to a peer
  GET    /api/federation/nodes          self + peers with reachability
  GET    /api/federation/overview       per-node CPU/RAM/temp/health/vm summary
  GET    /api/federation/vms            unified VM/LXC list across all nodes
  ANY    /api/proxy/<node>/<path>       reverse-proxy to a peer's API
"""

from concurrent.futures import ThreadPoolExecutor

from flask import Blueprint, current_app, jsonify, request, Response

import federation_config
import peer_client
from jwt_middleware import require_auth

federation_bp = Blueprint("federation", __name__)

# Endpoints we never reverse-proxy (auth + federation control stay local).
_NON_PROXYABLE_PREFIXES = ("/api/auth", "/api/federation", "/api/proxy")


def _self_node_name():
    # Late import avoids a circular import at module load (flask_server
    # imports this blueprint). At request time flask_server is fully loaded.
    from flask_server import get_proxmox_node_name
    return get_proxmox_node_name()


def _fetch_local(path, incoming_auth):
    """Invoke one of THIS server's own routes in-process (no socket).

    Reuses the browser's Authorization header (valid for the central node)
    so `require_auth` passes. Returns the same shape as peer_client.fetch_json.
    """
    client = current_app.test_client()
    headers = {}
    if incoming_auth:
        headers["Authorization"] = incoming_auth
    resp = client.get(path, headers=headers)
    data = None
    try:
        data = resp.get_json()
    except Exception:
        data = None
    return {"online": True, "status": resp.status_code, "data": data,
            "error": None if resp.status_code < 400 else "HTTP {}".format(resp.status_code)}


def _public_peer(peer):
    """Peer dict without the secret token, safe to return to the client."""
    return {"name": peer["name"], "host": peer["host"],
            "port": peer["port"], "enabled": peer["enabled"]}


# ── Peer management ──────────────────────────────────────────────────────

@federation_bp.route("/api/federation/peers", methods=["GET"])
@require_auth
def list_peers():
    return jsonify({"peers": [_public_peer(p) for p in federation_config.load_peers()]})


@federation_bp.route("/api/federation/peers", methods=["POST"])
@require_auth
def add_peer():
    data = request.get_json(silent=True) or {}
    try:
        peer = federation_config.add_peer({
            "name": data.get("name"),
            "host": data.get("host"),
            "port": data.get("port", 8008),
            "token": data.get("token"),
            "enabled": data.get("enabled", True),
        })
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"success": True, "peer": _public_peer(peer)})


@federation_bp.route("/api/federation/peers/<name>", methods=["DELETE"])
@require_auth
def delete_peer(name):
    if not federation_config.remove_peer(name):
        return jsonify({"error": "peer not found"}), 404
    return jsonify({"success": True})


@federation_bp.route("/api/federation/peers/test", methods=["POST"])
@require_auth
def test_peer():
    data = request.get_json(silent=True) or {}
    peer = {
        "name": data.get("name", "test"),
        "host": data.get("host", ""),
        "port": data.get("port", 8008),
        "token": data.get("token", ""),
    }
    if not peer["host"] or not peer["token"]:
        return jsonify({"ok": False, "error": "host and token are required"}), 400
    result = peer_client.fetch_json(peer, "/api/system", timeout=8)
    node = None
    if isinstance(result["data"], dict):
        node = result["data"].get("proxmox_node")
    return jsonify({
        "ok": result["online"] and result["status"] == 200,
        "status": result["status"],
        "error": result["error"],
        "node": node,
    })


# ── Aggregation ──────────────────────────────────────────────────────────

def _node_summary(name, *, is_self, peer=None, incoming_auth=None):
    def get(path):
        if is_self:
            return _fetch_local(path, incoming_auth)
        return peer_client.fetch_json(peer, path)

    system = get("/api/system")
    if not system["online"]:
        return {"node": name, "is_self": is_self, "online": False,
                "error": system["error"], "system": None,
                "health": None, "vm_count": None}
    health = get("/api/health/status")
    vms = get("/api/vms")
    vm_count = len(vms["data"]) if isinstance(vms["data"], list) else None
    return {"node": name, "is_self": is_self, "online": True, "error": None,
            "system": system["data"], "health": health["data"],
            "vm_count": vm_count}


@federation_bp.route("/api/federation/overview", methods=["GET"])
@require_auth
def overview():
    incoming_auth = request.headers.get("Authorization")
    nodes = [_node_summary(_self_node_name(), is_self=True, incoming_auth=incoming_auth)]
    peers = [p for p in federation_config.load_peers() if p["enabled"]]
    if peers:
        with ThreadPoolExecutor(max_workers=min(8, len(peers))) as ex:
            nodes.extend(ex.map(
                lambda p: _node_summary(p["name"], is_self=False, peer=p), peers))
    return jsonify({"nodes": nodes})


@federation_bp.route("/api/federation/nodes", methods=["GET"])
@require_auth
def nodes():
    result = [{"node": _self_node_name(), "is_self": True, "online": True,
               "host": "localhost", "port": None, "enabled": True}]
    peers = federation_config.load_peers()

    def reach(peer):
        r = peer_client.fetch_json(peer, "/api/health", timeout=5)
        return {"node": peer["name"], "is_self": False, "online": r["online"],
                "host": peer["host"], "port": peer["port"],
                "enabled": peer["enabled"]}

    if peers:
        with ThreadPoolExecutor(max_workers=min(8, len(peers))) as ex:
            result.extend(ex.map(reach, peers))
    return jsonify({"nodes": result})


@federation_bp.route("/api/federation/vms", methods=["GET"])
@require_auth
def federation_vms():
    incoming_auth = request.headers.get("Authorization")

    def collect(name, is_self, peer=None):
        if is_self:
            r = _fetch_local("/api/vms", incoming_auth)
        else:
            r = peer_client.fetch_json(peer, "/api/vms")
        vms = r["data"] if isinstance(r["data"], list) else []
        for vm in vms:
            if isinstance(vm, dict):
                vm["_node"] = name
                vm["_node_is_self"] = is_self
        return vms

    all_vms = list(collect(_self_node_name(), True))
    peers = [p for p in federation_config.load_peers() if p["enabled"]]
    if peers:
        with ThreadPoolExecutor(max_workers=min(8, len(peers))) as ex:
            for vms in ex.map(lambda p: collect(p["name"], False, p), peers):
                all_vms.extend(vms)
    return jsonify({"vms": all_vms})


# ── Reverse proxy ────────────────────────────────────────────────────────

@federation_bp.route("/api/proxy/<node>/<path:endpoint>",
                     methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
@require_auth
def proxy(node, endpoint):
    peer = federation_config.get_peer(node)
    if peer is None:
        return jsonify({"error": "unknown node '{}'".format(node)}), 404
    if not peer["enabled"]:
        return jsonify({"error": "node '{}' is disabled".format(node)}), 409

    target_path = "/" + endpoint
    if any(target_path.startswith(p) for p in _NON_PROXYABLE_PREFIXES):
        return jsonify({"error": "endpoint not proxyable"}), 403

    fwd_headers = {}
    ct = request.headers.get("Content-Type")
    if ct:
        fwd_headers["Content-Type"] = ct
    try:
        resp = peer_client.raw_request(
            peer, request.method, target_path,
            params=request.args.to_dict(flat=True),
            data=request.get_data(),
            headers=fwd_headers,
            timeout=20,
        )
    except Exception as exc:
        return jsonify({"error": "node unreachable", "offline": True,
                        "detail": str(exc)}), 502

    excluded = {"content-encoding", "transfer-encoding", "connection",
                "content-length"}
    out_headers = [(k, v) for k, v in resp.headers.items()
                   if k.lower() not in excluded]
    return Response(resp.content, status=resp.status_code, headers=out_headers)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd AppImage/scripts && python -m pytest tests/ -v`
Expected: PASS (all tests across the three files green)

- [ ] **Step 5: Commit**

```bash
git add AppImage/scripts/flask_federation_routes.py AppImage/scripts/tests/test_federation_routes.py
git commit -m "feat(federation): aggregation + reverse-proxy blueprint"
```

---

### Task 4: Register the blueprint and bundle the new modules

**Files:**
- Modify: `AppImage/scripts/flask_server.py:77` (imports) and `:212` (registration)
- Modify: `AppImage/scripts/build_appimage.sh` (~line 144, after the last `cp` of a `flask_*` module)

- [ ] **Step 1: Add the import**

In `AppImage/scripts/flask_server.py`, after line 77 (`from flask_oci_routes import oci_bp  # noqa: E402`), add:

```python
from flask_federation_routes import federation_bp  # noqa: E402
```

- [ ] **Step 2: Register the blueprint**

In `AppImage/scripts/flask_server.py`, after line 212 (`app.register_blueprint(oci_bp)`), add:

```python
app.register_blueprint(federation_bp)
```

- [ ] **Step 3: Add the build copy lines**

In `AppImage/scripts/build_appimage.sh`, in the block that copies the `flask_*` modules (~lines 115-144), add these three lines alongside the existing `cp` calls:

```bash
cp "$SCRIPT_DIR/flask_federation_routes.py" "$APP_DIR/usr/bin/" 2>/dev/null || echo "flask_federation_routes.py not found"
cp "$SCRIPT_DIR/federation_config.py" "$APP_DIR/usr/bin/" 2>/dev/null || echo "federation_config.py not found"
cp "$SCRIPT_DIR/peer_client.py" "$APP_DIR/usr/bin/" 2>/dev/null || echo "peer_client.py not found"
```

- [ ] **Step 4: Verify the server imports cleanly**

Run: `cd AppImage/scripts && python -c "import ast; ast.parse(open('flask_server.py').read()); ast.parse(open('flask_federation_routes.py').read()); print('syntax OK')"`
Expected: `syntax OK`

(A full `import flask_server` requires the bundled deps + root; the syntax check is the dev-time gate. Full runtime verification happens in Task 12 on a real node.)

- [ ] **Step 5: Commit**

```bash
git add AppImage/scripts/flask_server.py AppImage/scripts/build_appimage.sh
git commit -m "feat(federation): register blueprint and bundle modules"
```

---

## Phase 4 — Frontend: active-node routing

### Task 5: Active-node helpers + proxy routing in `api-config.ts`

**Files:**
- Modify: `AppImage/lib/api-config.ts`

- [ ] **Step 1: Add active-node helpers**

In `AppImage/lib/api-config.ts`, after the `API_PORT` declaration (line 12), add:

```typescript
/**
 * Federation: the "active node" is the cluster node the dashboard is
 * currently viewing. null/empty means the local (central) node — in which
 * case API calls go straight to the local backend exactly as before.
 */
const ACTIVE_NODE_KEY = "proxmenux-active-node"

export function getActiveNode(): string | null {
  if (typeof window === "undefined") return null
  try {
    const v = localStorage.getItem(ACTIVE_NODE_KEY)
    return v && v.trim() ? v : null
  } catch {
    return null
  }
}

export function setActiveNode(node: string | null): void {
  if (typeof window === "undefined") return
  try {
    if (node) localStorage.setItem(ACTIVE_NODE_KEY, node)
    else localStorage.removeItem(ACTIVE_NODE_KEY)
  } catch {
    // localStorage unavailable (private browsing) — ignore.
  }
}

// Endpoints that must always hit the central node directly, never the proxy:
// auth (login is against the central), and the federation control plane itself.
const FEDERATION_LOCAL_PREFIXES = ["/api/federation", "/api/proxy", "/api/auth"]
```

- [ ] **Step 2: Route through the proxy when a remote node is active**

Replace the body of `getApiUrl` (lines 44-51) with:

```typescript
export function getApiUrl(endpoint: string): string {
  const baseUrl = getApiBaseUrl()

  // Ensure endpoint starts with /
  const normalizedEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`

  // When viewing a remote cluster node, transparently route every normal
  // data call through the central node's reverse proxy. Control-plane and
  // auth endpoints always stay local.
  const activeNode = getActiveNode()
  if (
    activeNode &&
    !FEDERATION_LOCAL_PREFIXES.some((p) => normalizedEndpoint.startsWith(p))
  ) {
    return `${baseUrl}/api/proxy/${encodeURIComponent(activeNode)}${normalizedEndpoint}`
  }

  return `${baseUrl}${normalizedEndpoint}`
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd AppImage && npx tsc --noEmit`
Expected: no errors referencing `api-config.ts`. (If the project has pre-existing unrelated TS errors, confirm none are newly introduced in `lib/api-config.ts`.)

- [ ] **Step 4: Commit**

```bash
git add AppImage/lib/api-config.ts
git commit -m "feat(federation): proxy-route API calls for the active node"
```

---

### Task 6: Node selector dropdown

**Files:**
- Create: `AppImage/components/node-selector.tsx`

- [ ] **Step 1: Create the component**

`AppImage/components/node-selector.tsx`:

```tsx
"use client"

import { useEffect, useState } from "react"
import { Server } from "lucide-react"
import { fetchApi, getActiveNode, setActiveNode } from "../lib/api-config"

interface FederationNode {
  node: string
  is_self: boolean
  online: boolean
  enabled?: boolean
}

/**
 * Header dropdown to switch the dashboard between cluster nodes.
 * Hidden entirely when no peers are configured (single-node install),
 * so the standalone experience is unchanged.
 */
export function NodeSelector() {
  const [nodes, setNodes] = useState<FederationNode[]>([])
  const [selfName, setSelfName] = useState<string>("")

  useEffect(() => {
    fetchApi<{ nodes: FederationNode[] }>("/api/federation/nodes")
      .then((data) => {
        setNodes(data.nodes || [])
        const self = (data.nodes || []).find((n) => n.is_self)
        if (self) setSelfName(self.node)
      })
      .catch(() => setNodes([]))
  }, [])

  // Only the local node → nothing to switch between.
  if (nodes.length <= 1) return null

  const active = getActiveNode() ?? selfName

  const onChange = (value: string) => {
    // Selecting the self node clears the active-node override.
    setActiveNode(value === selfName ? null : value)
    // Full reload re-fetches every panel against the newly selected node.
    window.location.reload()
  }

  return (
    <div className="flex items-center gap-2">
      <Server className="h-4 w-4 text-muted-foreground" />
      <select
        aria-label="Select cluster node"
        className="bg-background border border-input rounded-md px-2 py-1 text-sm"
        value={active}
        onChange={(e) => onChange(e.target.value)}
      >
        {nodes.map((n) => (
          <option key={n.node} value={n.node} disabled={!n.online && !n.is_self}>
            {n.node}
            {n.is_self ? " (this node)" : ""}
            {!n.online && !n.is_self ? " — offline" : ""}
          </option>
        ))}
      </select>
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd AppImage && npx tsc --noEmit`
Expected: no new errors in `components/node-selector.tsx`.

- [ ] **Step 3: Commit**

```bash
git add AppImage/components/node-selector.tsx
git commit -m "feat(federation): node selector dropdown"
```

---

## Phase 5 — Frontend: Cluster overview, settings, terminal guard

### Task 7: Cluster overview component + "Cluster" tab

**Files:**
- Create: `AppImage/components/cluster-overview.tsx`
- Modify: `AppImage/components/proxmox-dashboard.tsx` (tab list ~585-595, tab content ~783+, header to mount `<NodeSelector />`)

- [ ] **Step 1: Create the overview component**

`AppImage/components/cluster-overview.tsx`:

```tsx
"use client"

import { useEffect, useState } from "react"
import { Cpu, MemoryStick, Thermometer, Boxes, CircleAlert } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card"
import { fetchApi, getActiveNode, setActiveNode } from "../lib/api-config"

interface NodeSummary {
  node: string
  is_self: boolean
  online: boolean
  error: string | null
  system: {
    cpu_usage?: number
    memory_usage?: number
    temperature?: number | { cpu?: number } | null
  } | null
  health: {
    status?: string
    critical_count?: number
    warning_count?: number
  } | null
  vm_count: number | null
}

function tempValue(t: unknown): number | null {
  if (typeof t === "number") return t
  if (t && typeof t === "object" && typeof (t as any).cpu === "number") return (t as any).cpu
  return null
}

export function ClusterOverview() {
  const [nodes, setNodes] = useState<NodeSummary[]>([])
  const [loading, setLoading] = useState(true)

  const load = () => {
    setLoading(true)
    fetchApi<{ nodes: NodeSummary[] }>("/api/federation/overview")
      .then((d) => setNodes(d.nodes || []))
      .catch(() => setNodes([]))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
    const id = setInterval(load, 30000)
    return () => clearInterval(id)
  }, [])

  const openNode = (n: NodeSummary) => {
    setActiveNode(n.is_self ? null : n.node)
    window.location.reload()
  }

  if (loading && nodes.length === 0) {
    return <div className="text-sm text-muted-foreground p-4">Loading cluster…</div>
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {nodes.map((n) => {
        const alerts =
          (n.health?.critical_count ?? 0) + (n.health?.warning_count ?? 0)
        const temp = tempValue(n.system?.temperature)
        const isActive = (getActiveNode() ?? "") === n.node || (n.is_self && !getActiveNode())
        return (
          <Card
            key={n.node}
            className={`cursor-pointer transition-colors hover:border-primary ${
              isActive ? "border-primary" : ""
            } ${!n.online ? "opacity-60" : ""}`}
            onClick={() => openNode(n)}
          >
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center justify-between text-base">
                <span>
                  {n.node}
                  {n.is_self ? " (this node)" : ""}
                </span>
                <span
                  className={`text-xs px-2 py-0.5 rounded-full ${
                    n.online
                      ? "bg-green-500/15 text-green-600"
                      : "bg-red-500/15 text-red-600"
                  }`}
                >
                  {n.online ? "online" : "offline"}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {n.online ? (
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="flex items-center gap-2">
                    <Cpu className="h-4 w-4 text-muted-foreground" />
                    {n.system?.cpu_usage != null ? `${n.system.cpu_usage}%` : "—"}
                  </div>
                  <div className="flex items-center gap-2">
                    <MemoryStick className="h-4 w-4 text-muted-foreground" />
                    {n.system?.memory_usage != null ? `${n.system.memory_usage}%` : "—"}
                  </div>
                  <div className="flex items-center gap-2">
                    <Thermometer className="h-4 w-4 text-muted-foreground" />
                    {temp != null ? `${temp}°C` : "—"}
                  </div>
                  <div className="flex items-center gap-2">
                    <Boxes className="h-4 w-4 text-muted-foreground" />
                    {n.vm_count != null ? `${n.vm_count} VMs/CTs` : "—"}
                  </div>
                  <div className="col-span-2 flex items-center gap-2">
                    <CircleAlert
                      className={`h-4 w-4 ${
                        alerts > 0 ? "text-amber-500" : "text-muted-foreground"
                      }`}
                    />
                    {n.health?.status ?? "—"}
                    {alerts > 0 ? ` · ${alerts} alert(s)` : ""}
                  </div>
                </div>
              ) : (
                <div className="text-sm text-red-600">{n.error || "unreachable"}</div>
              )}
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: Add the import in `proxmox-dashboard.tsx`**

Near the other component imports at the top of `AppImage/components/proxmox-dashboard.tsx`, add:

```tsx
import { ClusterOverview } from "./cluster-overview"
import { NodeSelector } from "./node-selector"
```

- [ ] **Step 3: Add the "Cluster" entry to the tab list**

In the tab item arrays (`AppImage/components/proxmox-dashboard.tsx:585-595`), add a Cluster entry. Add `Network` icon import note: reuse the already-imported `Boxes`/`Server`-style icon — use `Layers` (add `Layers` to the existing `lucide-react` import). Insert into `NODE_ITEMS`:

```tsx
const NODE_ITEMS = [
  { value: "cluster",  label: "Cluster",  Icon: Layers,      default: false },
  { value: "storage",  label: "Storage",  Icon: HardDrive,   default: false },
  { value: "network",  label: "Network",  Icon: NetworkIcon, default: false },
  { value: "hardware", label: "Hardware", Icon: Cpu,         default: false },
]
```

- [ ] **Step 4: Add the matching `TabsContent`**

In the `TabsContent` block (`AppImage/components/proxmox-dashboard.tsx:783+`), add alongside the others (match the existing className + `componentKey` pattern):

```tsx
<TabsContent value="cluster" className="space-y-4 md:space-y-6 mt-0">
  <ClusterOverview key={`cluster-${componentKey}`} />
</TabsContent>
```

- [ ] **Step 5: Add the Cluster entry to the mobile menu**

The mobile navigation is a separate hardcoded `<Sheet>` list (`proxmox-dashboard.tsx` ~728-768) of `<Button onClick={() => select("...")}>` items. Add a Cluster button at the top of that list (mirror the existing `select("overview")` button), so the tab is reachable on mobile too:

```tsx
<Button variant="ghost" onClick={() => select("cluster")} className={itemClass(activeTab === "cluster")}>
  <Layers className="mr-2 h-4 w-4" />
  Cluster
</Button>
```

- [ ] **Step 6: Mount the node selector above the tab bar**

In `proxmox-dashboard.tsx`, inside the sticky nav container (`<div className="container mx-auto px-4 lg:px-6 pt-4 lg:pt-6">`, ~line 567), add `<NodeSelector />` immediately before `<Tabs value={activeTab} ...>` (line 568):

```tsx
<div className="mb-3 flex justify-end">
  <NodeSelector />
</div>
```

- [ ] **Step 7: Verify the build**

Run: `cd AppImage && npx tsc --noEmit && npm run build`
Expected: TypeScript clean for the new files; Next.js build succeeds.

- [ ] **Step 8: Commit**

```bash
git add AppImage/components/cluster-overview.tsx AppImage/components/node-selector.tsx AppImage/components/proxmox-dashboard.tsx
git commit -m "feat(federation): cluster overview tab + node selector in header"
```

---

### Task 8: Federation settings panel

**Files:**
- Create: `AppImage/components/federation-setup.tsx`
- Modify: `AppImage/components/settings.tsx`

- [ ] **Step 1: Create the settings panel**

`AppImage/components/federation-setup.tsx`:

```tsx
"use client"

import { useEffect, useState } from "react"
import { Trash2, Plug } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card"
import { Button } from "./ui/button"
import { Input } from "./ui/input"
import { Label } from "./ui/label"
import { fetchApi } from "../lib/api-config"

interface Peer {
  name: string
  host: string
  port: number
  enabled: boolean
}

export function FederationSetup() {
  const [peers, setPeers] = useState<Peer[]>([])
  const [name, setName] = useState("")
  const [host, setHost] = useState("")
  const [port, setPort] = useState("8008")
  const [token, setToken] = useState("")
  const [msg, setMsg] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)

  const load = () => {
    fetchApi<{ peers: Peer[] }>("/api/federation/peers")
      .then((d) => setPeers(d.peers || []))
      .catch(() => setPeers([]))
  }
  useEffect(load, [])

  const testConnection = async () => {
    setTesting(true)
    setMsg(null)
    try {
      const res = await fetchApi<{ ok: boolean; node?: string; error?: string }>(
        "/api/federation/peers/test",
        { method: "POST", body: JSON.stringify({ host, port: Number(port), token }) }
      )
      setMsg(res.ok ? `OK — reached node "${res.node ?? "?"}"` : `Failed: ${res.error}`)
    } catch (e) {
      setMsg(`Failed: ${(e as Error).message}`)
    } finally {
      setTesting(false)
    }
  }

  const addPeer = async () => {
    setMsg(null)
    try {
      await fetchApi("/api/federation/peers", {
        method: "POST",
        body: JSON.stringify({ name, host, port: Number(port), token }),
      })
      setName(""); setHost(""); setPort("8008"); setToken("")
      load()
    } catch (e) {
      setMsg(`Error: ${(e as Error).message}`)
    }
  }

  const removePeer = async (peerName: string) => {
    await fetchApi(`/api/federation/peers/${encodeURIComponent(peerName)}`, {
      method: "DELETE",
    })
    load()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cluster Federation</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Add the other nodes of your Proxmox cluster to view them all from this
          dashboard. On each peer node, open ProxMenux → Settings → generate an API
          token with <strong>full_admin</strong> scope (needed to control VMs
          remotely), then paste it here. Use the node's hostname/FQDN so TLS
          verifies against the cluster CA.
        </p>

        {peers.length > 0 && (
          <div className="space-y-2">
            {peers.map((p) => (
              <div
                key={p.name}
                className="flex items-center justify-between border rounded-md px-3 py-2 text-sm"
              >
                <span>
                  <strong>{p.name}</strong> — {p.host}:{p.port}
                </span>
                <Button variant="ghost" size="sm" onClick={() => removePeer(p.name)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label htmlFor="fed-name">Node name</Label>
            <Input id="fed-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="pve2" />
          </div>
          <div>
            <Label htmlFor="fed-host">Host / FQDN</Label>
            <Input id="fed-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="pve2.lan" />
          </div>
          <div>
            <Label htmlFor="fed-port">Port</Label>
            <Input id="fed-port" value={port} onChange={(e) => setPort(e.target.value)} placeholder="8008" />
          </div>
          <div>
            <Label htmlFor="fed-token">API token</Label>
            <Input id="fed-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="eyJ…" />
          </div>
        </div>

        {msg && <div className="text-sm">{msg}</div>}

        <div className="flex gap-2">
          <Button variant="outline" onClick={testConnection} disabled={testing || !host || !token}>
            <Plug className="h-4 w-4 mr-2" />
            {testing ? "Testing…" : "Test connection"}
          </Button>
          <Button onClick={addPeer} disabled={!name || !host || !token}>
            Add node
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 2: Mount it in settings**

In `AppImage/components/settings.tsx`, add the import near the other panel imports:

```tsx
import { FederationSetup } from "./federation-setup"
```

And render `<FederationSetup />` alongside the existing panels (e.g. after `<HealthThresholds />`):

```tsx
<FederationSetup />
```

- [ ] **Step 3: Verify the build**

Run: `cd AppImage && npx tsc --noEmit && npm run build`
Expected: clean compile for the new files; build succeeds.

- [ ] **Step 4: Commit**

```bash
git add AppImage/components/federation-setup.tsx AppImage/components/settings.tsx
git commit -m "feat(federation): settings panel to manage peer nodes"
```

---

### Task 9: Disable the terminal when viewing a remote node

**Files:**
- Modify: `AppImage/components/proxmox-dashboard.tsx` (terminal tab trigger/content)

- [ ] **Step 1: Compute remote-node state**

Near the top of the `ProxmoxDashboard` component body (after the existing `useState` hooks), add:

```tsx
import { getActiveNode } from "../lib/api-config"
// ...inside the component:
const isRemoteNode = getActiveNode() !== null
```

(Add the `getActiveNode` import to the existing `../lib/api-config` import line if not already present.)

- [ ] **Step 2: Disable the terminal trigger for remote nodes**

Locate the terminal `TabsTrigger` (`proxmox-dashboard.tsx:663`). Preserve its existing `className` + children and add a disabled state + tooltip when remote:

```tsx
<TabsTrigger value="terminal" className={triggerActiveClass} disabled={isRemoteNode} title={isRemoteNode ? "Open the terminal directly on the node" : undefined}>
  <Terminal className="mr-2 h-4 w-4" />
  Terminal
</TabsTrigger>
```

Also disable the mobile menu's terminal button (~line 752): add `disabled={isRemoteNode}` to `<Button ... onClick={() => select("terminal")} ...>`.

- [ ] **Step 3: Guard the terminal content**

Replace the terminal `TabsContent` (`proxmox-dashboard.tsx:811-813`) with a notice when remote, keeping the real `key` format:

```tsx
<TabsContent value="terminal" className="mt-0">
  {isRemoteNode ? (
    <div className="text-sm text-muted-foreground p-4">
      The web terminal is only available on the local node. Switch back to “this
      node”, or open ProxMenux directly on the remote node, to use it.
    </div>
  ) : (
    <TerminalPanel key={`terminal-${componentKey}`} />
  )}
</TabsContent>
```

- [ ] **Step 4: Verify the build**

Run: `cd AppImage && npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add AppImage/components/proxmox-dashboard.tsx
git commit -m "feat(federation): disable web terminal for remote nodes (v1)"
```

---

## Phase 6 — Integration, manual verification, docs

### Task 10: End-to-end verification on the real 2-node cluster

This task is manual (no automated cluster in CI). Perform on the actual nodes.

- [ ] **Step 1: Build and install on both nodes**

Build the AppImage (or install via the beta installer) on **both** cluster nodes so each runs the updated Monitor. Confirm each node's dashboard loads at `http://<node>:8008` as before.

- [ ] **Step 2: Generate a peer token on node B**

On node B: ProxMenux → Settings → API tokens → generate a token with **full_admin** scope. Copy it.

- [ ] **Step 3: Register node B on node A (central)**

On node A: Settings → Cluster Federation → enter `name=<nodeB>`, `host=<nodeB FQDN>`, `port=8008`, paste the token → **Test connection** (expect "OK — reached node <nodeB>") → **Add node**.

- [ ] **Step 4: Verify the Cluster tab**

On node A, open the **Cluster** tab. Expect two cards (node A "this node" + node B), each showing CPU/RAM/temp/health/VM count, both "online".

- [ ] **Step 5: Verify drill-in via proxy**

Click node B's card (or pick node B in the header selector). Confirm the Storage/Network/Hardware/VMs tabs now show **node B's** data (e.g. node B's disks/SMART). Confirm the Terminal tab is disabled with the explanatory notice.

- [ ] **Step 6: Verify remote VM control**

On node B's VMs view (through node A), start/stop a test VM. Confirm the action takes effect on node B (this exercises the full_admin token through the proxy).

- [ ] **Step 7: Verify resilience**

Stop the Monitor service on node B (`systemctl stop proxmenux-monitor`). On node A's Cluster tab, confirm node B shows "offline" and node A's own panels still work. Restart node B's service and confirm it recovers.

- [ ] **Step 8: Verify backward compatibility**

Confirm that on a node with **no** peers configured, the Cluster tab shows only the local node and the header selector is hidden — i.e. the standalone experience is unchanged.

### Task 11: Documentation

**Files:**
- Modify: `README.md` (ProxMenux Monitor section)
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Document the feature in README**

Under the "🖥️ ProxMenux Monitor" section of `README.md`, add a short subsection:

```markdown
**Cluster federation (multi-node):**

Install ProxMenux on each node of your Proxmox cluster. On one node (the
"central" node), go to Settings → Cluster Federation and add the other nodes
by hostname + an API token (generated on each peer with `full_admin` scope).
A new **Cluster** tab then shows every node in one view, and the node selector
in the header lets you drill into any node's full dashboard. Each node still
collects its own metrics locally; the central node aggregates them over the
existing authenticated API (TLS verified against the Proxmox cluster CA).
The web terminal remains available only on the node you are connected to.
```

- [ ] **Step 2: Add a CHANGELOG entry**

Add a bullet under the next version heading in `CHANGELOG.md`:

```markdown
- **Cluster federation:** the Monitor can now aggregate every node of a Proxmox
  cluster into a single dashboard. A central node reverse-proxies and merges the
  other nodes' existing APIs (new `/api/federation/*` and `/api/proxy/<node>/*`
  endpoints, a Cluster overview tab, a node selector, and a Federation settings
  panel). Fully backward compatible — with no peers configured the dashboard is
  unchanged.
```

- [ ] **Step 3: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs(federation): document cluster federation feature"
```

---

## Self-review notes (for the implementer)

- **Token scope:** the single most common failure mode is registering a peer token with the default `read_only` scope, which makes remote VM control return 403 through the proxy. The settings panel copy calls this out; if control fails, re-issue the peer token with `full_admin`.
- **TLS / hostnames:** register peers by hostname/FQDN, not IP, so the cert CN matches and verification against `/etc/pve/pve-root-ca.pem` succeeds. If a peer test fails with a certificate error, that is the cause.
- **Self via test_client:** `_fetch_local` invokes the central app's own routes in-process (no socket, avoids SSL/loopback concerns). It forwards the browser's `Authorization` header, which is valid for the central node.
- **Backward compatibility invariant:** every new code path is gated on peers existing / an active node being set. No peers + no active node ⇒ original single-node behavior.
</content>
</invoke>
