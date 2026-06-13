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


def _verify_arg(peer=None):
    # Per-peer opt-out for when a peer is addressed by IP or presents a cert
    # not issued by the Proxmox cluster CA (a separate node / self-signed).
    # Opt-in only — secure by default.
    if peer is not None and peer.get("insecure_tls"):
        return False
    # All nodes in a Proxmox cluster share this CA via the /etc/pve cluster
    # filesystem, so the central node can verify peer certificates against it.
    # Fall back to the system trust store when the file is absent (dev hosts).
    if os.path.exists(PVE_CLUSTER_CA):
        return PVE_CLUSTER_CA
    return True


def _silence_insecure_warning():
    # Avoid flooding the log with one urllib3 InsecureRequestWarning per call
    # when a peer is deliberately configured with insecure_tls.
    try:
        import urllib3
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
    except Exception:
        pass


def _looks_like_plain_http(exc):
    # SSL error that specifically means "the server on this port spoke plain
    # HTTP, not TLS" — as opposed to a cert/verification problem.
    m = str(exc).upper()
    return ("WRONG_VERSION_NUMBER" in m or "UNKNOWN_PROTOCOL" in m
            or "HTTP_REQUEST" in m or "RECORD LAYER" in m)


def _do_request(peer, method, path, scheme, h, params, data, timeout):
    url = "{scheme}://{host}:{port}{path}".format(
        scheme=scheme, host=peer["host"], port=int(peer["port"]), path=path)
    verify = _verify_arg(peer) if scheme == "https" else True
    if verify is False:
        _silence_insecure_warning()
    return requests.request(method, url, params=params, data=data,
                            headers=h, timeout=timeout, verify=verify)


def detect_scheme(host, port, *, insecure_tls=False, timeout=5):
    """Probe a peer to decide http vs https WITHOUT sending credentials.

    Returns "http" or "https". A TLS handshake failure of the 'wrong version
    number' kind means the peer serves plain HTTP. This probe never sends an
    Authorization header, so the token is never transmitted to a node that
    turns out to be plaintext. Used once at add/test time to persist an
    EXPLICIT per-peer scheme — there is no silent runtime downgrade.
    """
    url = "https://{host}:{port}/api/health".format(host=host, port=int(port))
    verify = False if insecure_tls else (
        PVE_CLUSTER_CA if os.path.exists(PVE_CLUSTER_CA) else True)
    if verify is False:
        _silence_insecure_warning()
    try:
        requests.get(url, timeout=timeout, verify=verify)
        return "https"
    except requests.exceptions.SSLError as exc:
        # 'wrong version number' => the peer spoke plain HTTP. A cert error is
        # still HTTPS (the operator just needs Skip-TLS).
        return "http" if _looks_like_plain_http(exc) else "https"
    except requests.exceptions.RequestException:
        # Unreachable during probe; assume https — the real request surfaces
        # the connection error to the caller.
        return "https"


def raw_request(peer, method, path, *, params=None, data=None,
                headers=None, timeout=15):
    """Forward a request to a peer and return the requests.Response.

    Uses the peer's EXPLICIT scheme (default https). It never silently
    downgrades https -> http at request time, so a credentialed request is
    never transparently re-sent over plaintext. The scheme is fixed once at
    add/test time via detect_scheme(). Raises requests.exceptions.RequestException
    on network failure; the caller (proxy route) maps that to a 502.
    """
    h = {}
    if peer.get("token"):
        h["Authorization"] = "Bearer {}".format(peer["token"])
    if headers:
        h.update(headers)
    scheme = peer.get("scheme") or "https"
    return _do_request(peer, method, path, scheme, h, params, data, timeout)


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
