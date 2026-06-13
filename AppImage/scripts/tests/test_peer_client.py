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


def test_detect_scheme_http_on_wrong_version():
    with patch("peer_client.requests.get",
               side_effect=requests.exceptions.SSLError(
                   "[SSL: WRONG_VERSION_NUMBER] wrong version number")):
        assert peer_client.detect_scheme("1.2.3.4", 8008) == "http"


def test_detect_scheme_https_and_sends_no_token():
    captured = {}

    def fake_get(url, **kw):
        captured["url"] = url
        captured["headers"] = kw.get("headers")
        return _resp(200, {})

    with patch("peer_client.requests.get", side_effect=fake_get):
        assert peer_client.detect_scheme("pve2.lan", 8008) == "https"
    assert captured["url"].startswith("https://")
    assert not captured.get("headers")  # detection never sends Authorization


def test_detect_scheme_https_on_cert_error():
    with patch("peer_client.requests.get",
               side_effect=requests.exceptions.SSLError("certificate verify failed")):
        assert peer_client.detect_scheme("h", 8008) == "https"


def test_raw_request_never_downgrades_to_http():
    # A request configured for https must NOT be retried over http.
    with patch("peer_client.requests.request",
               side_effect=requests.exceptions.SSLError(
                   "[SSL: WRONG_VERSION_NUMBER] x")) as rq:
        try:
            peer_client.raw_request(PEER, "GET", "/api/system")
            assert False, "should have raised"
        except requests.exceptions.SSLError:
            pass
    assert rq.call_count == 1  # one attempt only, no plaintext retry


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
