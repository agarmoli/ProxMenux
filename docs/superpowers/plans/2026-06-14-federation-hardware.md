# Federation Hardware All-Nodes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make every node's hardware viewable from the Hardware tab without changing the global selector — a node picker (default = self) fetches all nodes via the aggregator and shows the selected node's hardware (CPU/GPU/sensors/fans/PSU/UPS/PCI/USB…). GPU realtime + managed-installs route to the selected node; the script-based actions (driver installs, GPU mode switch) are local-node only.

**Architecture:** Pure frontend, reuses the Fase 1 aggregator (no backend). Hardware is PHYSICAL per machine, and its actions run via `ScriptTerminalModal` (a terminal/WebSocket that is NOT proxiable). So the model is a **node picker in the tab** (lowest-risk: the existing 3000-line render is preserved, only its data SOURCE changes to the selected node) — NOT stacked per-node sections. Read-only views (GPU realtime, managed-installs) route to the selected node via `fetchAtNode`; the 6 script actions are GATED to the local/self node (disabled + hint for remote, mirroring the VMs remote-console precedent).

**Design decisions (decided directly, no brainstorm):**
- Node picker (chips) in the tab, default = self/first node. NOT stacked sections (the 3000-line component + 6 actions make a per-node wrap too invasive/risky; and physical hardware is naturally viewed one machine at a time).
- Static + live hardware fetched once via the aggregator (both nodes in one response each); the selected node's data is DERIVED from the cached response (picker switch = no refetch).
- GPU realtime + managed-installs route to the selected node via `fetchAtNode`.
- Script actions (NVIDIA/AMD/Intel/Coral installs + GPU mode switch) are local-only (WebSocket constraint) → disabled when viewing a remote node, with a hint. No per-node script routing.
- Single-node parity: 1 node → no picker, `is_self` → all actions enabled, identical to today.
- Backend: none.

**Tech Stack:** React 19 / TS / SWR. `hardware.tsx` is 3000 lines. `hardware-monitor.tsx` is unused (dead); `gpu-switch-mode-indicator.tsx` is pure UI (no fetch) — neither needs changes.

**Spec note:** No separate spec (5th application of the pattern); design lives here. NOTE this DEVIATES from the roadmap's "stacked per node" for Hardware — picker chosen for risk + action-safety; recorded in the roadmap.

**Gates (next.config ignoreBuildErrors:true → use BOTH):**
- `cd /home/adrian/code/ProxMenux/AppImage && npm run build` must COMPLETE.
- `npx tsc --noEmit 2>&1 | grep -c "hardware\.tsx"` — **baseline 0** (file is clean). Must stay **0**.
- READ the file around cited lines.

**Shared (Fase 1, `lib/api-config.ts`):** `aggregateUrl(path)`, `fetchApi`, `fetchAtNode(node,isSelf,endpoint)`, types `AggregateResponse<T>`/`AggregateNode<T>`. `swrFetcher` (imported in hardware.tsx as `fetcher as swrFetcher`) is fetchApi-based and works with `aggregateUrl(...)` (which hits central, not proxied).

---

## Task 1: Data layer + node picker

**File:** `AppImage/components/hardware.tsx`
- imports (~top), the two `useSWR` calls + `hardwareData` merge (~211-262), `managedInstalls` fetch (~289-305), render start.

- [ ] **Step 1: Imports.** Add to the `@/lib/api-config` import (the one that brings `fetcher as swrFetcher`):
```ts
import { fetchApi, fetchAtNode, aggregateUrl, type AggregateResponse, type AggregateNode } from "@/lib/api-config"
```
(merge with the existing import; keep `fetcher as swrFetcher`.)

