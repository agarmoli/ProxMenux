# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

ProxMenux is a Proxmox VE management toolset. Almost all active development in this fork
(`agarmoli/ProxMenux`, branch `feature/federation`) is on the **Monitor web dashboard** under
`AppImage/` — a single-host monitoring panel extended with **multi-node cluster federation**.
Start there.

## The one thing to know first

The install one-liner ships a **prebuilt AppImage that is committed in the repo**
(`AppImage/ProxMenux-1.2.2.2-beta.AppImage`). The installers (`install_proxmenux.sh`,
`install_proxmenux_beta.sh`) **clone the branch and install that committed binary — they do NOT
compile**. So **any code change is invisible until you rebuild the AppImage and commit it**
(plus regenerate `AppImage/ProxMenux-Monitor.AppImage.sha256`, or the installer aborts on a
hash mismatch). `install_proxmenux.sh` is pinned to `REPO_URL`/`REPO_BRANCH` near its top.

## Commands

All from `AppImage/` unless noted. Frontend = Next.js 15 (React 19, TypeScript, SWR);
backend = Python 3 / Flask.

- **Frontend build:** `cd AppImage && npm run build` (`next build`, static export to `out/`).
  - ⚠️ `next.config.mjs` sets `typescript.ignoreBuildErrors: true` and
    `eslint.ignoreDuringBuilds: true`. A passing build only proves **syntax/imports** are OK —
    it does **NOT** catch type or lint errors.
- **Type check (the real gate):** `npx tsc --noEmit`. The tree is "dirty" — many files have
  **pre-existing** TS errors. Gate per-file on *no NEW errors*:
  `npx tsc --noEmit 2>&1 | grep -c "<file>.tsx"` before vs after a change. There is **no JS test
  runner** (no jest/vitest); frontend correctness = build + scoped tsc + manual testing.
- **Python tests:** `cd AppImage/scripts && python3 -m pytest tests/ -v`
  (single file: `python3 -m pytest tests/test_federation_routes.py -v`; needs `flask` + `pytest`;
  `tests/conftest.py` puts `scripts/` on `sys.path`).
- **Build the AppImage:** `bash AppImage/scripts/build_appimage.sh` → `AppImage/dist/ProxMenux-*.AppImage`.
  - Requires a Linux host with: `node`/`npm`, `python3` + `pip3`, network (PyPI + GitHub for
    `appimagetool`), **FUSE** (`/dev/fuse`), and apt access for bundled hardware tools
    (`ipmitool`, `lm-sensors`, `nut-client`, **`libupsclient7`**). It runs `npm run export` then
    bundles a self-contained Flask+Next app.
  - To make the install one-liner serve your changes: build, then
    `cp -f AppImage/dist/ProxMenux-*.AppImage AppImage/ProxMenux-1.2.2.2-beta.AppImage` and
    `sha256sum that | awk '{print $1}' > AppImage/ProxMenux-Monitor.AppImage.sha256`, then commit.
  - The build's `pip3 install foo>=X` calls can create stray files named `=X.Y.Z` in
    `AppImage/scripts/` — never commit those (`git checkout -- 'AppImage/scripts/=*'`).
- **Runtime/service:** installed AppImage lives at
  `/usr/local/share/proxmenux/ProxMenux-Monitor.AppImage`, extracted (no FUSE mount) to
  `/usr/local/share/proxmenux/monitor-app/`, run by `systemd` unit `proxmenux-monitor.service`
  on port **8008**. Logs: `journalctl -u proxmenux-monitor`.

## Backend architecture (`AppImage/scripts/`)

- `flask_server.py` is the **main WSGI app** (very large) that registers feature blueprints
  (`flask_*_routes.py`) and defines the core single-node API (`/api/system`, `/api/storage`,
  `/api/network`, `/api/vms`, `/api/hardware`, `/api/logs`, …). Per-host monitors are
  independent; each node runs its own service.
