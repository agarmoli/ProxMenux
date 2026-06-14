# Federation Health All-Nodes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the cluster's health visible across all nodes — the header health indicator shows the WORST status across the cluster (+ summed info count), and the Health modal gains a node picker (defaulting to the worst-status node) so every node's checks are reachable, with acknowledge routed to the selected node.

**Architecture:** Pure frontend, reuses the Fase 1 aggregator (no backend). Health data is a fixed per-node category TREE (`/api/health/full` → `{health:{overall,details:{cpu,memory,...}}, dismissed, custom_suppressions}`), which is dense per-node and does not flatten into a Node-column list like disks/logs do. So the chosen model is a **node picker inside the modal** (lowest-risk: the existing single-node render + optimistic-dismiss logic are preserved, only their SOURCE changes to the selected node) plus a **cluster-aggregated header indicator** (worst overall status + summed info). Acknowledge POSTs route to the selected node via `getLocalApiUrl(nodeEndpoint(node,isSelf,...))`.

**Design decisions (decided directly, no brainstorm):**
- Modal = node picker (chips), default = worst-status node; NOT per-node stacked sections (too invasive for the 906-line modal's intertwined logic).
- Header indicator = worst overall status across nodes + SUMMED info count.
- `healthData`/`dismissedItems`/`customSuppressions` stay as STATE (sourced from the selected node) so the optimistic-dismiss update keeps working.
- Single-node parity: 1 node → no picker, identical to today.
- Backend: none. Acknowledge routes per-node (no schema change).

**Tech Stack:** React 19 / TS. The modal uses raw `fetch(getApiUrl(...))` (receives `getApiUrl` as a prop); the header uses `fetchApi`.

**Spec note:** No separate spec (4th application of the pattern); design lives here.

**Gates (next.config ignoreBuildErrors:true → use BOTH):**
- `cd /home/adrian/code/ProxMenux/AppImage && npm run build` must COMPLETE.
- Scoped types: `npx tsc --noEmit 2>&1 | grep -c "health-status-modal"` ≤ **1** (baseline); `... | grep -c "proxmox-dashboard"` ≤ **8** (baseline). No new errors.
- READ the files around cited lines — they're anchors.

**Shared (Fase 1, `lib/api-config.ts`):** `aggregateUrl(path)`, `getLocalApiUrl`, `nodeEndpoint(node,isSelf,endpoint)`, `fetchApi`, types `AggregateResponse<T>`/`AggregateNode<T>`. `getApiUrl(aggregateUrl(...))` does NOT proxy (it starts with `/api/federation`, a local prefix) → always hits central.

---

## Task 1: Modal — node picker, source from selected node, route acknowledge, aggregate event

**File:** `AppImage/components/health-status-modal.tsx`
- props/state (~98-124), `fetchHealthDetails` (~126-207), `getHealthStats` (~320-342), `handleAcknowledge` (~373-436), render (~575-852)
- The `FullHealthData` interface already exists (used at ~163: `const fullData: FullHealthData`).

- [ ] **Step 1: Imports.** Add to the `lib/api-config` import line (or add the import if absent):
```ts
import { aggregateUrl, getLocalApiUrl, nodeEndpoint, type AggregateResponse, type AggregateNode } from "@/lib/api-config"
```
(Keep the existing `getAuthToken` import.)

- [ ] **Step 2: Add node state** (near ~118-124):
```ts
  const [perNodeHealth, setPerNodeHealth] = useState<AggregateNode<FullHealthData>[]>([])
  const [selectedHealthNode, setSelectedHealthNode] = useState<string | null>(null)
```

- [ ] **Step 3: A worst-status helper** (module scope, near the top, after imports):
```ts
const STATUS_RANK: Record<string, number> = { CRITICAL: 3, WARNING: 2, UNKNOWN: 1, OK: 0 }
function worseStatus(a: string, b: string): string {
  return (STATUS_RANK[(b || "OK").toUpperCase()] ?? 0) > (STATUS_RANK[(a || "OK").toUpperCase()] ?? 0) ? b : a
}
```

- [ ] **Step 4: Rewrite `fetchHealthDetails`** (~126-207) to fetch the aggregator and source from the selected node. Replace its body's fetch+set logic with:
```ts
      const response = await fetch(getApiUrl(aggregateUrl("/api/health/full")), { headers: authHeaders })
      if (!response.ok) throw new Error("Failed to fetch health details")
      const agg: AggregateResponse<FullHealthData> = await response.json()
      const online = agg.nodes.filter((n) => n.online && n.data)
      setPerNodeHealth(online)

      // Choose the node to show: keep current selection if still online, else the
      // worst-status node, else the first (self).
      const rankOf = (n: AggregateNode<FullHealthData>) => STATUS_RANK[(n.data?.health?.overall || "OK").toUpperCase()] ?? 0
      const worstNode = online.reduce<AggregateNode<FullHealthData> | null>(
        (worst, n) => (!worst || rankOf(n) > rankOf(worst) ? n : worst),
        null,
      )
      const chosen =
        online.find((n) => n.node === selectedHealthNode) || worstNode || online[0] || null
      setSelectedHealthNode(chosen?.node ?? null)
      setHealthData(chosen?.data?.health ?? null)
      setDismissedItems(chosen?.data?.dismissed ?? [])
      setCustomSuppressions(chosen?.data?.custom_suppressions ?? [])

      // Header event: WORST overall + SUMMED info across the whole cluster.
      let clusterStatus = "OK"
      let clusterInfo = 0
      for (const n of online) {
        clusterStatus = worseStatus(clusterStatus, n.data?.health?.overall || "OK")
        const cats = n.data?.health?.details
        const dismissedCats = new Set(
          (n.data?.dismissed || [])
            .map((d) => CATEGORIES.find((c) => c.category === d.category || c.key === d.category)?.key)
            .filter(Boolean) as string[],
        )
        if (cats) {
          CATEGORIES.forEach(({ key }) => {
            const st = (cats as Record<string, { status?: string }>)[key]?.status?.toUpperCase()
            if (st === "INFO" || (st === "OK" && dismissedCats.has(key))) clusterInfo++
          })
        }
      }
      window.dispatchEvent(new CustomEvent("healthStatusUpdated", { detail: { status: clusterStatus, infoCount: clusterInfo } }))
```
Delete the old `/api/health/details` legacy fallback block and the old single-node infoCount logic — the aggregator handles per-node failures (offline nodes are just excluded). Keep the surrounding `setLoading`/`setError`/try-catch. Add `selectedHealthNode` to the `useCallback` deps (alongside `getApiUrl`).

- [ ] **Step 5: A node-picker change handler.** Add near the other handlers:
```ts
  const pickHealthNode = (nodeName: string) => {
    const n = perNodeHealth.find((x) => x.node === nodeName)
    if (!n) return
    setSelectedHealthNode(nodeName)
    setHealthData(n.data?.health ?? null)
    setDismissedItems(n.data?.dismissed ?? [])
    setCustomSuppressions(n.data?.custom_suppressions ?? [])
  }
```

- [ ] **Step 6: Route acknowledge to the selected node.** In `handleAcknowledge` (~380), replace:
```ts
      const url = getApiUrl("/api/health/acknowledge")
```
with:
```ts
      const ackNode = perNodeHealth.find((x) => x.node === selectedHealthNode)
      const url = getLocalApiUrl(nodeEndpoint(ackNode?.node, ackNode?.is_self, "/api/health/acknowledge"))
```
(Rest of the POST + optimistic `setDismissedItems` is unchanged — it updates the currently-shown node's dismissed list, which is correct.)

- [ ] **Step 7: Render the node picker** (only when >1 node). Near the top of the modal content (after the stats summary ~642, or just under the dialog header ~610), add a chip row:
```tsx
{perNodeHealth.length > 1 && (
  <div className="flex items-center gap-1.5 mb-3 flex-wrap">
    {perNodeHealth.map((n) => {
      const st = (n.data?.health?.overall || "OK").toUpperCase()
      const dot = st === "CRITICAL" ? "bg-red-500" : st === "WARNING" ? "bg-yellow-500" : "bg-green-500"
      const active = n.node === selectedHealthNode
      return (
        <button
          key={n.node}
          onClick={() => pickHealthNode(n.node)}
          className={`text-xs px-2 py-0.5 rounded-full border flex items-center gap-1 ${active ? "bg-blue-500/15 text-blue-400 border-blue-500/30" : "border-border text-muted-foreground"}`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />{n.node}{n.is_self ? " (this node)" : ""}
        </button>
      )
    })}
  </div>
)}
```
The existing stats/categories/dismissed render below is unchanged (it reads `healthData`/`dismissedItems`/`customSuppressions`, now sourced from the selected node).

- [ ] **Step 8: Build + scoped tsc.** `npm run build` COMPLETE; `npx tsc --noEmit 2>&1 | grep -c "health-status-modal"` ≤ 1. Fix any NEW breakage (e.g. a leftover reference to the removed legacy block, or `CATEGORIES`/`FullHealthData` not in scope at the helper — they are component/module scope, confirm).

- [ ] **Step 9: Commit.**
```bash
git add AppImage/components/health-status-modal.tsx
git commit -m "feat(health): node picker in modal + cluster-aggregated status event + per-node acknowledge"
```

---

## Task 2: Header indicator — aggregate worst status + summed info across nodes

**File:** `AppImage/components/proxmox-dashboard.tsx`
- `fetchHealthInfoCount` (~142-176), and the place where the header `systemStatus` is set (the `"healthStatusUpdated"` listener ~284-312, and wherever the initial status is fetched)

- [ ] **Step 1: Make `fetchHealthInfoCount` aggregate.** It currently `fetchApi("/api/health/full")` for one node and computes `infoCount`. Change it to fetch the aggregator and aggregate worst status + summed info:
```ts
  const fetchHealthInfoCount = useCallback(async () => {
    try {
      const agg = await fetchApi<AggregateResponse<{ health?: { overall?: string; details?: Record<string, { status?: string }> }; dismissed?: { category: string }[]; custom_suppressions?: { category: string }[] }>>(
        aggregateUrl("/api/health/full"),
      )
      const online = (agg?.nodes ?? []).filter((n) => n.online && n.data)
      let clusterStatus = "OK"
      let calculatedInfoCount = 0
      const rank: Record<string, number> = { CRITICAL: 3, WARNING: 2, UNKNOWN: 1, OK: 0 }
      for (const n of online) {
        const overall = (n.data?.health?.overall || "OK").toUpperCase()
        if ((rank[overall] ?? 0) > (rank[clusterStatus] ?? 0)) clusterStatus = overall
        const customCats = new Set((n.data?.custom_suppressions || []).map((cs) => cs.category))
        const categoriesWithDismissed = new Set<string>()
        ;(n.data?.dismissed || []).filter((item) => !customCats.has(item.category)).forEach((item) => {
          const catMeta = HEALTH_CATEGORY_KEYS.find((c) => c.category === item.category || c.key === item.category)
          if (catMeta) categoriesWithDismissed.add(catMeta.key)
        })
        const details = n.data?.health?.details
        if (details) {
          HEALTH_CATEGORY_KEYS.forEach(({ key }) => {
            const st = details[key]?.status?.toUpperCase()
            if (st === "INFO" || (st === "OK" && categoriesWithDismissed.has(key))) calculatedInfoCount++
          })
        }
      }
      setInfoCount(calculatedInfoCount)
      // Map cluster overall -> the header's systemStatus shape and set it.
      const mapped = clusterStatus === "CRITICAL" ? "critical" : clusterStatus === "WARNING" ? "warning" : "healthy"
      setSystemStatus((prev) => ({ ...prev, status: mapped }))
    } catch (error) {
      // Silently fail
    }
  }, [])
```
(Add `aggregateUrl` + the `AggregateResponse` type to the `lib/api-config` import in this file. `HEALTH_CATEGORY_KEYS` already exists. `setSystemStatus` is the existing header status setter — verify its shape and the field name (`status`); read the surrounding code and match it. If the header status is a plain string state, set it directly instead of the object spread.)

- [ ] **Step 2: Confirm the `"healthStatusUpdated"` listener** (~284-312) still works — the modal now dispatches `{status: clusterStatus, infoCount: clusterInfo}` (worst+summed), which the listener already consumes. No change needed unless the listener mapped the raw "OK/WARNING/CRITICAL" differently — verify it maps to healthy/warning/critical the same way Step 1 does; align if needed.

- [ ] **Step 3: Build + scoped tsc.** `npm run build` COMPLETE; `grep -c "proxmox-dashboard"` ≤ 8.

- [ ] **Step 4: Commit.**
```bash
git add AppImage/components/proxmox-dashboard.tsx
git commit -m "feat(health): header indicator shows worst cluster status + summed info"
```

---

## Task 3: Build the AppImage and verify on the cluster

**Files:** none (build + manual).

- [ ] **Step 1:** On a Proxmox node: `AppImage/scripts/build_appimage.sh`.
- [ ] **Step 2:** Install on both nodes; open the dashboard on the central node.
- [ ] **Step 3:** Verify: the header health badge reflects the WORST status across both nodes (make one node have a warning/critical → header shows it); the info count sums both nodes. Open the Health modal → a node picker appears (when 2 nodes); it defaults to the worst-status node; switching nodes shows that node's checks; acknowledging a check on a remote node dismisses it on THAT node (re-open → still dismissed there).
- [ ] **Step 4:** Single-node parity: a node with no peers shows no picker; header + modal identical to before.
- [ ] **Step 5: Commit the build artifact.**
```bash
git add AppImage/ProxMenux-*.AppImage
git commit -m "build: refresh Monitor AppImage with federation Health all-nodes [skip ci]"
```

---

## Notes for the executor
- No backend changes. Acknowledge routes per-node via `getLocalApiUrl(nodeEndpoint(...))`.
- `getApiUrl(aggregateUrl(...))` hits central (not proxied) because it starts with `/api/federation`.
- Do not touch the global header node selector or the health THRESHOLDS/settings (those are separate, in Settings).
- Single-node: `perNodeHealth.length === 1` → no picker; behaviour identical to today.
