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


def test_insecure_tls_disables_verification():
    with patch("peer_client.requests.request", return_value=_resp(200, {})) as rq:
        peer_client.raw_request({**PEER, "insecure_tls": True}, "GET", "/api/system")
    assert rq.call_args.kwargs["verify"] is False


def test_https_falls_back_to_http_on_wrong_version():
    calls = []

    def fake(method, url, **kw):
        calls.append(url)
        if url.startswith("https://"):
            raise requests.exceptions.SSLError(
                "[SSL: WRONG_VERSION_NUMBER] wrong version number")
        return _resp(200, {"ok": 1})

    with patch("peer_client.requests.request", side_effect=fake):
        r = peer_client.raw_request(PEER, "GET", "/api/system")
    assert calls[0].startswith("https://") and calls[1].startswith("http://")
    assert r.status_code == 200


def test_explicit_http_scheme_skips_https():
    calls = []

    def fake(method, url, **kw):
        calls.append(url)
        return _resp(200, {})

    with patch("peer_client.requests.request", side_effect=fake):
        peer_client.raw_request({**PEER, "scheme": "http"}, "GET", "/api/system")
    assert calls == ["http://pve2.lan:8008/api/system"]


def test_cert_error_does_not_fall_back_to_http():
    with patch("peer_client.requests.request",
               side_effect=requests.exceptions.SSLError("certificate verify failed")):
        try:
            peer_client.raw_request(PEER, "GET", "/api/system")
            assert False, "should have raised"
        except requests.exceptions.SSLError:
            pass
