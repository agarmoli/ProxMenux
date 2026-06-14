"""
ProxMenux — LXC application update detection.

For each LXC the operator has assigned an app to, read the installed version
inside the container (pct exec) and compare it to the latest version published
on GitHub (releases or tags). Detection only — never applies updates.

Storage: a dedicated db (default /usr/local/share/proxmenux/lxc_app_updates.json,
mode 0600) holds the optional GitHub PAT, per-vmid assignments, and cached
results. The app catalog ships next to this module as lxc_app_catalog.json.
"""

import json
import os
import re
import subprocess
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

_PCT_BIN = "/usr/sbin/pct"
_DB_DIR = "/usr/local/share/proxmenux"
_REFRESH_TTL = 6 * 3600
_FETCH_TIMEOUT = 15
_EXEC_TIMEOUT = 15

_lock = threading.RLock()
_catalog_cache = {"apps": None}
_refreshing = {"flag": False}


def _db_path():
    return os.environ.get("PROXMENUX_LXC_APP_DB",
                          os.path.join(_DB_DIR, "lxc_app_updates.json"))


def _catalog_path():
    return os.environ.get(
        "PROXMENUX_LXC_APP_CATALOG",
        os.path.join(os.path.dirname(os.path.abspath(__file__)),
                     "lxc_app_catalog.json"))


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


# ── catalog ──────────────────────────────────────────────────────────────
def load_catalog():
    """Return {app_id: app_dict}. Cached after first load."""
    if _catalog_cache["apps"] is not None:
        return _catalog_cache["apps"]
    apps = {}
    try:
        with open(_catalog_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        for app in (data.get("apps") or []):
            if isinstance(app, dict) and app.get("id"):
                apps[app["id"]] = app
    except (OSError, json.JSONDecodeError):
        apps = {}
    _catalog_cache["apps"] = apps
    return apps


def catalog_list():
    return list(load_catalog().values())


# ── db ───────────────────────────────────────────────────────────────────
def _read_db():
    try:
        with open(_db_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            data.setdefault("version", 1)
            data.setdefault("github_pat", None)
            data.setdefault("assignments", {})
            data.setdefault("results", {})
            return data
    except (OSError, json.JSONDecodeError):
        pass
    return {"version": 1, "github_pat": None, "assignments": {}, "results": {}}


def _write_db(db):
    path = _db_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(db, f, indent=2, ensure_ascii=False)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def get_settings():
    return {"github_pat_configured": bool(_read_db().get("github_pat"))}


def set_github_pat(pat):
    with _lock:
        db = _read_db()
        db["github_pat"] = (pat or "").strip() or None
        _write_db(db)


def _get_pat():
    return _read_db().get("github_pat")


def list_assignments():
    return _read_db().get("assignments", {})


def get_assignment(vmid):
    return _read_db().get("assignments", {}).get(str(vmid))


def set_assignment(vmid, data):
    spec = _normalize_assignment(data)
    with _lock:
        db = _read_db()
        db["assignments"][str(vmid)] = spec
        db.get("results", {}).pop(str(vmid), None)
        _write_db(db)
    return spec


def clear_assignment(vmid):
    with _lock:
        db = _read_db()
        existed = db["assignments"].pop(str(vmid), None) is not None
        db.get("results", {}).pop(str(vmid), None)
        _write_db(db)
    return existed


def _normalize_assignment(data):
    if not isinstance(data, dict):
        raise ValueError("assignment must be an object")
    app_id = str(data.get("app_id") or "").strip()
    if not app_id:
        raise ValueError("app_id is required")
    if app_id != "custom":
        if app_id not in load_catalog():
            raise ValueError("unknown app '{}'".format(app_id))
        return {"app_id": app_id}
    repo = str(data.get("repo") or "").strip()
    if "/" not in repo:
        raise ValueError("repo must be 'owner/name'")
    source = data.get("github_source", "releases")
    if source not in ("releases", "tags"):
        raise ValueError("github_source must be releases|tags")
    installed = data.get("installed") or {}
    if installed.get("method") not in ("file", "command"):
        raise ValueError("installed.method must be file|command")
    if not str(installed.get("value") or "").strip():
        raise ValueError("installed.value is required")
    return {
        "app_id": "custom",
        "repo": repo,
        "github_source": source,
        "tag_regex": str(data.get("tag_regex") or r"v?(\d+\.\d+\.\d+)"),
        "installed": {
            "method": installed["method"],
            "value": str(installed["value"]).strip(),
            "regex": str(installed.get("regex") or r"(\d+\.\d+\.\d+)"),
        },
    }


def _resolve_spec(assignment):
    if assignment.get("app_id") == "custom":
        spec = dict(assignment)
        spec["name"] = assignment.get("repo", "custom").split("/")[-1]
        return spec
    app = load_catalog().get(assignment.get("app_id"))
    if not app:
        return None
    return {
        "app_id": app["id"],
        "name": app.get("name", app["id"]),
        "repo": app["repo"],
        "github_source": app.get("github_source", "releases"),
        "tag_regex": app.get("tag_regex", r"v?(\d+\.\d+\.\d+)"),
        "installed": app.get("installed", {}),
    }


# ── version helpers ──────────────────────────────────────────────────────
def _version_tuple(v):
    parts = re.findall(r"\d+", v or "")
    return tuple(int(p) for p in parts) if parts else None


def _extract(text, regex):
    if not text:
        return None
    m = re.search(regex, text)
    if not m:
        return None
    return (m.group(1) if m.groups() else m.group(0)).strip()


def compare(installed, latest):
    """Return (update_available: bool, non_semver: bool)."""
    it, lt = _version_tuple(installed), _version_tuple(latest)
    if it is not None and lt is not None:
        return (lt > it, False)
    return ((installed or "").strip() != (latest or "").strip(), True)
