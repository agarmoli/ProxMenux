# Federation Overview Landing (cluster-first) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the dashboard LAND on the all-nodes overview (per-node cards) by default when there are peers, while preserving the rich single-node SystemOverview as the per-node deep-dive (reached by clicking a node card) and as the single-node landing. Enrich the per-node cards with uptime.

**Architecture:** Pure frontend, no backend, almost pure wiring. `ClusterOverview` (cluster-overview.tsx) already renders per-node cards from the already-aggregated `/api/federation/overview` (whose payload already contains the full `/api/system` per node — including uptime). `SystemOverview` is the detailed single-node landing. This phase: (1) the dashboard defaults the landing TAB to `cluster` when there is >1 node AND no specific node is active; the existing drill-in (`openNode` → `setActiveNode` + reload) then naturally lands on `overview` (the active node's detail) because the default-tab logic keys off `getActiveNode()`. (2) Cluster cards gain an uptime line. The global selector / reload model is NOT changed here (that is Fase 7).

**Why this keys off `getActiveNode()`:**
- `getActiveNode() === null` (landing mode, no node drilled into) + multi-node → land on `cluster` cards.
- `getActiveNode() !== null` (drilled into a node via a card click) → land on `overview` (that node's detail).
- single node → stays `overview` (rich detail), unchanged.
This makes the existing `openNode` (setActiveNode + reload) "just work": click node B → active=B → reload → lands on overview/B; click self → active=null → reload → lands on cluster.

**Tech Stack:** React 19 / TS. `cluster-overview.tsx` (130 lines), `proxmox-dashboard.tsx` (910 lines).

**Spec note:** No separate spec (6th application; mostly wiring). Design here.

**Gates (next.config ignoreBuildErrors:true → use BOTH):**
- `cd /home/adrian/code/ProxMenux/AppImage && npm run build` must COMPLETE.
- Scoped types: BEFORE editing, capture baseline error counts: `npx tsc --noEmit 2>&1 | grep -c "cluster-overview"` and `... | grep -c "proxmox-dashboard"`. Your commits must NOT exceed those baselines (no NEW error signatures). Do not fix pre-existing.
- READ the files around cited lines.

**Shared (Fase 1, `lib/api-config.ts`):** `fetchApi`, `getActiveNode()` (sync, reads localStorage; null = central/landing). Both are already imported in `proxmox-dashboard.tsx` — verify.

---

## Task 1: Cluster-first default landing tab + uptime on cluster cards

**Files:**
- `AppImage/components/cluster-overview.tsx` — `NodeSummary` (~8-24), the per-node card render (~59-129)
- `AppImage/components/proxmox-dashboard.tsx` — initial `activeTab` (~112), a new mount effect

- [ ] **Step 1: Add uptime to `NodeSummary` + render it.** In `cluster-overview.tsx`, the `NodeSummary.system` shape (~13-18) currently has `cpu_usage`/`memory_usage`/`temperature`. Add `uptime?: string` to it:
```ts
  system: {
    cpu_usage?: number
    memory_usage?: number
    temperature?: number | { cpu?: number } | null
    uptime?: string
  } | null
```
(The backend already returns `uptime` inside each node's `system` payload — this just unpacks it.) Then in the per-node card render (find where CPU/Memory/Temp/VM metrics are shown, ~70-120), add an uptime line for online nodes, e.g. under the metrics grid:
```tsx
{n.online && n.system?.uptime && (
  <div className="text-xs text-muted-foreground mt-2">Uptime: {n.system.uptime}</div>
)}
```
(Match the card's existing styling/structure — read the card first.)

- [ ] **Step 2: Default the landing tab to `cluster` when multi-node + landing mode.** In `proxmox-dashboard.tsx`, the initial tab is `const [activeTab, setActiveTab] = useState("overview")` (~112). Leave that initial value as-is. Add a mount effect (near the other mount effects) that switches the default to `cluster` only when appropriate:
```ts
  // Cluster-first landing: when there are peers AND the user hasn't drilled into a
  // specific node (no active node) and hasn't changed tabs yet, land on the all-nodes
  // Cluster cards instead of the single-node Overview. (getActiveNode() != null means
  // a node was drilled into via a Cluster card → keep Overview/detail.)
  useEffect(() => {
    if (getActiveNode() !== null) return
    let cancelled = false
    fetchApi<{ nodes?: unknown[] }>("/api/federation/nodes")
      .then((d) => {
        if (cancelled) return
        if ((d?.nodes?.length ?? 0) > 1) {
          setActiveTab((prev) => (prev === "overview" ? "cluster" : prev))
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])
```
(`getActiveNode` + `fetchApi` are imported from `@/lib/api-config` — confirm they're in the import; add if missing. The `prev === "overview"` guard ensures this only overrides the INITIAL default, never a tab the user clicked.)

- [ ] **Step 3: Build + scoped tsc.** `npm run build` COMPLETE; `npx tsc --noEmit 2>&1 | grep -c "cluster-overview"` and `... | grep -c "proxmox-dashboard"` must not exceed the baselines you captured. Fix any NEW breakage.

- [ ] **Step 4: Commit.**
```bash
git add AppImage/components/cluster-overview.tsx AppImage/components/proxmox-dashboard.tsx
git commit -m "feat(overview): cluster-first default landing (all-nodes cards) + uptime on node cards"
```

---

## Task 2: Build the AppImage and verify on the cluster

**Files:** none (build + manual).

- [ ] **Step 1:** On a Proxmox node: `AppImage/scripts/build_appimage.sh`.
- [ ] **Step 2:** Install on both nodes; open the dashboard on the central node (with no node previously selected).
- [ ] **Step 3:** Verify (2 nodes): the dashboard LANDS on the Cluster cards (all nodes' CPU/RAM/temp/uptime/VM/health at a glance), not the single-node Overview. Clicking a node card drills into that node's detailed Overview. Returning (self card) goes back to the cluster cards. The Overview tab still shows the detailed single-node view.
- [ ] **Step 4:** Single-node parity: a node with no peers LANDS on the rich Overview (SystemOverview) exactly as before — no behavior change.
- [ ] **Step 5: Commit the build artifact.**
```bash
git add AppImage/ProxMenux-*.AppImage
git commit -m "build: refresh Monitor AppImage with cluster-first Overview landing [skip ci]"
```

---

## Notes for the executor
- No backend changes. `/api/federation/overview` already returns the full per-node `/api/system` payload (uptime included).
- Do NOT change the reload / global-selector model or the `openNode` (setActiveNode + reload) behavior — that is the final Fase 7. This phase only changes the DEFAULT landing tab and adds uptime.
- Single-node: the effect fetches `/api/federation/nodes`, sees length 1, does nothing → stays on the rich Overview. No regression.
- Keep the existing `cluster` tab in the nav — it is now also the default landing for multi-node.