- [ ] **Step 2: Switch the two SWR calls to the aggregator + add picker state.** Replace the two `useSWR<HardwareData>(...)` blocks (~215-237) with:
```ts
  const {
    data: staticAgg,
    error: staticError,
    isLoading: staticLoading,
    mutate: mutateStatic,
  } = useSWR<AggregateResponse<HardwareData>>(aggregateUrl("/api/hardware"), swrFetcher, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    refreshInterval: 0,
  })

  const {
    data: dynamicAgg,
    error: dynamicError,
  } = useSWR<AggregateResponse<HardwareData>>(aggregateUrl("/api/hardware/live"), swrFetcher, {
    refreshInterval: 5000,
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
    dedupingInterval: 2000,
  })

  const [selectedHwNode, setSelectedHwNode] = useState<string | null>(null)
  const hwNodes = (staticAgg?.nodes ?? []).filter((n) => n.online && n.data)
  const offlineHwNodes = (staticAgg?.nodes ?? []).filter((n) => !n.online)
  const selectedNode = hwNodes.find((n) => n.node === selectedHwNode) ?? hwNodes[0] ?? null
  const isSelfNode = selectedNode?.is_self ?? true

  const staticHardwareData = selectedNode?.data ?? undefined
  const dynamicHardwareData =
    (dynamicAgg?.nodes.find((n) => n.node === selectedNode?.node))?.data ?? undefined
```
(The `useState` import is already present. `staticHardwareData`/`dynamicHardwareData` are now derived consts — the existing `hardwareData` merge below them (~248-262) consumes them UNCHANGED. `staticError`/`dynamicError`/`staticLoading`/`mutateStatic` keep the same names so the rest of the file is unaffected.)

- [ ] **Step 3: Route `managedInstalls` to the selected node.** In the `managedInstalls` effect (~298-305), change `fetchApi<...>("/api/managed-installs")` to `fetchAtNode<...>(selectedNode?.node, selectedNode?.is_self, "/api/managed-installs")`, and add `selectedNode?.node` to the effect's dependency array (currently `[]` → `[selectedNode?.node]`) so it refetches on node switch.

