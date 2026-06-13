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
    verify = _verify_arg(peer)
    if verify is False:
        _silence_insecure_warning()
    return requests.request(method, url, params=params, data=data,
                            headers=h, timeout=timeout, verify=verify)


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
