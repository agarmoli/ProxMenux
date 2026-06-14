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


# ── installed version (inside the CT) ────────────────────────────────────
def read_installed_version(vmid, installed_spec):
    """Return (version|None, error|None). Runs a command/cat inside the CT."""
    method = (installed_spec or {}).get("method")
    value = (installed_spec or {}).get("value")
    regex = (installed_spec or {}).get("regex") or r"(\d+\.\d+\.\d+)"
    if not method or not value:
        return None, "no installed spec"
    try:
        vmid_s = str(int(vmid))
    except (TypeError, ValueError):
        return None, "bad vmid"
    if method == "file":
        argv = [_PCT_BIN, "exec", vmid_s, "--", "cat", value]
    else:
        argv = [_PCT_BIN, "exec", vmid_s, "--", "sh", "-c", value]
    try:
        r = subprocess.run(argv, capture_output=True, text=True,
                           timeout=_EXEC_TIMEOUT)
    except subprocess.TimeoutExpired:
        return None, "timeout reading version"
    except (FileNotFoundError, OSError) as e:
        return None, str(e)
    if r.returncode != 0:
        err = (r.stderr or "").lower()
        if "not running" in err or "stopped" in err:
            return None, "container stopped"
        return None, "version command failed"
    ver = _extract(r.stdout, regex) or _extract(r.stderr, regex)
    return (ver, None) if ver else (None, "could not parse version")


# ── latest from GitHub ───────────────────────────────────────────────────
def _gh_get(url, pat):
    headers = {"User-Agent": "ProxMenux-Monitor/1.0",
               "Accept": "application/vnd.github+json"}
    if pat:
        headers["Authorization"] = "Bearer " + pat
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=_FETCH_TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8", errors="replace"))


def fetch_latest(repo, github_source, tag_regex, pat=None):
    """Return (version|None, error|None)."""
    tag_regex = tag_regex or r"v?(\d+\.\d+\.\d+)"
    try:
        if github_source == "tags":
            tags = _gh_get(
                "https://api.github.com/repos/{}/tags?per_page=30".format(repo), pat)
            for t in (tags or []):
                ver = _extract((t or {}).get("name") or "", tag_regex)
                if ver:
                    return ver, None
            return None, "no matching tag"
        rel = _gh_get(
            "https://api.github.com/repos/{}/releases/latest".format(repo), pat)
        ver = _extract(rel.get("tag_name") or rel.get("name") or "", tag_regex)
        return (ver, None) if ver else (None, "could not parse release")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None, "repo or release not found"
        remaining = e.headers.get("X-RateLimit-Remaining") if e.headers else None
        if e.code == 403 and remaining == "0":
            return None, "github rate limited"
        return None, "github http {}".format(e.code)
    except (urllib.error.URLError, OSError, json.JSONDecodeError) as e:
        return None, "github error: {}".format(e)


# ── orchestration ────────────────────────────────────────────────────────
def _store_result(vmid, result):
    with _lock:
        db = _read_db()
        db.setdefault("results", {})[str(vmid)] = result
        _write_db(db)


def check_lxc_app(vmid, store=True):
    assignment = get_assignment(vmid)
    if not assignment:
        return None
    spec = _resolve_spec(assignment)
    if not spec:
        result = {"error": "unknown app", "last_check": _now_iso()}
        if store:
            _store_result(vmid, result)
        return result
    installed, ierr = read_installed_version(vmid, spec.get("installed"))
    latest, lerr = fetch_latest(spec["repo"], spec["github_source"],
                                spec.get("tag_regex"), _get_pat())
    update_available, non_semver = False, False
    if installed and latest:
        update_available, non_semver = compare(installed, latest)
    result = {
        "app_id": spec["app_id"],
        "name": spec.get("name"),
        "repo": spec["repo"],
        "installed": installed,
        "latest": latest,
        "update_available": update_available,
        "non_semver": non_semver,
        "error": ierr or lerr,
        "last_check": _now_iso(),
    }
    if store:
        _store_result(vmid, result)
    return result


def _is_stale(result, now):
    if not result or not result.get("last_check"):
        return True
    try:
        ts = datetime.fromisoformat(result["last_check"]).timestamp()
    except ValueError:
        return True
    return (now - ts) >= _REFRESH_TTL


def refresh_all(force=False):
    now = time.time()
    for vmid in list(list_assignments().keys()):
        if force or _is_stale(_read_db().get("results", {}).get(vmid), now):
            check_lxc_app(vmid, store=True)


def _trigger_background_refresh():
    with _lock:
        if _refreshing["flag"]:
            return
        _refreshing["flag"] = True

    def _run():
        try:
            refresh_all(force=False)
        finally:
            _refreshing["flag"] = False

    threading.Thread(target=_run, daemon=True).start()


def get_app_update_map():
    """vmid -> cached result, for decorating /api/vms. Non-blocking: triggers a
    background refresh when any assigned CT's result is missing/stale."""
    db = _read_db()
    results = db.get("results", {})
    assignments = db.get("assignments", {})
    now = time.time()
    if any(_is_stale(results.get(v), now) for v in assignments):
        _trigger_background_refresh()
    return {v: results[v] for v in assignments if results.get(v)}
