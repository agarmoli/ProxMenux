# Federation Storage All-Nodes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the Storage tab into an all-nodes cluster view — unified tables (disks/ZFS/PVE-storage/mounts) with a Node column + local filter + per-node summary cards, and the disk detail modal (incl. SMART/schedules/tools) routed to each disk's node.

**Architecture:** Pure frontend migration reusing the Fase 1 aggregator. The component fetches `/api/storage`, `/api/proxmox-storage`, `/api/mounts` via `aggregateUrl(...)`, joins the three per-node responses, flattens each list tagging rows with `_node`/`_node_is_self`, and renders one summary block per node. The disk modal and its temperature sub-components route every per-disk call via `fetchAtNode(disk._node, disk._node_is_self, …)` — including SMART schedules/tools, which are per-node config reached through a disk. No backend changes.

**Tech Stack:** React 19 / Next.js 15 / TypeScript. The Storage tab uses manual `fetch` + `useState` + `useEffect` interval (NOT SWR).

**Spec:** `docs/superpowers/specs/2026-06-14-federation-storage-design.md`

**Prerequisites / gates (this repo's next.config sets `ignoreBuildErrors:true` + `ignoreDuringBuilds:true`, so `next build` does NOT fail on type errors — use BOTH gates):**
- Build: `cd /home/adrian/code/ProxMenux/AppImage && npm run build` must COMPLETE (catches syntax/import breakage). Slow (~1-3 min).
- Scoped types: `npx tsc --noEmit 2>&1 | grep -E "storage-overview|disk-temperature-card|disk-temperature-detail-modal"`. **Baseline (do not exceed):** `storage-overview.tsx` = 19 pre-existing errors (null-safety in the modal — leave them, do not fix, do not add new ones); `disk-temperature-card.tsx` = 0; `disk-temperature-detail-modal.tsx` = 0.
- The plan's line numbers are anchors into the CURRENT files — READ the files; do not trust line numbers blindly.

**Shared helpers already available (Fase 1, in `lib/api-config.ts`):** `aggregateUrl(path)`, `fetchApi`, `fetchAtNode(node, isSelf, endpoint)` (with `node` undefined → plain local call, which guarantees single-node parity), and types `AggregateResponse<T>` / `AggregateNode<T>`.

---

## Sub-phase 2a — Listing + per-node summary + filter (Tasks 1-3)

## Task 1: Data layer — fetch via aggregator, join per-node, derive merged arrays

**File:** `AppImage/components/storage-overview.tsx`
- Interfaces: `DiskInfo` (~20-58), `ZFSPool` (~75-81), `ProxmoxStorage` (~96-105), `RemoteMount` (~116-135)
- Imports (~10), state (~199-206), `fetchStorageData` (~222-246)

- [ ] **Step 1: Tag the four row interfaces**

Add these two fields before the closing `}` of EACH of `DiskInfo`, `ZFSPool`, `ProxmoxStorage`, `RemoteMount`:
```ts
  _node?: string
  _node_is_self?: boolean
```

- [ ] **Step 2: Update the api-config import (~line 10)**

```ts
import { fetchApi, fetchAtNode, aggregateUrl, type AggregateResponse } from "../lib/api-config"
```

- [ ] **Step 3: Replace the three data states with aggregator-response states**

Find (~199-201):
```ts
  const [storageData, setStorageData] = useState<StorageData | null>(null)
  const [proxmoxStorage, setProxmoxStorage] = useState<ProxmoxStorageData | null>(null)
  const [remoteMounts, setRemoteMounts] = useState<RemoteMount[]>([])
```
Replace with:
```ts
  const [storageAgg, setStorageAgg] = useState<AggregateResponse<StorageData> | null>(null)
  const [proxmoxAgg, setProxmoxAgg] = useState<AggregateResponse<ProxmoxStorageData> | null>(null)
  const [mountsAgg, setMountsAgg] = useState<AggregateResponse<RemoteMountsData> | null>(null)
  const [nodeFilter, setNodeFilter] = useState<string | null>(null)
```

- [ ] **Step 4: Fetch the three aggregator URLs**

Replace the body of `fetchStorageData` (~222-240) with:
```ts
  const fetchStorageData = async () => {
    try {
      const [s, p, m] = await Promise.all([
        fetchApi<AggregateResponse<StorageData>>(aggregateUrl("/api/storage")),
        fetchApi<AggregateResponse<ProxmoxStorageData>>(aggregateUrl("/api/proxmox-storage")),
        fetchApi<AggregateResponse<RemoteMountsData>>(aggregateUrl("/api/mounts")).catch(
          () => ({ path: "/api/mounts", nodes: [] } as AggregateResponse<RemoteMountsData>),
        ),
      ])
      setStorageAgg(s)
      setProxmoxAgg(p)
      setMountsAgg(m)
    } catch (error) {
      console.error("Error fetching storage data:", error)
    } finally {
      setLoading(false)
    }
  }
```
(The `useEffect` interval at ~242-246 is unchanged.)

- [ ] **Step 5: Derive per-node join + merged arrays + compat bindings**

Placement matters: `getDiskHealthBreakdown()`/`getDiskTypesBreakdown()` are CALLED (~593-594) and the `totalLocal*`/`totalRemote*`/`remoteStorageCount` derivations (~599-667) read `storageData`/`proxmoxStorage` BEFORE the `if (loading) return` guard (~669). So insert this block AFTER the two helper *definitions* (~512-578) and all hooks, but BEFORE the first use at ~line 593 — NOT after the loading guard. (Safe before data arrives: `storageAgg` is null → `perNode`/`onlineNodes`/`all*` are empty arrays and the compat `storageData`/`proxmoxStorage` are null, which the existing `if (!storageData…)` guards already handle.)
```ts
  // Join the three aggregator responses by node name (self is first).
  const perNode = (storageAgg?.nodes ?? []).map((s) => {
    const p = proxmoxAgg?.nodes.find((x) => x.node === s.node)
    const m = mountsAgg?.nodes.find((x) => x.node === s.node)
    return {
      node: s.node,
      is_self: s.is_self,
      online: s.online,
      error: s.error,
      storage: s.data,
      proxmox: (p?.data ?? null) as ProxmoxStorageData | null,
      mounts: ((m?.data as RemoteMountsData | null)?.mounts) ?? [],
    }
  })
  const onlineNodes = perNode.filter((n) => n.online && n.storage)
  const offlineNodes = perNode.filter((n) => !n.online)
  const nodeNames = onlineNodes.map((n) => n.node)

  const tagAll = <T,>(rows: T[] | undefined, n: { node: string; is_self: boolean }): T[] =>
    (rows ?? []).map((r) => ({ ...r, _node: n.node, _node_is_self: n.is_self }))
  const inFilter = <T extends { _node?: string }>(rows: T[]): T[] =>
    nodeFilter ? rows.filter((r) => r._node === nodeFilter) : rows

  const allDisks = inFilter(onlineNodes.flatMap((n) => tagAll(n.storage!.disks, n)))
  const allZfs = inFilter(onlineNodes.flatMap((n) => tagAll(n.storage!.zfs_pools, n)))
  const allProxmox = inFilter(onlineNodes.flatMap((n) => tagAll(n.proxmox?.storage, n)))
  const allMounts = inFilter(onlineNodes.flatMap((n) => tagAll(n.mounts, n)))

  // Compat bindings so existing summary/table JSX keeps compiling until
  // Tasks 2-3 convert it. Tables -> merged arrays (Task 2); summary -> per-node (Task 3).
  const storageData = onlineNodes[0]?.storage ?? null
  const proxmoxStorage = onlineNodes[0]?.proxmox ?? null
  const remoteMounts = onlineNodes[0]?.mounts ?? []
```
(Note the generic arrow syntax `<T,>` — the trailing comma is required in `.tsx` so it isn't parsed as JSX.)

- [ ] **Step 6: Fix the offline-mounts setter references**

`remoteMounts` is no longer a state setter. Grep for `setStorageData`, `setProxmoxStorage`, `setRemoteMounts` — there must be NO remaining references (they were only in the old `fetchStorageData`). If any remain, remove them.

- [ ] **Step 7: Build + scoped tsc**

Run: `cd /home/adrian/code/ProxMenux/AppImage && npm run build` → must COMPLETE.
Run: `npx tsc --noEmit 2>&1 | grep -cE "storage-overview"` → must be **≤ 19** (no new errors vs baseline).
Fix any NEW breakage (most likely a leftover `setStorageData`/etc. reference). Do NOT fix the 19 pre-existing errors.

- [ ] **Step 8: Commit**

```bash
git add AppImage/components/storage-overview.tsx
git commit -m "feat(storage): fetch via aggregator + per-node join (data layer)"
```

---

## Task 2: Unified tables — Node column + node-scoped keys

**File:** `AppImage/components/storage-overview.tsx`
- Disk cards (~1339-1715), ZFS pools (~1298-1337), Proxmox storage table (~902-1046), Remote mounts (~1048-1133)

- [ ] **Step 1: Point each table at its merged array**

Switch the source array each list maps over:
- Physical disks (~1339-1545, mobile+desktop variants both): `storageData.disks.map(...)` → `allDisks.map(...)`. Its USB sub-list (~1552-1715) filters disks by `connection_type === 'usb'`; keep that filter but source from `allDisks`.
- ZFS pools (~1298-1337): `storageData.zfs_pools.map(...)` → `allZfs.map(...)`; its enclosing length guard → `allZfs.length > 0`.
- Proxmox storage (~902-1046): `proxmoxStorage.storage.map(...)` → `allProxmox.map(...)`; length guard → `allProxmox.length > 0`.
- Remote mounts (~1048-1133): `remoteMounts.map(...)` → `allMounts.map(...)`; length guard → `allMounts.length > 0`.

- [ ] **Step 2: Node-scoped React keys**

Disk names (`sda`, `nvme0n1`) and storage names repeat across nodes. For each table's `.map`, change the row `key` to include the node:
- disks: the `key` is on the OUTER wrapper `<div key={disk.name}>` (~line 1350) that holds both the mobile and desktop card variants — ONE key per disk, not one per variant. Change it to `` key={`${disk._node}:${disk.name}`} ``. Same for the USB list's outer `<div>` (~line 1564).
- zfs: `` key={`${pool._node}:${pool.name}`} ``
- proxmox: the iterator variable is `storage` (the table maps `.map((storage) => ...)` at ~line 915) — use `` key={`${storage._node}:${storage.name}`} ``
- mounts: `` key={`${mount._node}:${mount.target}`} ``

- [ ] **Step 3: Node badge per row (only when >1 node)**

In each table row (disks mobile+desktop, zfs, proxmox, mounts), next to the name/title, add (mirrors `virtual-machines.tsx:1548-1550`):
```tsx
{row._node && nodeNames.length > 1 && (
  <Badge variant="outline" className="flex-shrink-0 bg-muted/60 text-muted-foreground border-border">
    <Server className="h-3 w-3 mr-1" />{row._node}
  </Badge>
)}
```
(replace `row` with the actual iter variable: `disk`, `pool`, `storage`, `mount` respectively). `Server` is ALREADY imported on the lucide line (~5) — no import change needed.

- [ ] **Step 4: Build + scoped tsc**

Run: `cd /home/adrian/code/ProxMenux/AppImage && npm run build` → COMPLETE.
Run: `npx tsc --noEmit 2>&1 | grep -cE "storage-overview"` → ≤ 19.

- [ ] **Step 5: Commit**

```bash
git add AppImage/components/storage-overview.tsx
git commit -m "feat(storage): unified all-nodes tables with Node column + scoped keys"
```

---

## Task 3: Per-node summary cards + filter chips + offline banners

**File:** `AppImage/components/storage-overview.tsx`
- Summary helpers `getDiskHealthBreakdown` (~512-554), `getDiskTypesBreakdown` (~556-578); summary grid (~693-900); render start (~690)

- [ ] **Step 1: Parameterize the two summary helpers by disks**

`getDiskHealthBreakdown` and `getDiskTypesBreakdown` currently read the closure `storageData.disks`. Change each to accept a disks array so they can be computed per node:
- `const getDiskHealthBreakdown = (disks: DiskInfo[] | undefined) => {` … replace `storageData.disks.forEach` with `(disks ?? []).forEach` and the early `if (!storageData || !storageData.disks)` guard with `if (!disks) return { normal: 0, warning: 0, critical: 0 }`.
- `const getDiskTypesBreakdown = (disks: DiskInfo[] | undefined) => {` … same treatment.
Update their existing call sites (in the summary, Step 2 replaces them anyway).

- [ ] **Step 2: Render the summary grid once per online node**

The summary grid is the 4-card block (~693-900). Wrap it in `onlineNodes.map((n) => ...)`, and inside, compute from `n`:
- a per-node label when multi-node:
```tsx
{nodeNames.length > 1 && (
  <div className="flex items-center gap-1.5 mb-2 text-sm font-medium">
    <Server className="h-4 w-4 text-muted-foreground" />{n.node}{n.is_self ? " (this node)" : ""}
  </div>
)}
```
- inside the cards, replace `storageData` → `n.storage`, `proxmoxStorage` → `n.proxmox`, and the helper calls → `getDiskHealthBreakdown(n.storage?.disks)` / `getDiskTypesBreakdown(n.storage?.disks)`. The disk-count badge uses `n.storage?.disk_count`. The Local/Remote donuts filter `n.proxmox?.storage` for local/remote types.
Wrap each node's block with `key={n.node}`. Keep all the inner card markup; only swap the data source.

- [ ] **Step 3: Filter chips + offline banners**

At the very top of the returned layout (before the summary loop), add (mirrors Network):
```tsx
{nodeNames.length > 1 && (
  <div className="flex items-center gap-1.5 mb-3">
    <button
      onClick={() => setNodeFilter(null)}
      className={`text-xs px-2 py-0.5 rounded-full border ${nodeFilter === null ? "bg-blue-500/15 text-blue-400 border-blue-500/30" : "border-border text-muted-foreground"}`}
    >All</button>
    {nodeNames.map((nn) => (
      <button
        key={nn}
        onClick={() => setNodeFilter(nn)}
        className={`text-xs px-2 py-0.5 rounded-full border ${nodeFilter === nn ? "bg-blue-500/15 text-blue-400 border-blue-500/30" : "border-border text-muted-foreground"}`}
      >{nn}</button>
    ))}
  </div>
)}
{offlineNodes.map((n) => (
  <div key={n.node} className="flex items-center gap-2 text-xs text-muted-foreground border border-border rounded-md px-2 py-1 mb-1">
    <AlertTriangle className="h-3 w-3 text-yellow-500" />
    {n.node} — offline{n.error ? ` (${n.error})` : ""}
  </div>
))}
```
(`AlertTriangle` is already imported in this file.)

- [ ] **Step 4: Remove now-unused compat bindings if they cause lint noise**

After Tasks 2-3, `storageData`/`proxmoxStorage`/`remoteMounts` compat bindings may be unused (tables use merged arrays, summary uses `n.*`). If `npm run build` still completes they can stay, but prefer deleting any that are now unreferenced (grep each). Leave them if anything else still reads them (e.g. the disk modal reads `selectedDisk`, not `storageData`, so it's fine).

- [ ] **Step 5: Single-node parity check (read-through, no code)**

Confirm: with one node, `nodeNames.length === 1` → no chips, no badges, summary renders once (the node label hidden). Identical to today.

- [ ] **Step 6: Build + scoped tsc**

Run: `npm run build` → COMPLETE. Run: `npx tsc --noEmit 2>&1 | grep -cE "storage-overview"` → ≤ 19.

- [ ] **Step 7: Commit**

```bash
git add AppImage/components/storage-overview.tsx
git commit -m "feat(storage): per-node summary cards + local filter + offline banners"
```

---

## Sub-phase 2b — Disk modal routed per node (Tasks 4-5)

## Task 4: Route the disk detail modal to the disk's node

**File:** `AppImage/components/storage-overview.tsx`. `selectedDisk` is a tagged `DiskInfo` (carries `_node`/`_node_is_self` from `allDisks`). Replace every per-disk `fetchApi(...)` in the modal + its inline tabs with `fetchAtNode(selectedDisk._node, selectedDisk._node_is_self, ...)`. For inline sub-tab components (`SmartTestTab`, `HistoryTab`, `ScheduleTab`) that receive `disk={selectedDisk}` as a prop, route on `disk._node`/`disk._node_is_self`.

- [ ] **Step 1: handleDiskClick (~350-394)**

- `/api/storage/observations?device=...&serial=...` (~366): `fetchApi(...)` → `fetchAtNode(disk._node, disk._node_is_self, ...)` (this fn already receives `disk`).
- `/api/storage/smart/${disk.name}/latest` (~383): same.

- [ ] **Step 2: SMART tab — `SmartTestTab` (~3853-4228)**

It receives the disk. Route via `disk._node`/`disk._node_is_self`:
- GET `/api/storage/smart/${disk.name}` status + polls (~3864, ~3885, ~3959).
- POST `/api/storage/smart/tools/install` (~3921): `fetchAtNode(disk._node, disk._node_is_self, '/api/storage/smart/tools/install', { method:'POST', ... })`.
- POST `/api/storage/smart/${disk.name}/test` (~3943).

- [ ] **Step 3: History tab — `HistoryTab` (~4239-4412)**

- GET `/api/storage/smart/${disk.name}/history?limit=50` (~4248)
- DELETE `/api/storage/smart/${disk.name}/history/${filename}` (~4262)
- GET `/api/storage/smart/${disk.name}/history/${filename}` download (~4273)
- GET `/api/storage/smart/${disk.name}` report (~4296)
- ALSO `fetchTempHistoryForReport(disk.name)` (~4300, inside `handleViewReport`) → routed via the signature change in Step 5 (pass `disk._node, disk._node_is_self`).
The four direct `fetchApi` calls above → `fetchAtNode(disk._node, disk._node_is_self, ...)`.

- [ ] **Step 4: Schedule tab — `ScheduleTab` (~4436-4767)**

All schedule calls route to the disk's node (each node owns its `/api/storage/smart/schedules`):
- GET `/api/storage/smart/schedules` (~4461)
- POST `/api/storage/smart/schedules/toggle` (~4477)
- POST `/api/storage/smart/schedules` (~4498)
- DELETE `/api/storage/smart/schedules/${id}` (~4518)
All → `fetchAtNode(disk._node, disk._node_is_self, ...)`.

- [ ] **Step 5: `fetchTempHistoryForReport` — module-level function used by TWO tabs**

`fetchTempHistoryForReport` (~line 2370) is a MODULE-LEVEL `async function` (outside the component) that calls `fetchApi(\`/api/disk/${diskName}/temperature/history?...\`)`. `selectedDisk` is NOT in scope there, so you cannot route via `selectedDisk._node`. Instead:
1. Change its signature to `async function fetchTempHistoryForReport(diskName: string, node?: string, isSelf?: boolean)`.
2. Change its internal `fetchApi(...)` → `fetchAtNode(node, isSelf, \`/api/disk/${diskName}/temperature/history?...\`)`.
3. Update BOTH call sites to pass the disk's node:
   - `SmartTestTab` (~line 4210): `fetchTempHistoryForReport(disk.name, disk._node, disk._node_is_self)`.
   - `HistoryTab.handleViewReport` (~line 4300): `fetchTempHistoryForReport(disk.name, disk._node, disk._node_is_self)`.

- [ ] **Step 6: Build + scoped tsc**

Run: `npm run build` → COMPLETE. `npx tsc --noEmit 2>&1 | grep -cE "storage-overview"` → ≤ 19.

- [ ] **Step 7: Commit**

```bash
git add AppImage/components/storage-overview.tsx
git commit -m "feat(storage): route disk modal (SMART/history/schedule/tools) to the disk's node"
```

---

## Task 5: Route the temperature sub-components per node

**Files:**
- `AppImage/components/disk-temperature-card.tsx` (fetch ~67)
- `AppImage/components/disk-temperature-detail-modal.tsx` (fetch ~103)
- `AppImage/components/storage-overview.tsx` (where these are rendered: card ~2019-2025, detail modal ~2349-2359)

- [ ] **Step 1: `disk-temperature-card.tsx` — add node props + route**

- Add `node?: string` and `isSelf?: boolean` to its props interface; destructure them.
- Update its api-config import to include `fetchAtNode`.
- Change its `fetchApi(\`/api/disk/${diskName}/temperature/history?timeframe=...\`)` (~67) → `fetchAtNode(node, isSelf, \`/api/disk/${diskName}/temperature/history?timeframe=...\`)`.

- [ ] **Step 2: `disk-temperature-detail-modal.tsx` — add node props + route**

- Add `node?: string` and `isSelf?: boolean` to its props interface; destructure them.
- Import `fetchAtNode`; change its temperature-history `fetchApi(...)` (~103) → `fetchAtNode(node, isSelf, ...)`.

- [ ] **Step 3: Pass the disk's node from `storage-overview.tsx`**

- `<DiskTemperatureCard ... />` (~2019-2025): add `node={selectedDisk?._node} isSelf={selectedDisk?._node_is_self}`.
- `<DiskTemperatureDetailModal ... />` (~2349-2359): it's driven by `tempHistoryDisk` (a `DiskInfo`). Add `node={tempHistoryDisk?._node} isSelf={tempHistoryDisk?._node_is_self}`.

- [ ] **Step 4: Build + scoped tsc**

Run: `npm run build` → COMPLETE.
Run: `npx tsc --noEmit 2>&1 | grep -E "storage-overview|disk-temperature-card|disk-temperature-detail-modal"` → `storage-overview` ≤ 19, the two temperature files **0**.

- [ ] **Step 5: Commit**

```bash
git add AppImage/components/disk-temperature-card.tsx AppImage/components/disk-temperature-detail-modal.tsx AppImage/components/storage-overview.tsx
git commit -m "feat(storage): route disk temperature sub-components to the disk's node"
```

---

## Task 6: Build the AppImage and verify on the cluster

**Files:** none (build + manual verification — the real acceptance gate, spec §6).

- [ ] **Step 1: Rebuild the AppImage**

Run on a host with the build deps (a Proxmox node): `AppImage/scripts/build_appimage.sh`. (Note: the build needs `libupsclient` from apt, present on Proxmox nodes; it does not complete on a bare WSL dev box.)

- [ ] **Step 2: Install on both nodes; open the Storage tab on the central node.**

- [ ] **Step 3: Verify all-nodes listing + summary (two nodes)**

- Disks / ZFS / PVE-storage / mounts from BOTH nodes appear, each row with a Node badge.
- Filter chips (All · nodeA · nodeB) narrow every table.
- One summary block per node, each showing that node's totals/health/disk-type breakdown.
- Stopping/disabling a peer shows it as an inline "offline" banner; the rest still renders.

- [ ] **Step 4: Verify disk-modal routing**

- Open a REMOTE node's disk → Overview/SMART/History/Schedule all show data from the remote node (not the central one).
- Run a SMART test, create/toggle a schedule, install tools → each acts on the remote disk's node.
- Temperature history (card + detail modal) shows the remote disk's data.

- [ ] **Step 5: Verify single-node parity**

On a node with no peers: no Node badges/chips, one summary, disk modal works locally — identical to before.

- [ ] **Step 6: Commit the build artifact (repo convention)**

```bash
git add AppImage/ProxMenux-*.AppImage
git commit -m "build: refresh Monitor AppImage with federation Storage all-nodes [skip ci]"
```

---

## Notes for the executor

- No backend changes. Do not add a `node` field to the SMART schedules schema — schedules are per-node and reached through a disk, so `fetchAtNode(disk._node, ...)` is sufficient.
- `fetchAtNode(undefined, undefined, path)` == plain local fetch → single-node installs are unaffected; never special-case node count in the fetch layer.
- Do NOT fix the 19 pre-existing `storage-overview.tsx` type errors (out of scope); just don't add new ones.
- Do NOT touch the global header node selector.
- Tasks 4-5 are coupled to 2a's tagging (Task 1) — `selectedDisk`/`tempHistoryDisk` only carry `_node` because `allDisks` tagged them. They must run after Task 1.
