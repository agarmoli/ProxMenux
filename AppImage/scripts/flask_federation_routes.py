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

import posixpath
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


def _normalize_proxy_path(endpoint):
    """Validate + normalize a proxied endpoint path.

    Returns (normalized_path, error). Blocks path traversal (`..`) and the
    non-proxyable allowlist *after* normalizing, so a request like
    `api/x/../auth/login` cannot smuggle its way past the allowlist and reach
    /api/auth or /api/federation on the peer. The normalized path (not the raw
    one) is what gets forwarded.
    """
    target_path = "/" + endpoint
    if ".." in target_path.split("/"):
        return None, "invalid path"
    norm = posixpath.normpath(target_path)
    if not norm.startswith("/"):
        return None, "invalid path"
    if any(norm == p or norm.startswith(p + "/") for p in _NON_PROXYABLE_PREFIXES):
        return None, "endpoint not proxyable"
    return norm, None


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

    target_path, err = _normalize_proxy_path(endpoint)
    if err == "invalid path":
        return jsonify({"error": err}), 400
    if err:
        return jsonify({"error": err}), 403

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
