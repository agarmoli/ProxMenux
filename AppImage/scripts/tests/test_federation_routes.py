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


def test_normalize_proxy_path_allows_normal_endpoint():
    norm, err = fed._normalize_proxy_path("api/system")
    assert err is None
    assert norm == "/api/system"


def test_normalize_proxy_path_blocks_allowlisted_prefixes():
    for ep in ("api/auth/login", "api/federation/peers", "api/proxy/x/api/system"):
        _, err = fed._normalize_proxy_path(ep)
        assert err == "endpoint not proxyable", ep


def test_normalize_proxy_path_blocks_traversal_bypass():
    # `..` must never let the allowlist be bypassed (would normalize to /api/auth)
    for ep in ("api/x/../auth/login", "../api/auth/login", "api/../api/federation/peers"):
        _, err = fed._normalize_proxy_path(ep)
        assert err is not None, ep


def test_normalize_proxy_path_prefix_is_segment_anchored():
    # A path that merely shares a textual prefix must NOT be blocked.
    norm, err = fed._normalize_proxy_path("api/authentications-report")
    assert err is None
    assert norm == "/api/authentications-report"


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
