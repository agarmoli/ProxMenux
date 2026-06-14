# Federation Generic Aggregator + Network Pilot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a generic `/api/federation/aggregate?path=…` fan-out endpoint and prove it end-to-end by converting the Network tab into an all-nodes view (Node column + local filter + node-routed drill-down).

**Architecture:** The aggregator is a "dumb pipe": it forwards one API `path` to self (in-process via `test_client`) and every enabled peer (via the existing reverse-proxy + token), returning each node's response verbatim under `{path, nodes:[{node,is_self,online,status,error,data}]}`. The frontend flattens per-view, tagging each row with its node. The Network pilot consumes the aggregator for the interface list and routes per-item drill-down with the existing `fetchAtNode` helper. The global header selector is NOT touched in this phase.

**Tech Stack:** Python 3 / Flask (blueprint `flask_federation_routes.py`, pytest), React 19 / Next.js 15 / TypeScript / SWR.

**Spec:** `docs/superpowers/specs/2026-06-14-federation-aggregator-design.md`

**Prerequisites for running tests/build:**
- Python tests need `flask` + `pytest>=8.0` importable. Run from `AppImage/scripts/`:
  `python3 -m pytest tests/test_federation_routes.py -v` (the `tests/conftest.py` puts `scripts/` on `sys.path`). If deps are missing locally, run on a node or in a venv: `pip install flask pytest`.
- Frontend typecheck/build: `cd AppImage && npm run build`.
- AppImage rebuild: `AppImage/scripts/build_appimage.sh`.

---

## Task 1: Backend — `_fetch_local` accepts optional `params`

The aggregator forwards extra query params to each node. `_fetch_local` (self path, in-process) must forward them to its `test_client` call. Today it ignores params.

**Files:**
- Modify: `AppImage/scripts/flask_federation_routes.py:42-59` (`_fetch_local`)
- Test: `AppImage/scripts/tests/test_federation_routes.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `AppImage/scripts/tests/test_federation_routes.py`:

```python
def test_fetch_local_forwards_params():
    from flask import Flask, request, jsonify
    app = Flask(__name__)

    @app.route("/echo")
    def echo():
        return jsonify({"limit": request.args.get("limit")})

    with app.app_context():
        out = fed._fetch_local("/echo", None, params={"limit": "5"})
    assert out["online"] is True
    assert out["data"] == {"limit": "5"}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd AppImage/scripts && python3 -m pytest tests/test_federation_routes.py::test_fetch_local_forwards_params -v`
Expected: FAIL — `TypeError: _fetch_local() got an unexpected keyword argument 'params'`.

- [ ] **Step 3: Add the `params` parameter**

In `AppImage/scripts/flask_federation_routes.py`, change the `_fetch_local` signature and its `client.get` call:

```python
def _fetch_local(path, incoming_auth, params=None):
    """Invoke one of THIS server's own routes in-process (no socket).

    Reuses the browser's Authorization header (valid for the central node)
    so `require_auth` passes. Returns the same shape as peer_client.fetch_json.
    """
    client = current_app.test_client()
    headers = {}
    if incoming_auth:
        headers["Authorization"] = incoming_auth
    resp = client.get(path, query_string=params, headers=headers)
    data = None
    try:
        data = resp.get_json()
    except Exception:
        data = None
    return {"online": True, "status": resp.status_code, "data": data,
            "error": None if resp.status_code < 400 else "HTTP {}".format(resp.status_code)}
```

(The two existing callers at lines 172 and 227 pass only two args — unaffected because `params` defaults to `None`, and `query_string=None` is a no-op.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd AppImage/scripts && python3 -m pytest tests/test_federation_routes.py::test_fetch_local_forwards_params -v`
Expected: PASS.

- [ ] **Step 5: Run the full federation suite (no regressions)**

Run: `cd AppImage/scripts && python3 -m pytest tests/test_federation_routes.py -q`
Expected: all PASS (existing tests + the new one).

- [ ] **Step 6: Commit**

```bash
git add AppImage/scripts/flask_federation_routes.py AppImage/scripts/tests/test_federation_routes.py
git commit -m "feat(federation): _fetch_local forwards optional query params"
```

---

## Task 2: Backend — `/api/federation/aggregate` endpoint