- **Federation** (one "central" node presents the whole cluster — purely additive):
  - `federation_config.py` — peers stored in `/usr/local/share/proxmenux/federation.json`
    (name, host, scheme, port, token, enabled, insecure_tls).
  - `peer_client.py` — HTTP client to peers. **Never raises** (`fetch_json` returns
    `{online,status,data,error}`); TLS verified against the Proxmox cluster CA
    (`/etc/pve/pve-root-ca.pem`); explicit per-peer http/https scheme detected once at add time
    (no silent downgrade).
  - `flask_federation_routes.py` — the cluster API:
    - `GET /api/federation/aggregate?path=<p>` — **generic fan-out**: forwards `<p>` to self
      (in-process via `current_app.test_client()`, `_fetch_local`) + every enabled peer (in
      parallel), returns `{path, nodes:[{node,is_self,online,status,error,data}]}`. Extra query
      params besides `path` are forwarded to each node. This is the reusable base for every
      all-nodes view.
    - `ANY /api/proxy/<node>/<path>` — reverse-proxy to a peer (adds the peer's bearer token).
    - `_normalize_proxy_path` blocks `..` traversal and the non-proxyable allowlist
      (`/api/auth`, `/api/federation`, `/api/proxy`) — reused by both routes.
    - Bespoke aggregators predate the generic one: `/api/federation/overview`,
      `/nodes`, `/vms` (same `collect(self) + ThreadPoolExecutor(peers)` shape).

## Frontend architecture (`AppImage/components/`, `AppImage/lib/api-config.ts`)

`lib/api-config.ts` is the routing layer — understand these before touching any view:
- `fetchApi(endpoint)` → `getApiUrl(endpoint)`: when a **global active node** is selected
  (`getActiveNode()`, localStorage key `proxmenux-active-node`), it rewrites the URL to
  `/api/proxy/<activeNode>/...` **except** for `FEDERATION_LOCAL_PREFIXES`
  (`/api/federation`, `/api/proxy`, `/api/auth`, which always hit central).
- `fetchAtNode(node, isSelf, endpoint)` → uses `getLocalApiUrl` (ignores the global active node)
  and `nodeEndpoint`: `isSelf`/`undefined` node = bare local call; remote = `/api/proxy/<node>/...`.
  **`fetchAtNode(undefined, undefined, p)` == a plain local call** — this is why single-node
  installs are unaffected by all the cluster code.
- `aggregateUrl(path)` = `/api/federation/aggregate?path=<encoded>` (never proxied → central).
- Types `AggregateResponse<T>` / `AggregateNode<T>` mirror the aggregator response.

**Cluster-first view pattern** (how Network/Storage/Logs/VMs are built):
1. Fetch all nodes via `aggregateUrl(...)` (or `/api/federation/overview`, `/vms`).
2. Flatten each node's data client-side, tagging every row with `_node` / `_node_is_self`.
3. Render a unified list/table with a **Node badge/column**, **node-scoped React keys**
   (`${_node}:${id}` — bare ids collide across nodes), and local **filter chips** (All/nodeX).
4. Per-item drill-down/actions route to the row's node via
   `fetchAtNode(row._node, row._node_is_self, ...)`.
5. **Single-node parity:** when only one node is online, hide the chips/badges so the view is
   identical to the pre-cluster UI.

Variations: **Health** (modal) and **Hardware** (tab) use a *node picker* instead of merged
tables (dense per-machine data). Per-host config/action surfaces stay single-node and are
gated to the local node when remote (driver installs, **GPU mode switch**, Terminal — the
script terminal is a WebSocket that cannot be proxied). Raw-text fetches that need node routing
use `getLocalApiUrl(nodeEndpoint(...))` instead of `fetchApi` (e.g. task-log download).

The **global node selector** still drives the single-node surfaces (Overview detail, Backup,
Security, Settings) via `setActiveNode()` + `window.location.reload()`. Making this reactive
(killing the reload) is **Fase 7** — designed but not implemented.

## Working notes

- The whole cluster-first effort is specced/planned/tracked in `docs/superpowers/`:
  `2026-06-14-cluster-first-dashboard-roadmap.md` (phase status), plus `specs/` and `plans/`.
  Phases 1-6 (aggregator + Network/Storage/Logs/Health/Hardware/Overview) are implemented;
  Fase 7 (reactive selector) is spec-only.
- This codebase keeps large files (e.g. `flask_server.py`, `system-overview.tsx` ~900 lines,
  `storage-overview.tsx` ~4800 lines). Follow the existing structure; don't unilaterally split.
- Known deferred bug: `storage-overview.tsx`'s error guard blanks the whole tab if the *central*
  node's `/api/storage` fails even when peers are healthy (should key off "no node online").
