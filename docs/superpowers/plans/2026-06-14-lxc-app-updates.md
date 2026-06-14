# LXC App Update Detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For each LXC the operator assigns an app to, read the installed version inside the container and compare it to the latest GitHub release/tag, surfacing "installed → latest ⬆" in the existing VMs/LXC UI.

**Architecture:** A new isolated backend module (`lxc_app_updates.py`) owns a bundled app catalog, per-vmid assignments + cached results (its own `lxc_app_updates.json`, `0600`), reads installed versions via `pct exec`, and fetches latest versions from GitHub via `urllib` (mirroring the existing `_fetch_gasket_latest_tag` pattern, with optional PAT + caching). Results are attached to each LXC in `/api/vms` as a new `app_update` field, so the federation proxy aggregates them automatically. A small blueprint exposes catalog/assignment/check endpoints. The frontend adds a badge + an "Application" modal tab.

**Tech Stack:** Python 3 / Flask (bundled `urllib`, no new deps), pytest (existing dev setup), Next.js / React / TypeScript / shadcn-ui.

---

## Key facts established from the codebase

- Registry projection pattern: `flask_server.py:_get_lxc_update_status_map()` (lines 4790-4826) maps `vmid -> update_check` by iterating `managed_installs.get_active_items()` where `it['type']=='lxc'` and `it['_vmid']`. `get_proxmox_vms()` (line 4829) builds `vm_data` per resource and attaches `vm_data['update_check']` at lines 4870-4873, then `all_vms.append(vm_data)` (4874). We attach `app_update` the same way.
- `pct exec` pattern: `_run_pct_pkg_listing()` (`managed_installs.py:972`) runs `[_PCT_BIN, "exec", vmid, "--", "sh", "-c", cmd]`, `_PCT_BIN="/usr/sbin/pct"` (line 321).
- GitHub fetch pattern: `_fetch_gasket_latest_tag()` (`managed_installs.py:1207`) — `urllib.request.Request` with `User-Agent`+`Accept` headers, `urlopen(req, timeout=15)`, JSON parse, in-memory cache.
- Auth decorator: `from jwt_middleware import require_auth`. Blueprints registered in `flask_server.py:206-213`; imports at `72-81`. We mirror the federation blueprint pattern.
- AppImage bundling: each `.py`/data file under `scripts/` needs an explicit `cp` in `build_appimage.sh` (~lines 115-145). New files load data relative to `__file__`.
- Tests: pytest dev-only under `AppImage/scripts/tests/` with `conftest.py` adding `scripts/` to `sys.path` (added for federation). Reuse it. (This dev environment may lack flask/pytest; tests are deliverables — verify pure-logic manually where flask isn't needed, exactly as done for the federation backend.)
- Frontend `virtual-machines.tsx`: `VMData` interface (lines 45-63, `update_check?` at 62); `renderLxcUpdateBadge()` (1063-1118) called at rows 1530/1643 and modal header 1750-1755; `activeModalTab` state union (line 649); tab buttons (1808-1914); SWR `useSWR<VMData[]>("/api/vms", ...)` (597-603); `fetchApi` imported (line 21); UI primitives `Select/Dialog/Button/Badge/Label/Input` available via `./ui/*`.

## File structure

**Create (backend):**
- `AppImage/scripts/lxc_app_catalog.json` — bundled starter catalog.
- `AppImage/scripts/lxc_app_updates.py` — core module (catalog, db, versions, fetch, compare, orchestration).
- `AppImage/scripts/flask_lxc_app_routes.py` — `lxc_app_bp` blueprint.
- `AppImage/scripts/tests/test_lxc_app_updates.py` — unit tests.

**Create (frontend):**
- `AppImage/components/lxc-app-panel.tsx` — `AppUpdate` type, `renderAppUpdateBadge()`, and `<LxcAppPanel>` (modal tab content + assignment form).

**Modify:**
- `AppImage/scripts/flask_server.py` — register blueprint; attach `app_update` in `get_proxmox_vms()`.
- `AppImage/scripts/build_appimage.sh` — `cp` the 3 new backend files.
- `AppImage/components/virtual-machines.tsx` — `app_update` field, badges, "application" tab.

---

## Phase 1 — Backend module core (catalog, db, versions, compare)

### Task 1: Bundled catalog file

**Files:**
- Create: `AppImage/scripts/lxc_app_catalog.json`

- [ ] **Step 1: Create the starter catalog**

`AppImage/scripts/lxc_app_catalog.json` (installed paths are best-effort starting points — verify/adjust on real CTs; anything off is covered by the "custom" path):

```json
{
  "version": 1,
  "apps": [
    {
      "id": "jellyfin",
      "name": "Jellyfin",
      "repo": "jellyfin/jellyfin",
      "github_source": "releases",
      "tag_regex": "v?(\\d+\\.\\d+\\.\\d+)",
      "installed": { "method": "command", "value": "dpkg-query -W -f='${Version}' jellyfin-server 2>/dev/null || jellyfin --version 2>/dev/null", "regex": "(\\d+\\.\\d+\\.\\d+)" }
    },
    {
      "id": "radarr",
      "name": "Radarr",
      "repo": "Radarr/Radarr",
      "github_source": "releases",
      "tag_regex": "v?(\\d+\\.\\d+\\.\\d+\\.\\d+)",
      "installed": { "method": "file", "value": "/opt/Radarr/package_info", "regex": "PackageVersion=(\\S+)" }
    },
    {
      "id": "sonarr",
      "name": "Sonarr",
      "repo": "Sonarr/Sonarr",
      "github_source": "releases",
      "tag_regex": "v?(\\d+\\.\\d+\\.\\d+\\.\\d+)",
      "installed": { "method": "file", "value": "/opt/Sonarr/package_info", "regex": "PackageVersion=(\\S+)" }
    },
    {
      "id": "prowlarr",
      "name": "Prowlarr",
      "repo": "Prowlarr/Prowlarr",
      "github_source": "releases",
      "tag_regex": "v?(\\d+\\.\\d+\\.\\d+\\.\\d+)",
      "installed": { "method": "file", "value": "/opt/Prowlarr/package_info", "regex": "PackageVersion=(\\S+)" }
    },
    {
      "id": "adguardhome",
      "name": "AdGuard Home",
      "repo": "AdguardTeam/AdGuardHome",
      "github_source": "releases",
      "tag_regex": "v(\\d+\\.\\d+\\.\\d+)",
      "installed": { "method": "command", "value": "/opt/AdGuardHome/AdGuardHome --version 2>/dev/null", "regex": "v(\\d+\\.\\d+\\.\\d+)" }
    },
    {
      "id": "vaultwarden",
      "name": "Vaultwarden",
      "repo": "dani-garcia/vaultwarden",
      "github_source": "releases",
      "tag_regex": "(\\d+\\.\\d+\\.\\d+)",
      "installed": { "method": "command", "value": "vaultwarden --version 2>/dev/null", "regex": "(\\d+\\.\\d+\\.\\d+)" }
    },
    {
      "id": "uptimekuma",
      "name": "Uptime Kuma",
      "repo": "louislam/uptime-kuma",
      "github_source": "releases",
      "tag_regex": "(\\d+\\.\\d+\\.\\d+)",
      "installed": { "method": "command", "value": "cat /opt/uptime-kuma/package.json 2>/dev/null", "regex": "\"version\"\\s*:\\s*\"(\\d+\\.\\d+\\.\\d+)\"" }
    },
    {
      "id": "gotify",
      "name": "Gotify",
      "repo": "gotify/server",
      "github_source": "releases",
      "tag_regex": "v(\\d+\\.\\d+\\.\\d+)",
      "installed": { "method": "command", "value": "/opt/gotify/gotify-* version 2>/dev/null", "regex": "Version:?\\s*(\\d+\\.\\d+\\.\\d+)" }
    }
  ]
}
```

- [ ] **Step 2: Validate it parses**

Run: `cd AppImage/scripts && python3 -c "import json; print(len(json.load(open('lxc_app_catalog.json'))['apps']), 'apps')"`
Expected: `8 apps`

- [ ] **Step 3: Commit**

```bash
git add AppImage/scripts/lxc_app_catalog.json
git commit -m "feat(lxc-apps): bundled starter app catalog"
```

---

### Task 2: Module — catalog, db, settings, assignments

**Files:**
- Create: `AppImage/scripts/lxc_app_updates.py`
- Test: `AppImage/scripts/tests/test_lxc_app_updates.py`

- [ ] **Step 1: Write the failing tests**

`AppImage/scripts/tests/test_lxc_app_updates.py`:

```python
import json
import os
import pytest
import lxc_app_updates as lau


@pytest.fixture
def env(tmp_path, monkeypatch):
    cat = tmp_path / "cat.json"
    cat.write_text(json.dumps({"version": 1, "apps": [
        {"id": "jellyfin", "name": "Jellyfin", "repo": "jellyfin/jellyfin",
         "github_source": "releases", "tag_regex": r"v?(\d+\.\d+\.\d+)",
         "installed": {"method": "command", "value": "jellyfin --version", "regex": r"(\d+\.\d+\.\d+)"}}
    ]}))
    db = tmp_path / "db.json"
    monkeypatch.setenv("PROXMENUX_LXC_APP_CATALOG", str(cat))
    monkeypatch.setenv("PROXMENUX_LXC_APP_DB", str(db))
    lau._catalog_cache["apps"] = None  # reset memoization
    return db


def test_catalog_loads(env):
    apps = lau.load_catalog()
    assert "jellyfin" in apps
    assert lau.catalog_list()[0]["repo"] == "jellyfin/jellyfin"


def test_assignment_catalog_app(env):
    spec = lau.set_assignment(101, {"app_id": "jellyfin"})
    assert spec == {"app_id": "jellyfin"}
    assert lau.get_assignment(101) == {"app_id": "jellyfin"}


def test_assignment_unknown_app_rejected(env):
    with pytest.raises(ValueError):
        lau.set_assignment(101, {"app_id": "nope"})


def test_assignment_custom_validates_repo(env):
    with pytest.raises(ValueError):
        lau.set_assignment(101, {"app_id": "custom", "repo": "noslash",
                                 "installed": {"method": "file", "value": "/x"}})
    spec = lau.set_assignment(102, {"app_id": "custom", "repo": "o/r",
                                    "installed": {"method": "file", "value": "/x"}})
    assert spec["repo"] == "o/r" and spec["github_source"] == "releases"


def test_clear_assignment(env):
    lau.set_assignment(101, {"app_id": "jellyfin"})
    assert lau.clear_assignment(101) is True
    assert lau.get_assignment(101) is None
    assert lau.clear_assignment(101) is False


def test_db_file_is_0600(env):
    lau.set_github_pat("ghp_secret")
    assert oct(os.stat(env).st_mode & 0o777) == "0o600"
    assert lau.get_settings() == {"github_pat_configured": True}


def test_version_tuple_and_compare(env):
    assert lau._version_tuple("1.2.10") == (1, 2, 10)
    assert lau.compare("1.2.0", "1.3.0") == (True, False)
    assert lau.compare("1.3.0", "1.3.0") == (False, False)
    assert lau.compare("stable-22", "stable-23") == (True, True)


def test_extract_regex(env):
    assert lau._extract("Jellyfin 10.9.1 build", r"(\d+\.\d+\.\d+)") == "10.9.1"
    assert lau._extract("no version", r"(\d+\.\d+\.\d+)") is None
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd AppImage/scripts && python -m pytest tests/test_lxc_app_updates.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'lxc_app_updates'`

- [ ] **Step 3: Write the module (part 1 — catalog/db/settings/assignments/version)**

`AppImage/scripts/lxc_app_updates.py`:

```python
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
```

- [ ] **Step 4: Run to verify Task-2 tests pass**

Run: `cd AppImage/scripts && python -m pytest tests/test_lxc_app_updates.py -v`
Expected: PASS (8 passed)

- [ ] **Step 5: Commit**

```bash
git add AppImage/scripts/lxc_app_updates.py AppImage/scripts/tests/test_lxc_app_updates.py
git commit -m "feat(lxc-apps): catalog, assignments store, version compare"
```

---

## Phase 2 — Backend: version read, GitHub fetch, orchestration

### Task 3: Installed version (pct exec) + GitHub fetch + check

**Files:**
- Modify: `AppImage/scripts/lxc_app_updates.py` (append functions)
- Modify: `AppImage/scripts/tests/test_lxc_app_updates.py` (append tests)

- [ ] **Step 1: Write the failing tests (append)**

Append to `AppImage/scripts/tests/test_lxc_app_updates.py`:

```python
from unittest.mock import patch, MagicMock
import urllib.error


def test_read_installed_version_command(env):
    completed = MagicMock(returncode=0, stdout="Jellyfin 10.9.1\n", stderr="")
    with patch("lxc_app_updates.subprocess.run", return_value=completed):
        ver, err = lau.read_installed_version(
            101, {"method": "command", "value": "jellyfin --version", "regex": r"(\d+\.\d+\.\d+)"})
    assert ver == "10.9.1" and err is None


def test_read_installed_version_stopped(env):
    completed = MagicMock(returncode=2, stdout="", stderr="Container 101 is not running")
    with patch("lxc_app_updates.subprocess.run", return_value=completed):
        ver, err = lau.read_installed_version(
            101, {"method": "command", "value": "x", "regex": r"(\d+)"})
    assert ver is None and err == "container stopped"


def test_fetch_latest_releases(env):
    with patch("lxc_app_updates._gh_get", return_value={"tag_name": "v10.9.2"}):
        ver, err = lau.fetch_latest("o/r", "releases", r"v?(\d+\.\d+\.\d+)")
    assert ver == "10.9.2" and err is None


def test_fetch_latest_tags_first_match(env):
    tags = [{"name": "nightly"}, {"name": "v2.5.0"}, {"name": "v2.4.0"}]
    with patch("lxc_app_updates._gh_get", return_value=tags):
        ver, err = lau.fetch_latest("o/r", "tags", r"v(\d+\.\d+\.\d+)")
    assert ver == "2.5.0" and err is None


def test_fetch_latest_rate_limited(env):
    err = urllib.error.HTTPError("u", 403, "forbidden",
                                 {"X-RateLimit-Remaining": "0"}, None)
    with patch("lxc_app_updates._gh_get", side_effect=err):
        ver, e = lau.fetch_latest("o/r", "releases", r"(\d+)")
    assert ver is None and e == "github rate limited"


def test_fetch_latest_404(env):
    err = urllib.error.HTTPError("u", 404, "nf", {}, None)
    with patch("lxc_app_updates._gh_get", side_effect=err):
        ver, e = lau.fetch_latest("o/r", "releases", r"(\d+)")
    assert e == "repo or release not found"


def test_check_lxc_app_end_to_end(env):
    lau.set_assignment(101, {"app_id": "jellyfin"})
    completed = MagicMock(returncode=0, stdout="10.9.1", stderr="")
    with patch("lxc_app_updates.subprocess.run", return_value=completed), \
         patch("lxc_app_updates._gh_get", return_value={"tag_name": "v10.9.2"}):
        res = lau.check_lxc_app(101)
    assert res["installed"] == "10.9.1"
    assert res["latest"] == "10.9.2"
    assert res["update_available"] is True
    # cached result is now in the map
    assert "101" in lau.get_app_update_map()
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd AppImage/scripts && python -m pytest tests/test_lxc_app_updates.py -k "installed or fetch or end_to_end" -v`
Expected: FAIL — `AttributeError: module 'lxc_app_updates' has no attribute 'read_installed_version'`

- [ ] **Step 3: Append the implementation**

Append to `AppImage/scripts/lxc_app_updates.py`:

```python
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
```

- [ ] **Step 4: Run to verify all module tests pass**

Run: `cd AppImage/scripts && python -m pytest tests/test_lxc_app_updates.py -v`
Expected: PASS (all tests across Tasks 2 and 3 green)

- [ ] **Step 5: Commit**

```bash
git add AppImage/scripts/lxc_app_updates.py AppImage/scripts/tests/test_lxc_app_updates.py
git commit -m "feat(lxc-apps): pct version read, GitHub fetch, check orchestration"
```

---

## Phase 3 — Backend: routes blueprint + wiring

### Task 4: Routes blueprint

**Files:**
- Create: `AppImage/scripts/flask_lxc_app_routes.py`
- Test: `AppImage/scripts/tests/test_lxc_app_routes.py`

- [ ] **Step 1: Write the failing tests**

`AppImage/scripts/tests/test_lxc_app_routes.py`:

```python
import pytest
from flask import Flask
import flask_lxc_app_routes as routes


@pytest.fixture
def client(monkeypatch):
    app = Flask(__name__)
    app.register_blueprint(routes.lxc_app_bp)
    return app.test_client()


def test_catalog_endpoint(client, monkeypatch):
    monkeypatch.setattr(routes.lau, "catalog_list",
                        lambda: [{"id": "jellyfin", "name": "Jellyfin"}])
    body = client.get("/api/lxc-app-catalog").get_json()
    assert body["apps"][0]["id"] == "jellyfin"


def test_assign_validation_error(client, monkeypatch):
    def boom(vmid, data):
        raise ValueError("app_id is required")
    monkeypatch.setattr(routes.lau, "set_assignment", boom)
    r = client.post("/api/vms/101/app", json={})
    assert r.status_code == 400
    assert "app_id" in r.get_json()["error"]


def test_assign_ok_runs_check(client, monkeypatch):
    monkeypatch.setattr(routes.lau, "set_assignment",
                        lambda vmid, data: {"app_id": "jellyfin"})
    monkeypatch.setattr(routes.lau, "check_lxc_app",
                        lambda vmid, store=True: {"installed": "1.0", "latest": "1.1",
                                                  "update_available": True})
    body = client.post("/api/vms/101/app", json={"app_id": "jellyfin"}).get_json()
    assert body["success"] is True
    assert body["app_update"]["update_available"] is True


def test_delete_assignment(client, monkeypatch):
    monkeypatch.setattr(routes.lau, "clear_assignment", lambda vmid: True)
    assert client.delete("/api/vms/101/app").status_code == 200


def test_check_no_assignment_404(client, monkeypatch):
    monkeypatch.setattr(routes.lau, "check_lxc_app", lambda vmid, store=True: None)
    assert client.post("/api/vms/101/app/check").status_code == 404


def test_settings_set(client, monkeypatch):
    captured = {}
    monkeypatch.setattr(routes.lau, "set_github_pat",
                        lambda pat: captured.update(pat=pat))
    monkeypatch.setattr(routes.lau, "get_settings",
                        lambda: {"github_pat_configured": True})
    body = client.post("/api/lxc-app/settings", json={"github_pat": "ghp_x"}).get_json()
    assert captured["pat"] == "ghp_x"
    assert body["github_pat_configured"] is True
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd AppImage/scripts && python -m pytest tests/test_lxc_app_routes.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'flask_lxc_app_routes'`

- [ ] **Step 3: Write the blueprint**

`AppImage/scripts/flask_lxc_app_routes.py`:

```python
"""
ProxMenux — LXC app update REST endpoints.
"""

from flask import Blueprint, jsonify, request

import lxc_app_updates as lau
from jwt_middleware import require_auth

lxc_app_bp = Blueprint("lxc_app", __name__)


@lxc_app_bp.route("/api/lxc-app-catalog", methods=["GET"])
@require_auth
def catalog():
    return jsonify({"apps": lau.catalog_list()})


@lxc_app_bp.route("/api/lxc-app/settings", methods=["GET"])
@require_auth
def settings_get():
    return jsonify(lau.get_settings())


@lxc_app_bp.route("/api/lxc-app/settings", methods=["POST"])
@require_auth
def settings_set():
    data = request.get_json(silent=True) or {}
    lau.set_github_pat(data.get("github_pat"))
    return jsonify({"success": True, **lau.get_settings()})


@lxc_app_bp.route("/api/vms/<int:vmid>/app", methods=["GET"])
@require_auth
def app_get(vmid):
    return jsonify({"assignment": lau.get_assignment(vmid)})


@lxc_app_bp.route("/api/vms/<int:vmid>/app", methods=["POST"])
@require_auth
def app_set(vmid):
    data = request.get_json(silent=True) or {}
    try:
        spec = lau.set_assignment(vmid, data)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    result = lau.check_lxc_app(vmid, store=True)
    return jsonify({"success": True, "assignment": spec, "app_update": result})


@lxc_app_bp.route("/api/vms/<int:vmid>/app", methods=["DELETE"])
@require_auth
def app_delete(vmid):
    lau.clear_assignment(vmid)
    return jsonify({"success": True})


@lxc_app_bp.route("/api/vms/<int:vmid>/app/check", methods=["POST"])
@require_auth
def app_check(vmid):
    result = lau.check_lxc_app(vmid, store=True)
    if result is None:
        return jsonify({"error": "no app assigned"}), 404
    return jsonify({"app_update": result})
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd AppImage/scripts && python -m pytest tests/test_lxc_app_routes.py -v`
Expected: PASS (6 passed)

- [ ] **Step 5: Commit**

```bash
git add AppImage/scripts/flask_lxc_app_routes.py AppImage/scripts/tests/test_lxc_app_routes.py
git commit -m "feat(lxc-apps): REST blueprint (catalog, assignment, check, settings)"
```

---

### Task 5: Wire into flask_server + build

**Files:**
- Modify: `AppImage/scripts/flask_server.py` (import + register ~lines 77/212; attach in `get_proxmox_vms`)
- Modify: `AppImage/scripts/build_appimage.sh`

- [ ] **Step 1: Add the import**

In `AppImage/scripts/flask_server.py`, after the line `from flask_federation_routes import federation_bp  # noqa: E402`, add:

```python
from flask_lxc_app_routes import lxc_app_bp  # noqa: E402
```

- [ ] **Step 2: Register the blueprint**

After `app.register_blueprint(federation_bp)`, add:

```python
app.register_blueprint(lxc_app_bp)
```

- [ ] **Step 3: Add the app-update map helper**

In `AppImage/scripts/flask_server.py`, immediately after the `_get_lxc_update_status_map()` function (ends line 4826), add:

```python
def _get_lxc_app_update_map() -> dict:
    """vmid -> app_update result, projected from lxc_app_updates. Empty on any
    error so /api/vms degrades gracefully."""
    try:
        import lxc_app_updates
        return lxc_app_updates.get_app_update_map() or {}
    except Exception:
        return {}
```

- [ ] **Step 4: Compute and attach the map in get_proxmox_vms**

In `get_proxmox_vms()`, after the line `lxc_updates_map = _get_lxc_update_status_map()` (line 4833), add:

```python
        lxc_app_map = _get_lxc_app_update_map()
```

Then, replace the existing LXC-decoration block (lines 4870-4873):

```python
                    if vm_type == 'lxc':
                        upd = lxc_updates_map.get(str(resource.get('vmid')))
                        if upd is not None:
                            vm_data['update_check'] = upd
```

with:

```python
                    if vm_type == 'lxc':
                        upd = lxc_updates_map.get(str(resource.get('vmid')))
                        if upd is not None:
                            vm_data['update_check'] = upd
                        app_upd = lxc_app_map.get(str(resource.get('vmid')))
                        if app_upd is not None:
                            vm_data['app_update'] = app_upd
```

- [ ] **Step 5: Add build copy lines**

In `AppImage/scripts/build_appimage.sh`, after the `cp` line for `peer_client.py`, add:

```bash
cp "$SCRIPT_DIR/lxc_app_updates.py" "$APP_DIR/usr/bin/" 2>/dev/null || echo "⚠️  lxc_app_updates.py not found"
cp "$SCRIPT_DIR/flask_lxc_app_routes.py" "$APP_DIR/usr/bin/" 2>/dev/null || echo "⚠️  flask_lxc_app_routes.py not found"
cp "$SCRIPT_DIR/lxc_app_catalog.json" "$APP_DIR/usr/bin/" 2>/dev/null || echo "⚠️  lxc_app_catalog.json not found"
```

- [ ] **Step 6: Verify syntax**

Run: `cd AppImage/scripts && python3 -c "import ast; [ast.parse(open(f).read()) for f in ('flask_server.py','flask_lxc_app_routes.py','lxc_app_updates.py')]; print('syntax OK')"`
Expected: `syntax OK`

- [ ] **Step 7: Commit**

```bash
git add AppImage/scripts/flask_server.py AppImage/scripts/build_appimage.sh
git commit -m "feat(lxc-apps): register blueprint, attach app_update to /api/vms, bundle"
```

---

## Phase 4 — Frontend

### Task 6: App panel component (type, badge, assignment form)

**Files:**
- Create: `AppImage/components/lxc-app-panel.tsx`

- [ ] **Step 1: Create the component**

`AppImage/components/lxc-app-panel.tsx`:

```tsx
"use client"

import { useEffect, useState } from "react"
import { Package, ArrowUp, RefreshCw, ExternalLink, Trash2 } from "lucide-react"
import { Badge } from "./ui/badge"
import { Button } from "./ui/button"
import { Input } from "./ui/input"
import { Label } from "./ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select"
import { fetchApi } from "../lib/api-config"

export interface AppUpdate {
  app_id?: string
  name?: string
  repo?: string
  installed?: string | null
  latest?: string | null
  update_available?: boolean
  non_semver?: boolean
  error?: string | null
  last_check?: string | null
}

interface CatalogApp {
  id: string
  name: string
  repo: string
}

/** Compact chip shown on LXC rows / modal header. */
export function renderAppUpdateBadge(app?: AppUpdate, compact = false, onClick?: () => void) {
  if (!app || (!app.installed && !app.latest && !app.error)) return null
  const up = !!app.update_available
  const cls = up
    ? "bg-amber-500/10 text-amber-400 border-amber-500/30"
    : "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
  const label = up
    ? `${app.installed ?? "?"} → ${app.latest ?? "?"}`
    : (app.installed ?? app.error ?? "—")
  return (
    <Badge
      variant="outline"
      className={`${cls} flex items-center gap-1 flex-shrink-0 ${onClick ? "cursor-pointer" : ""}`}
      title={app.error ? `App: ${app.error}` : `${app.name ?? "App"} ${app.installed ?? "?"} (latest ${app.latest ?? "?"})`}
      onClick={onClick}
    >
      {up ? <ArrowUp className="h-3 w-3" /> : <Package className="h-3 w-3" />}
      {compact ? (app.name ?? "App") : `${app.name ?? "App"} ${label}`}
    </Badge>
  )
}

/** Modal "Application" tab: shows current status + assignment form. */
export function LxcAppPanel({
  vmid,
  appUpdate,
  onChanged,
}: {
  vmid: number
  appUpdate?: AppUpdate
  onChanged?: () => void
}) {
  const [catalog, setCatalog] = useState<CatalogApp[]>([])
  const [appId, setAppId] = useState<string>(appUpdate?.app_id ?? "")
  const [repo, setRepo] = useState("")
  const [source, setSource] = useState<"releases" | "tags">("releases")
  const [method, setMethod] = useState<"file" | "command">("command")
  const [value, setValue] = useState("")
  const [regex, setRegex] = useState("(\\d+\\.\\d+\\.\\d+)")
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [current, setCurrent] = useState<AppUpdate | undefined>(appUpdate)

  useEffect(() => {
    fetchApi<{ apps: CatalogApp[] }>("/api/lxc-app-catalog")
      .then((d) => setCatalog(d.apps || []))
      .catch(() => setCatalog([]))
    fetchApi<{ assignment: any }>(`/api/vms/${vmid}/app`)
      .then((d) => { if (d.assignment?.app_id) setAppId(d.assignment.app_id) })
      .catch(() => {})
  }, [vmid])

  const save = async () => {
    setBusy(true); setMsg(null)
    const body: any = { app_id: appId }
    if (appId === "custom") {
      body.repo = repo
      body.github_source = source
      body.installed = { method, value, regex }
    }
    try {
      const res = await fetchApi<{ app_update: AppUpdate }>(`/api/vms/${vmid}/app`, {
        method: "POST", body: JSON.stringify(body),
      })
      setCurrent(res.app_update)
      onChanged?.()
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const recheck = async () => {
    setBusy(true); setMsg(null)
    try {
      const res = await fetchApi<{ app_update: AppUpdate }>(`/api/vms/${vmid}/app/check`, { method: "POST" })
      setCurrent(res.app_update); onChanged?.()
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true); setMsg(null)
    try {
      await fetchApi(`/api/vms/${vmid}/app`, { method: "DELETE" })
      setCurrent(undefined); setAppId(""); onChanged?.()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      {current && (current.installed || current.latest || current.error) && (
        <div className="rounded-lg border border-border p-3 text-sm space-y-1">
          <div className="flex items-center justify-between">
            <span className="font-medium">{current.name ?? current.repo}</span>
            {current.repo && (
              <a className="text-xs text-blue-400 inline-flex items-center gap-1"
                 href={`https://github.com/${current.repo}`} target="_blank" rel="noreferrer">
                GitHub <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
          <div>Installed: <strong>{current.installed ?? "—"}</strong></div>
          <div>Latest: <strong>{current.latest ?? "—"}</strong></div>
          {current.update_available && <div className="text-amber-400">Update available{current.non_semver ? " (non-semver compare)" : ""}</div>}
          {current.error && <div className="text-red-400">{current.error}</div>}
        </div>
      )}

      <div className="space-y-2">
        <Label>Application</Label>
        <Select value={appId} onValueChange={setAppId}>
          <SelectTrigger><SelectValue placeholder="Select an app…" /></SelectTrigger>
          <SelectContent>
            {catalog.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
            <SelectItem value="custom">Custom…</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {appId === "custom" && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div><Label>GitHub repo (owner/name)</Label><Input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name" /></div>
          <div>
            <Label>Latest from</Label>
            <Select value={source} onValueChange={(v) => setSource(v as any)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="releases">releases</SelectItem>
                <SelectItem value="tags">tags</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Installed via</Label>
            <Select value={method} onValueChange={(v) => setMethod(v as any)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="command">command</SelectItem>
                <SelectItem value="file">file (cat)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div><Label>{method === "file" ? "File path" : "Command"}</Label><Input value={value} onChange={(e) => setValue(e.target.value)} placeholder={method === "file" ? "/opt/app/VERSION" : "app --version"} /></div>
          <div className="sm:col-span-2"><Label>Version regex</Label><Input value={regex} onChange={(e) => setRegex(e.target.value)} /></div>
        </div>
      )}

      {msg && <div className="text-sm text-red-400">{msg}</div>}

      <div className="flex flex-wrap gap-2">
        <Button onClick={save} disabled={busy || !appId || (appId === "custom" && (!repo || !value))}>Save</Button>
        <Button variant="outline" onClick={recheck} disabled={busy || !appId}><RefreshCw className="h-4 w-4 mr-2" />Check now</Button>
        {current && <Button variant="ghost" onClick={remove} disabled={busy}><Trash2 className="h-4 w-4" /></Button>}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify it type-checks (no new errors in this file)**

Run: `cd AppImage && npx tsc --noEmit 2>&1 | grep "components/lxc-app-panel.tsx" | head`
Expected: no output (no errors in the new file).

- [ ] **Step 3: Commit**

```bash
git add AppImage/components/lxc-app-panel.tsx
git commit -m "feat(lxc-apps): app panel component (badge + assignment form)"
```

---

### Task 7: Integrate into virtual-machines.tsx

**Files:**
- Modify: `AppImage/components/virtual-machines.tsx`

- [ ] **Step 1: Import the panel + badge**

Near the top imports (after line 21, `import { fetchApi } from "../lib/api-config"`), add:

```tsx
import { LxcAppPanel, renderAppUpdateBadge, type AppUpdate } from "./lxc-app-panel"
```

- [ ] **Step 2: Add `app_update` to the VMData interface**

In `AppImage/components/virtual-machines.tsx`, change line 62 (`update_check?: LxcUpdateCheck`) so the interface includes the new field:

```tsx
  update_check?: LxcUpdateCheck
  app_update?: AppUpdate
```

- [ ] **Step 3: Add "application" to the modal tab union**

Change line 649:

```tsx
  const [activeModalTab, setActiveModalTab] = useState<"status" | "mounts" | "backups" | "updates" | "firewall" | "application">("status")
```

- [ ] **Step 4: Show the badge on the desktop row**

After line 1530 (`{vm.type === "lxc" && renderLxcUpdateBadge(vm.update_check)}`), add:

```tsx
                  {vm.type === "lxc" && renderAppUpdateBadge(vm.app_update)}
```

- [ ] **Step 5: Show the badge on the mobile card**

After line 1643 (`{vm.type === "lxc" && renderLxcUpdateBadge(vm.update_check, true)}`), add:

```tsx
                  {vm.type === "lxc" && renderAppUpdateBadge(vm.app_update, true)}
```

- [ ] **Step 6: Add the "Application" tab button**

In the tab-button row (after the existing "updates" tab button, which renders around lines 1859-1888), add a new button (LXC-only). Insert after that block:

```tsx
              {selectedVM?.type === "lxc" && (
                <button
                  onClick={() => setActiveModalTab("application")}
                  className={`flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px whitespace-nowrap shrink-0 ${
                    activeModalTab === "application"
                      ? "border-amber-500 text-amber-500"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Package className="h-4 w-4" />
                  <span className={activeModalTab === "application" ? "" : "hidden sm:inline"}>App</span>
                </button>
              )}
```

(`Package` is already imported in this file.)

- [ ] **Step 7: Add the tab content**

After the `updates` tab content block (ends ~line 2779), add:

```tsx
            {activeModalTab === "application" && selectedVM && (
              <LxcAppPanel
                vmid={selectedVM.vmid}
                appUpdate={selectedVM.app_update}
                onChanged={() => mutate()}
              />
            )}
```

(`mutate` is the SWR mutate from the `useSWR<VMData[]>("/api/vms", …)` hook at lines 597-603.)

- [ ] **Step 8: Make the header badge open the App tab**

The modal header renders the OS badge at lines 1750-1755 with `() => setActiveModalTab("updates")`. Right after that block, add the app badge that opens the App tab:

```tsx
                {selectedVM.type === "lxc" &&
                  renderAppUpdateBadge(
                    selectedVM.app_update,
                    false,
                    () => setActiveModalTab("application"),
                  )}
```

- [ ] **Step 9: Verify the build**

Run: `cd AppImage && npx tsc --noEmit 2>&1 | grep -E "lxc-app-panel|virtual-machines" | grep -v "Property '(success|update_available|health)' does not exist"; npm run build`
Expected: no new type errors in the edited/new files; `next build` reports `✓ Compiled successfully` and exports.

- [ ] **Step 10: Commit**

```bash
git add AppImage/components/virtual-machines.tsx
git commit -m "feat(lxc-apps): app badge + Application tab in the LXC view"
```

---

## Phase 5 — Verification, build, docs

### Task 8: End-to-end verification on a real node

Manual (needs a real CT). Perform on a node running an assigned app.

- [ ] **Step 1: Build & install** the federation+lxc-apps AppImage on the node (rebuild via the CI workflow on the branch, then reinstall; or `build_appimage.sh`).
- [ ] **Step 2: Assign** an app: open an LXC → **App** tab → pick a catalog app (or Custom) → Save. Confirm a result appears (installed/latest).
- [ ] **Step 3: Badge** — confirm the chip shows on the LXC row (e.g. "Jellyfin 10.9.1 → 10.9.2 ⬆" or green "up to date").
- [ ] **Step 4: Check now** — press it; confirm it re-reads and updates `last_check`.
- [ ] **Step 5: Custom** — assign a custom repo + version command for an app not in the catalog; confirm it works.
- [ ] **Step 6: Error states** — stop the CT and re-check → "container stopped"; assign a bogus repo → "repo or release not found".
- [ ] **Step 7: Federation** — from the central node, view a remote node's LXC and confirm `app_update` shows through the proxy (the field rides `/api/vms`).
- [ ] **Step 8: PAT (optional)** — if you hit "github rate limited", set a PAT via the settings endpoint and confirm checks resume.

### Task 9: Documentation

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

- [ ] **Step 1: README** — under the ProxMenux Monitor section, add a short note:

```markdown
**LXC app update detection:** assign an application to an LXC (curated list or a
custom GitHub repo + version command) and the dashboard shows the installed
version vs the latest GitHub release/tag, flagging updates. Detection only — it
never applies updates. Optional GitHub token raises the API rate limit.
```

- [ ] **Step 2: CHANGELOG** — add a bullet under the current date heading:

```markdown
- **LXC app update detection:** per-container app assignment (catalog + custom),
  reads the installed version via `pct exec` and compares it to the latest
  GitHub release/tag; surfaces "installed → latest ⬆" on each LXC. New
  `/api/lxc-app-catalog`, `/api/vms/<id>/app[/check]`, `/api/lxc-app/settings`
  endpoints and an `app_update` field on `/api/vms` (aggregated via federation).
```

- [ ] **Step 3: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs(lxc-apps): document LXC app update detection"
```

---

## Self-review notes (for the implementer)

- **Catalog install paths are best-effort.** The bundled `installed` commands/paths cover common layouts but vary by how each app was installed; when a catalog app reads no version, switch that CT to **Custom** with the correct path. Treat the catalog as a starting set to refine on real CTs.
- **Non-blocking refresh.** `/api/vms` only ever reads cached results; a stale/missing result triggers a background thread. Right after assigning, the badge may be empty for a moment until the first check (run synchronously by `POST /api/vms/<id>/app`) stores its result.
- **Federation.** Assignments + checks are per-node (the CT runs on one node; assigning through the central proxy persists on that node). The `app_update` field rides `/api/vms`, so the central aggregates it with zero extra code.
- **Security.** The PAT lives only in the module's `0600` db and is never returned to the browser (only a `github_pat_configured` boolean). Custom version commands are operator-entered and run via `pct exec` as root — same trust model as the rest of ProxMenux.
```