Generic fan-out: validate `path`, forward extra query params, fetch self + enabled peers in parallel, return per-node results. Mirrors the existing `federation_vms` aggregator.

**Files:**
- Modify: `AppImage/scripts/flask_federation_routes.py` (add the route; suggested location: right after `federation_vms`, before the `# ── Reverse proxy ──` section at line 246)
- Modify: `AppImage/scripts/flask_federation_routes.py:9-18` (add the route to the module docstring's route list)
- Test: `AppImage/scripts/tests/test_federation_routes.py` (append)

- [ ] **Step 1: Write the failing tests**

Append to `AppImage/scripts/tests/test_federation_routes.py`. Note the mocked `_fetch_local` lambdas take `params=None` (the aggregator calls it with `params=`):

```python
def test_aggregate_merges_self_and_peer(client, monkeypatch):
    monkeypatch.setattr(
        fed.federation_config, "load_peers",
        lambda: [{"name": "pve2", "host": "h", "port": 8008,
                  "token": "t", "enabled": True}])
    monkeypatch.setattr(
        fed, "_fetch_local",
        lambda path, auth, params=None: {"online": True, "status": 200,
                                         "data": {"who": "self"}, "error": None})
    monkeypatch.setattr(
        fed.peer_client, "fetch_json",
        lambda peer, path, **kw: {"online": True, "status": 200,
                                  "data": {"who": "peer"}, "error": None})
    body = client.get("/api/federation/aggregate?path=/api/network").get_json()
    assert body["path"] == "/api/network"
    nodes = body["nodes"]
    assert len(nodes) == 2
    assert nodes[0] == {"node": "pve1", "is_self": True, "online": True,
                        "status": 200, "error": None, "data": {"who": "self"}}
    assert nodes[1]["node"] == "pve2"
    assert nodes[1]["data"] == {"who": "peer"}


def test_aggregate_self_only_when_no_peers(client, monkeypatch):
    monkeypatch.setattr(fed.federation_config, "load_peers", lambda: [])
    monkeypatch.setattr(
        fed, "_fetch_local",
        lambda path, auth, params=None: {"online": True, "status": 200,
                                         "data": {"x": 1}, "error": None})
    nodes = client.get("/api/federation/aggregate?path=/api/network").get_json()["nodes"]
    assert len(nodes) == 1
    assert nodes[0]["is_self"] is True


def test_aggregate_marks_offline_peer(client, monkeypatch):
    monkeypatch.setattr(
        fed.federation_config, "load_peers",
        lambda: [{"name": "pve2", "host": "h", "port": 8008,
                  "token": "t", "enabled": True}])
    monkeypatch.setattr(
        fed, "_fetch_local",
        lambda path, auth, params=None: {"online": True, "status": 200,
                                         "data": {}, "error": None})
    monkeypatch.setattr(
        fed.peer_client, "fetch_json",
        lambda peer, path, **kw: {"online": False, "status": None,
                                  "data": None, "error": "timeout"})
    r = client.get("/api/federation/aggregate?path=/api/network")
    assert r.status_code == 200
    nodes = r.get_json()["nodes"]
    assert nodes[1]["online"] is False
    assert nodes[1]["data"] is None
    assert nodes[1]["error"] == "timeout"


def test_aggregate_excludes_disabled_peer(client, monkeypatch):
    monkeypatch.setattr(
        fed.federation_config, "load_peers",
        lambda: [{"name": "pve2", "host": "h", "port": 8008,
                  "token": "t", "enabled": False}])
    monkeypatch.setattr(
        fed, "_fetch_local",
        lambda path, auth, params=None: {"online": True, "status": 200,
                                         "data": {}, "error": None})
    nodes = client.get("/api/federation/aggregate?path=/api/network").get_json()["nodes"]
    assert [n["node"] for n in nodes] == ["pve1"]


def test_aggregate_requires_path(client):
    assert client.get("/api/federation/aggregate").status_code == 400


def test_aggregate_blocks_non_proxyable(client):
    assert client.get("/api/federation/aggregate?path=/api/auth/login").status_code == 403


def test_aggregate_blocks_traversal(client):
    assert client.get("/api/federation/aggregate?path=/api/x/../auth/login").status_code == 400


def test_aggregate_forwards_query_params(client, monkeypatch):
    captured = {}
    monkeypatch.setattr(fed.federation_config, "load_peers", lambda: [])

    def fake_local(path, auth, params=None):
        captured["params"] = params
        return {"online": True, "status": 200, "data": {}, "error": None}

    monkeypatch.setattr(fed, "_fetch_local", fake_local)
    client.get("/api/federation/aggregate?path=/api/logs&limit=100&level=warn")
    assert captured["params"] == {"limit": "100", "level": "warn"}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd AppImage/scripts && python3 -m pytest tests/test_federation_routes.py -k aggregate -v`
Expected: FAIL — the endpoint does not exist yet, so requests 404 (assertions on body/status fail).

- [ ] **Step 3: Implement the endpoint**

In `AppImage/scripts/flask_federation_routes.py`, add right after the `federation_vms` function (after line 243, before the `# ── Reverse proxy ──` comment):

```python
@federation_bp.route("/api/federation/aggregate", methods=["GET"])
@require_auth
def aggregate():
    """Generic fan-out: forward `path` to every node, return per-node results.

    {path, nodes:[{node,is_self,online,status,error,data}]}. A "dumb pipe" — it
    does not know the response shape; the frontend flattens per view. Reuses the
    proxy path allowlist so /api/auth, /api/federation and /api/proxy can't be
    fanned out. Extra query params (besides `path`) are forwarded to each node.
    """
    raw = request.args.get("path", "").strip()
    if not raw:
        return jsonify({"error": "path parameter required"}), 400
    target_path, err = _normalize_proxy_path(raw.lstrip("/"))
    if err == "invalid path":
        return jsonify({"error": err}), 400
    if err:
        return jsonify({"error": err}), 403

    incoming_auth = request.headers.get("Authorization")
    extra = {k: v for k, v in request.args.items() if k != "path"} or None

    def collect(name, is_self, peer=None):
        if is_self:
            r = _fetch_local(target_path, incoming_auth, params=extra)
        else:
            r = peer_client.fetch_json(peer, target_path, params=extra)
        return {"node": name, "is_self": is_self, "online": r["online"],
                "status": r["status"], "error": r["error"], "data": r["data"]}

    nodes = [collect(_self_node_name(), True)]
    peers = [p for p in federation_config.load_peers() if p["enabled"]]
    if peers:
        with ThreadPoolExecutor(max_workers=min(8, len(peers))) as ex:
            nodes.extend(ex.map(lambda p: collect(p["name"], False, p), peers))
    return jsonify({"path": target_path, "nodes": nodes})
```

Then add this line to the route list in the module docstring (after line 16, the `/vms` line):

```
  GET    /api/federation/aggregate     fan-out any GET path to all nodes
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd AppImage/scripts && python3 -m pytest tests/test_federation_routes.py -k aggregate -v`
Expected: all 8 aggregate tests PASS.

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `cd AppImage/scripts && python3 -m pytest tests/ -q`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add AppImage/scripts/flask_federation_routes.py AppImage/scripts/tests/test_federation_routes.py
git commit -m "feat(federation): generic /api/federation/aggregate fan-out endpoint"
```

---

## Task 3: Frontend — `aggregateUrl` helper + `AggregateResponse` type

Shared helper so any view can call the aggregator. Lives next to `fetchAtNode` in the API layer.

**Files:**
- Modify: `AppImage/lib/api-config.ts` (add type + helper; place after the `fetchAtNode` export, ~line 152)

- [ ] **Step 1: Add the type and helper**

Append to `AppImage/lib/api-config.ts`:

```ts
/**
 * Shape returned by GET /api/federation/aggregate — one entry per cluster node.
 * `data` is the target endpoint's response for that node, verbatim (null if the
 * node was offline). The aggregator is a dumb pipe; callers flatten per view.
 */
export interface AggregateNode<T> {
  node: string
  is_self: boolean
  online: boolean
  status: number | null
  error: string | null
  data: T | null
}

export interface AggregateResponse<T> {
  path: string
  nodes: AggregateNode<T>[]
}

/**
 * Build the central-node aggregator URL for a given API path. The result starts
 * with /api/federation, so fetchApi() never proxies it to the active node — it
 * always hits the central node, which fans out to every peer.
 */
export function aggregateUrl(path: string): string {
  return `/api/federation/aggregate?path=${encodeURIComponent(path)}`
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `cd AppImage && npm run build`
Expected: build succeeds (no TypeScript errors).

- [ ] **Step 3: Commit**

```bash
git add AppImage/lib/api-config.ts
git commit -m "feat(federation): aggregateUrl helper + AggregateResponse type"
```

---

## Task 4: Frontend — Network interface tables: all-nodes merge + Node badge + local filter

Convert the interface lists from single-node to all-nodes. The three interface sections (physical/bridge/vm_lxc) iterate merged, node-tagged, filtered arrays. Mirrors the VMs precedent (`virtual-machines.tsx`).

**Files:**
- Modify: `AppImage/components/network-metrics.tsx`
  - line 7 (lucide import — add `Server`)
  - lines 46-78 (`NetworkInterface` interface — add node tags)
  - lines 134-148 (SWR fetch → aggregator)
  - lines ~250-260 (derive merged arrays) and the three `.map` sections (538, 624, 740)

- [ ] **Step 1: Tag the interface type and import `Server`**

In `AppImage/components/network-metrics.tsx` line 7, add `Server` to the lucide import:

```ts
import { Wifi, Activity, Network, Router, AlertCircle, Zap, Timer, Server } from 'lucide-react'
```

In the `NetworkInterface` interface (ends at line 78), add two fields before the closing brace:

```ts
  _node?: string
  _node_is_self?: boolean
```

- [ ] **Step 2: Fetch via the aggregator and merge across nodes**

Update the imports near line 11 to pull the aggregator helpers and `fetchAtNode`:

```ts
import { fetchApi, fetchAtNode, aggregateUrl, type AggregateResponse } from "../lib/api-config"
```

Replace the main SWR call (lines 140-148) so it fetches the aggregated response:

```ts
  const {
    data: agg,
    error,
    isLoading,
  } = useSWR<AggregateResponse<NetworkData>>(
    aggregateUrl("/api/network"),
    (url: string) => fetchApi<AggregateResponse<NetworkData>>(url),
    {
      refreshInterval: 15000,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
    },
  )
```

Add the node filter state next to the other `useState` hooks (near line 150):

```ts
  const [nodeFilter, setNodeFilter] = useState<string | null>(null)
```

After the loading/error guards (after line ~205, once we know `agg` is present), derive node lists and merged, tagged, filtered interface arrays. The single-node `networkData` used throughout the rest of the component is reconstructed from the FIRST online node so the existing per-node summary keeps rendering (Task 5 makes it per-node):

```ts
  const aggNodes = agg?.nodes ?? []
  const onlineNodes = aggNodes.filter((n) => n.online && n.data)
  const offlineNodes = aggNodes.filter((n) => !n.online)
  const nodeNames = aggNodes.map((n) => n.node)

  // Tag every interface with its origin node so cards show a Node badge and
  // drill-down can route to the right node (see Task 6).
  const tag = (
    list: NetworkInterface[] | undefined,
    n: AggregateNode<NetworkData>,
  ): NetworkInterface[] =>
    (list ?? []).map((i) => ({ ...i, _node: n.node, _node_is_self: n.is_self }))

  const applyNodeFilter = (xs: NetworkInterface[]) =>
    nodeFilter ? xs.filter((i) => i._node === nodeFilter) : xs

  const mergedPhysical = applyNodeFilter(
    onlineNodes.flatMap((n) => tag(n.data!.physical_interfaces, n)),
  )
  const mergedBridge = applyNodeFilter(
    onlineNodes.flatMap((n) => tag(n.data!.bridge_interfaces, n)),
  )
  const mergedVmLxc = applyNodeFilter(
    onlineNodes.flatMap((n) => tag(n.data!.vm_lxc_interfaces, n)),
  )
```

`AggregateNode` is already imported via the `import { … } from "../lib/api-config"` line — add it there:

```ts
import { fetchApi, fetchAtNode, aggregateUrl, type AggregateResponse, type AggregateNode } from "../lib/api-config"
```

- [ ] **Step 3: Point the three interface sections at the merged arrays**

In the three render sections, replace the source array each `.map` iterates:
- line 538 `networkData.physical_interfaces.map(...)` → `mergedPhysical.map(...)`
- line 624 `networkData.bridge_interfaces.map(...)` → `mergedBridge.map(...)`
- line 740 `vmLxcInterfaces.map(...)` → `mergedVmLxc.map(...)` (and delete the now-unused `vmLxcInterfaces` sort at line 260, or re-sort `mergedVmLxc` instead)

Guard each section's "exists and non-empty" condition (e.g. line 611) on the merged array: `mergedBridge.length > 0`, `mergedVmLxc.length > 0`.

Give each card a node-stable React key (interface names can repeat across nodes): change `key={index}` (or `key={interface_.name}`) to `key={`${interface_._node}:${interface_.name}`}` in all three sections.

- [ ] **Step 4: Add the Node badge to each interface card**

Inside each interface card (the three sections), next to the existing type badge, add the node badge — mirrors `virtual-machines.tsx:1548-1550`:

```tsx
{interface_._node && nodeNames.length > 1 && (
  <Badge variant="outline" className="flex-shrink-0 bg-muted/60 text-muted-foreground border-border">
    <Server className="h-3 w-3 mr-1" />{interface_._node}
  </Badge>
)}
```

- [ ] **Step 5: Add the local filter chips**

Near the top of the returned layout (around the header, after line 319), add the filter — mirrors `virtual-machines.tsx:1502-1518`:

```tsx
{nodeNames.length > 1 && (
  <div className="flex items-center gap-1.5 mb-3">
    <button
      onClick={() => setNodeFilter(null)}
      className={`text-xs px-2 py-0.5 rounded-full border ${nodeFilter === null ? "bg-blue-500/15 text-blue-400 border-blue-500/30" : "border-border text-muted-foreground"}`}
    >All</button>
    {nodeNames.map((n) => (
      <button
        key={n}
        onClick={() => setNodeFilter(n)}
        className={`text-xs px-2 py-0.5 rounded-full border ${nodeFilter === n ? "bg-blue-500/15 text-blue-400 border-blue-500/30" : "border-border text-muted-foreground"}`}
      >{n}</button>
    ))}
  </div>
)}
```

- [ ] **Step 6: Show offline nodes (don't swallow them)**

Below the filter chips, render a small banner per offline node:

```tsx
{offlineNodes.map((n) => (
  <div key={n.node} className="flex items-center gap-2 text-xs text-muted-foreground border border-border rounded-md px-2 py-1 mb-1">
    <AlertCircle className="h-3 w-3 text-yellow-500" />
    {n.node} — offline{n.error ? ` (${n.error})` : ""}
  </div>
))}
```

- [ ] **Step 7: Replace remaining single-node references so it compiles**

The rest of the component still references `networkData` (counts, summary). Add, right after Step 2's derivations, a compatibility binding to the first online node so existing summary JSX keeps compiling (Task 5 replaces it with a per-node loop):

```ts
  const networkData = onlineNodes[0]?.data
  if (!networkData) {
    return (
      <div className="text-sm text-muted-foreground p-6">No network data available.</div>
    )
  }
```

(Delete the old `const networkData = …`/early-returns that read from the pre-aggregator SWR `data` — there must be exactly one `networkData` binding.)

- [ ] **Step 8: Verify it typechecks/builds**

Run: `cd AppImage && npm run build`
Expected: build succeeds. Fix any type errors (most likely: leftover `networkData` early-return referencing the old SWR `data`, or a missed `.map` source).

- [ ] **Step 9: Commit**

```bash
git add AppImage/components/network-metrics.tsx
git commit -m "feat(network): all-nodes interface tables with Node badge + local filter"
```

---

## Task 5: Frontend — per-node summary (traffic / counts / latency) routed via `fetchAtNode`

> **IMPLEMENTED DIFFERENTLY (see spec).** Rendering the summary once *per node* inside a
> `map` would call `useSWR` in a loop — a Rules-of-Hooks violation — and require extracting
> a heavily-entangled child component. Instead the summary **follows the node filter**: a
> single summary reflecting the filtered node (or the central/first node under "All"),
> labeled when multi-node, with its latency/metrics routed via one `useSWR` whose target is
> the `summaryNode` (a legal single dynamic hook). Done together with Task 6 in commit
> `3216022b` (+ fix `8bd7b72b`). The steps below are kept for historical context.

The node-global widgets (traffic totals, interface counts, latency sparkline, historical `/api/node/metrics`) are per-machine, not mergeable. Render the summary block once per online node, each routed to its own node.

**Files:**
- Modify: `AppImage/components/network-metrics.tsx` (the summary section: counts at ~386, the overall `NetworkTrafficChart` at 521, the latency sparkline SWR at 160-167)

- [ ] **Step 1: Make the latency sparkline per-node**

The latency SWR at lines 160-167 fetches one node's gateway latency. Replace the single top-level summary block (counts + overall traffic chart + latency sparkline) with a `onlineNodes.map((n) => …)` that renders one summary card per node. Inside the map, read that node's data from `n.data` (not the compat `networkData`), and route its latency/historical reads to that node:

```tsx
{onlineNodes.map((n) => (
  <div key={n.node} className="rounded-lg border border-border p-4">
    {nodeNames.length > 1 && (
      <div className="flex items-center gap-1.5 mb-2 text-sm font-medium">
        <Server className="h-4 w-4 text-muted-foreground" />{n.node}
      </div>
    )}
    {/* existing summary internals, with networkData -> n.data: counts,
        traffic totals, and the per-node overall traffic chart */}
    <NetworkTrafficChart
      timeframe={timeframe}
      onTotalsCalculated={setNetworkTotals}
      networkUnit={networkUnit}
      node={n.node}
      isSelf={n.is_self}
    />
  </div>
))}
```

(`node`/`isSelf` props are added to `NetworkTrafficChart` in Task 6. The overall chart has no `interfaceName`, so it fetches `/api/node/metrics` for that node.)

- [ ] **Step 2: Route the latency sparkline + LatencyDetailModal per node**

The standalone latency sparkline (SWR at 160-167) and the `LatencyDetailModal` at 1213 are per-node. Move the sparkline fetch inside the per-node summary card and fetch with `fetchAtNode`:

```ts
const latency = await fetchAtNode<{
  data: Array<{ timestamp: number; value: number }>
  stats: { min: number; max: number; avg: number; current: number }
  target: string
}>(n.node, n.is_self, "/api/network/latency/history?target=gateway&timeframe=hour")
```

Pass `node={n.node}` / `isSelf={n.is_self}` to `<LatencyDetailModal>` (props added in Task 6) so its detail/realtime fetches route to the same node.

- [ ] **Step 3: Verify it builds**

Run: `cd AppImage && npm run build`
Expected: build succeeds (after Task 6 the chart/modal props exist; if building Task 5 before Task 6, temporarily expect the `node`/`isSelf` prop type errors and complete Task 6 before committing — or do Tasks 5 and 6 together).

- [ ] **Step 4: Commit**

```bash
git add AppImage/components/network-metrics.tsx
git commit -m "feat(network): per-node summary cards routed to their own node"
```

---

## Task 6: Frontend — node-route the interface drill-down (`NetworkTrafficChart`, `LatencyDetailModal`)

Per-interface and latency drill-down currently call `fetchApi` (central / active node). Add `node`/`isSelf` props and route via `fetchAtNode` so a remote interface's chart queries the right node. `network-card.tsx` is unused (no `<NetworkCard>` anywhere) — leave it as-is.

**Files:**
- Modify: `AppImage/components/network-traffic-chart.tsx:16-23` (props), `:46-51` (destructure), `:114` (fetch)
- Modify: `AppImage/components/latency-detail-modal.tsx:57-…` (props), `:754` and `:770` (fetches)
- Modify: `AppImage/components/network-metrics.tsx` — the modal's `<NetworkTrafficChart>` at line 1036 (pass `selectedInterface` node tags)

- [ ] **Step 1: Add `node`/`isSelf` props to `NetworkTrafficChart`**

In `AppImage/components/network-traffic-chart.tsx`, add to `NetworkTrafficChartProps` (interface at line 16):

```ts
  node?: string
  isSelf?: boolean
```

Destructure them in the function signature (line 46-51):

```ts
export function NetworkTrafficChart({
  timeframe,
  interfaceName,
  onTotalsCalculated,
  refreshInterval = 60000,
  networkUnit: networkUnitProp,
  node,
  isSelf,
}: NetworkTrafficChartProps) {
```

Update the import at line 6:

```ts
import { fetchApi, fetchAtNode } from "../lib/api-config"
```

Change the fetch at line 114 to route to the node:

```ts
      const result = await fetchAtNode<any>(node, isSelf, apiPath)
```

(With `node` undefined — single-node installs — `fetchAtNode` resolves to a plain local call, identical to today.)

- [ ] **Step 2: Add `node`/`isSelf` props to `LatencyDetailModal`**

In `AppImage/components/latency-detail-modal.tsx`, add `node?: string; isSelf?: boolean` to `LatencyDetailModalProps` (line 57), destructure them in the component, update the import to include `fetchAtNode`, and change the two fetches:
- line 754 (history): `await fetchAtNode<{ data: LatencyHistoryPoint[]; stats: LatencyStats; target: string }>(node, isSelf, <same path>)`
- line 770 (current): `await fetchAtNode<RealtimeResult>(node, isSelf, `/api/network/latency/current?target=${target}`)`

- [ ] **Step 3: Pass the interface's node into the modal chart**

In `AppImage/components/network-metrics.tsx`, the modal's traffic chart at line 1036 must route to the selected interface's node. `displayInterface` is derived from `selectedInterface` (already node-tagged in Task 4). Add the props:

```tsx
<NetworkTrafficChart
  timeframe={modalTimeframe}
  interfaceName={displayInterface.name}
  onTotalsCalculated={setInterfaceTotals}
  refreshInterval={60000}
  networkUnit={networkUnit}
  node={displayInterface._node}
  isSelf={displayInterface._node_is_self}
/>
```

- [ ] **Step 4: Verify it builds**

Run: `cd AppImage && npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add AppImage/components/network-traffic-chart.tsx AppImage/components/latency-detail-modal.tsx AppImage/components/network-metrics.tsx
git commit -m "feat(network): node-route interface + latency drill-down via fetchAtNode"
```

---

## Task 7: Build the AppImage and verify on the cluster

No automated UI tests exist; this task is the real acceptance gate (spec §6 "Manual").

**Files:** none (build + manual verification).

- [ ] **Step 1: Rebuild the AppImage**

Run: `AppImage/scripts/build_appimage.sh`
Expected: a fresh `AppImage/ProxMenux-*.AppImage` is produced without errors.

- [ ] **Step 2: Install/run on both nodes**

Install the new build on both Proxmox nodes (the central + at least one peer) and open the Monitor dashboard on the central node.

- [ ] **Step 3: Verify the all-nodes Network view (two nodes)**

Confirm:
- The Network tab lists interfaces from BOTH nodes, each card showing a Node badge.
- The filter chips (All · nodeA · nodeB) appear and narrow the list correctly.
- There is one summary card per node, each showing that node's traffic/counts/latency.
- Clicking a REMOTE interface opens the modal and its traffic chart loads (data comes from the remote node, not the central one).
- Stopping/disabling one peer shows it as an inline "offline" banner; the rest of the table still renders.

- [ ] **Step 4: Verify single-node parity**

On a node with no peers configured, confirm the Network tab looks identical to before: no Node badge, no filter chips, a single summary card, drill-down works.

- [ ] **Step 5: Commit the build artifact (matches existing repo convention)**

```bash
git add AppImage/ProxMenux-*.AppImage
git commit -m "build: refresh Monitor AppImage with federation Network aggregator [skip ci]"
```

---

## Notes for the executor

- The aggregator (Tasks 1-2) is view-agnostic and is the reusable base for every later phase (Storage, Logs, Health, Hardware, Overview). Do not special-case Network in the backend.
- Do NOT touch the global header node selector (`node-selector.tsx`, `getActiveNode`/`setActiveNode`) — its conversion to a reactive filter is a deferred final phase.
- `fetchAtNode(node, isSelf, path)` with `node` undefined behaves exactly like a local `fetchApi` call, which is why single-node installs are unaffected.
- Tasks 5 and 6 are coupled (Task 5 passes props that Task 6 adds). If executing inline, do them back-to-back and run `npm run build` once at the end of Task 6.