- [ ] **Step 4: Render the node picker** (only when >1 node). Near the top of the returned layout (before the first hardware card; find the outer wrapper `return (` of the component's main render, after loading/error guards), add (`Server` from lucide — add to the import if absent):
```tsx
{hwNodes.length > 1 && (
  <div className="flex items-center gap-1.5 mb-4 flex-wrap">
    {hwNodes.map((n) => (
      <button
        key={n.node}
        onClick={() => setSelectedHwNode(n.node)}
        className={`text-xs px-2 py-0.5 rounded-full border flex items-center gap-1 ${n.node === selectedNode?.node ? "bg-blue-500/15 text-blue-400 border-blue-500/30" : "border-border text-muted-foreground"}`}
      >
        <Server className="h-3 w-3" />{n.node}{n.is_self ? " (this node)" : ""}
      </button>
    ))}
    {offlineHwNodes.map((n) => (
      <span key={n.node} className="text-xs px-2 py-0.5 rounded-full border border-border text-muted-foreground opacity-60">
        {n.node} — offline
      </span>
    ))}
  </div>
)}
```

- [ ] **Step 5: Build + scoped tsc.** `npm run build` COMPLETE; `npx tsc --noEmit 2>&1 | grep -c "hardware\.tsx"` = 0. Fix any NEW breakage (e.g. a place that read `staticHardwareData` expecting the SWR object's other fields — only `.data`-equivalent is used; verify).

- [ ] **Step 6: Commit.**
```bash
git add AppImage/components/hardware.tsx
git commit -m "feat(hardware): node picker + per-node sourcing via aggregator (data layer)"
```

---

## Task 2: Route GPU realtime + managed-installs to the node; gate script actions to local

**File:** `AppImage/components/hardware.tsx`
- GPU realtime effect (~438-469), the install/switch trigger buttons (search `setShowNvidiaInstaller`, `setShowAmdInstaller`, `setShowIntelInstaller`, `setShowCoralInstaller`, and the GPU mode switch save handler / `switchModeParams`)

- [ ] **Step 1: Route GPU realtime to the selected node.** In the `selectedGPU` effect (~438-469), change:
```ts
        const data = await fetchApi(`/api/gpu/${fullSlot}/realtime`)
```
to:
```ts
        const data = await fetchAtNode(selectedNode?.node, selectedNode?.is_self, `/api/gpu/${fullSlot}/realtime`)
```
and add `selectedNode?.node` to that effect's dependency array (currently `[selectedGPU]` → `[selectedGPU, selectedNode?.node]`).

- [ ] **Step 2: Gate the script-action triggers to the local node.** The 6 script actions (NVIDIA/AMD/Intel/Coral installs + GPU mode switch) run via `ScriptTerminalModal`, which uses a terminal/WebSocket that only runs on the local node. Find the BUTTONS that trigger them (the ones calling `setShowNvidiaInstaller(true)`, `setShowAmdInstaller(true)`, `setShowIntelInstaller(true)`, `setShowCoralInstaller(true)`, and the GPU mode-switch Save/confirm that sets `switchModeParams`/`setShowSwitchModeModal(true)`). For EACH such trigger button, add `disabled={!isSelfNode}` (preserve any existing `disabled` with `disabled={existing || !isSelfNode}`). If a trigger is not a `<button>` (e.g. an `onClick` div), guard the handler: `if (!isSelfNode) return` at its top.

- [ ] **Step 3: Add a remote-node hint banner.** Near the picker (or at the top of the GPU/Coral section), when viewing a remote node, render:
```tsx
{!isSelfNode && (
  <div className="flex items-center gap-2 text-xs text-muted-foreground border border-border rounded-md px-2 py-1 mb-3">
    <Server className="h-3 w-3" />
    Viewing {selectedNode?.node} (remote) — driver installs and GPU mode switch run only on the node itself. Enter the node to manage.
  </div>
)}
```

- [ ] **Step 4: Build + scoped tsc.** `npm run build` COMPLETE; `grep -c "hardware\.tsx"` = 0.

- [ ] **Step 5: Commit.**
```bash
git add AppImage/components/hardware.tsx
git commit -m "feat(hardware): route GPU realtime to node + gate script actions to local node"
```

---

## Task 3: Build the AppImage and verify on the cluster

**Files:** none (build + manual).

- [ ] **Step 1:** On a Proxmox node: `AppImage/scripts/build_appimage.sh`.
- [ ] **Step 2:** Install on both nodes; open the Hardware tab on the central node.
- [ ] **Step 3:** Verify: a node picker appears (2 nodes); default shows the local node; switching to the remote node shows ITS CPU/GPU/sensors/fans/PSU/UPS/PCI/USB; opening a remote GPU's detail polls realtime from the remote node; the driver-install + GPU-mode-switch buttons are DISABLED with a hint when viewing the remote node, ENABLED on the local node; an offline peer shows a greyed "offline" chip.
- [ ] **Step 4:** Single-node parity: a node with no peers shows no picker, all actions enabled — identical to before.
- [ ] **Step 5: Commit the build artifact.**
```bash
git add AppImage/ProxMenux-*.AppImage
git commit -m "build: refresh Monitor AppImage with federation Hardware all-nodes [skip ci]"
```

---

## Notes for the executor
- No backend changes. GPU realtime + managed-installs are GETs → routed via `fetchAtNode`. Script actions stay local (WebSocket not proxiable) → gated to `is_self`.
- `getApiUrl`/`fetchApi(aggregateUrl(...))` hits central (URL starts with `/api/federation`).
- `hardware-monitor.tsx` is unused — do NOT touch it. `gpu-switch-mode-indicator.tsx` is pure UI — do NOT touch it.
- `selectedNode?.node` undefined / single-node → `fetchAtNode(undefined,…)` = local call → parity preserved.
- Do not touch the global header node selector.
