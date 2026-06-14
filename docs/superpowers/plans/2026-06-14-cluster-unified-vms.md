# Cluster Unified VMs/LXC List — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show every VM/LXC of every cluster node in one table under the Cluster tab, so the user sees both nodes' guests without switching the node selector.

**Architecture:** Pure frontend. A new isolated component `cluster-vms.tsx` consumes the already-existing `/api/federation/vms` endpoint (guests from all nodes, each tagged `_node`/`_node_is_self`, LXC ones carrying `update_check`/`app_update`) and renders a sortable table. Mounted in the Cluster tab below `<ClusterOverview />`. No backend changes.

**Tech Stack:** Next.js / React / TypeScript / shadcn-ui (Tailwind).

---

## Key facts established from the codebase

- `/api/federation/vms` already returns `{ vms: [...] }`; each entry has the `/api/vms` fields (`vmid, name, status, type, cpu, mem, maxmem`) plus `_node`, `_node_is_self`, and for LXC `update_check?`/`app_update?`. It is **not yet consumed by the frontend**.
- Cluster tab content (`AppImage/components/proxmox-dashboard.tsx:837`):
  ```tsx
          <TabsContent value="cluster" className="space-y-4 md:space-y-6 mt-0">
            <ClusterOverview key={`cluster-${componentKey}`} />
          </TabsContent>
  ```
- Helpers: `formatStorage(sizeInGB: number)` from `../lib/utils` (`lib/utils.ts:8`); `getActiveNode`/`setActiveNode` from `../lib/api-config`; `renderAppUpdateBadge(app?, compact?, onClick?)` exported from `./lxc-app-panel` (`components/lxc-app-panel.tsx:31`). Proxmox `/cluster/resources` reports `mem`/`maxmem` in **bytes**, so divide by 1024³ before `formatStorage`.
- No JS test framework in the repo; verify with `next build` + manual. `next.config` has `typescript.ignoreBuildErrors: true`, so the real gate is the build compiling.

## File structure

- **Create:** `AppImage/components/cluster-vms.tsx` — the unified guests table.
- **Modify:** `AppImage/components/proxmox-dashboard.tsx` — import + mount `<ClusterVms />` in the Cluster tab.
- **Modify:** `CHANGELOG.md` — one-line entry.

---

### Task 1: Unified guests table component

**Files:**
- Create: `AppImage/components/cluster-vms.tsx`

- [ ] **Step 1: Create the component**

`AppImage/components/cluster-vms.tsx`:

```tsx
"use client"

import { useEffect, useState } from "react"
import { Boxes, Server, AlertTriangle } from "lucide-react"
import { fetchApi, setActiveNode } from "../lib/api-config"
import { formatStorage } from "../lib/utils"
import { renderAppUpdateBadge, type AppUpdate } from "./lxc-app-panel"

interface ClusterVM {
  vmid: number
  name?: string
  status?: string
  type?: string
  cpu?: number
  mem?: number
  maxmem?: number
  _node?: string
  _node_is_self?: boolean
  update_check?: { count?: number; available?: boolean }
  app_update?: AppUpdate
}

interface FedNode {
  node: string
  is_self: boolean
  online: boolean
}

const toGB = (b?: number) => formatStorage((b ?? 0) / 1024 / 1024 / 1024)

function statusClass(s?: string) {
  if (s === "running") return "text-emerald-400"
  if (s === "stopped") return "text-muted-foreground"
  return "text-amber-400"
}

export function ClusterVms() {
  const [vms, setVms] = useState<ClusterVM[]>([])
  const [nodes, setNodes] = useState<FedNode[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = () => {
    fetchApi<{ vms: ClusterVM[] }>("/api/federation/vms")
      .then((d) => { setVms(d.vms || []); setError(null) })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false))
    fetchApi<{ nodes: FedNode[] }>("/api/federation/nodes")
      .then((d) => setNodes(d.nodes || []))
      .catch(() => {})
  }

  useEffect(() => {
    load()
    const id = setInterval(load, 15000)
    return () => clearInterval(id)
  }, [])

  const open = (vm: ClusterVM) => {
    setActiveNode(vm._node_is_self ? null : (vm._node ?? null))
    window.location.reload()
  }

  const sorted = [...vms].sort(
    (a, b) => (a._node ?? "").localeCompare(b._node ?? "") || a.vmid - b.vmid,
  )
  const offline = nodes.filter((n) => !n.online && !n.is_self)

  if (loading && vms.length === 0) {
    return <div className="text-sm text-muted-foreground p-4">Loading guests…</div>
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Boxes className="h-4 w-4" /> All guests ({sorted.length})
      </div>

      {offline.length > 0 && (
        <div className="flex items-center gap-2 text-xs text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5" />
          Couldn&apos;t reach: {offline.map((n) => n.node).join(", ")} — its guests aren&apos;t listed.
        </div>
      )}
      {error && <div className="text-sm text-red-400">{error}</div>}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-muted-foreground">
            <tr className="text-left">
              <th className="px-3 py-2 font-medium">Node</th>
              <th className="px-3 py-2 font-medium">ID</th>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">CPU</th>
              <th className="px-3 py-2 font-medium">RAM</th>
              <th className="px-3 py-2 font-medium">Updates</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((vm) => (
              <tr
                key={`${vm._node}-${vm.vmid}`}
                className="border-t border-border hover:bg-accent/40 cursor-pointer"
                onClick={() => open(vm)}
              >
                <td className="px-3 py-2 whitespace-nowrap">
                  <span className="inline-flex items-center gap-1">
                    <Server className="h-3.5 w-3.5 text-muted-foreground" />
                    {vm._node}{vm._node_is_self ? " (this)" : ""}
                  </span>
                </td>
                <td className="px-3 py-2">{vm.vmid}</td>
                <td className="px-3 py-2 font-medium truncate max-w-[14rem]">{vm.name}</td>
                <td className="px-3 py-2 uppercase text-xs">{vm.type === "lxc" ? "LXC" : "VM"}</td>
                <td className={`px-3 py-2 ${statusClass(vm.status)}`}>{vm.status}</td>
                <td className="px-3 py-2">{vm.status === "running" ? `${Math.round((vm.cpu ?? 0) * 100)}%` : "—"}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {vm.status === "running" ? `${toGB(vm.mem)} / ${toGB(vm.maxmem)}` : toGB(vm.maxmem)}
                </td>
                <td className="px-3 py-2">
                  <span className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                    {vm.type === "lxc" && typeof vm.update_check?.count === "number" && vm.update_check.count > 0 && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-400">{vm.update_check.count} pkg</span>
                    )}
                    {vm.type === "lxc" && renderAppUpdateBadge(vm.app_update, true)}
                  </span>
                </td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr><td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">No guests found.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Type-check the new file**

Run: `cd AppImage && npx tsc --noEmit 2>&1 | grep "components/cluster-vms.tsx" | head`
Expected: no output (no errors in the new file).

- [ ] **Step 3: Commit**

```bash
git add AppImage/components/cluster-vms.tsx
git commit -m "feat(cluster-vms): unified guests table component"
```

---

### Task 2: Mount it in the Cluster tab

**Files:**
- Modify: `AppImage/components/proxmox-dashboard.tsx`

- [ ] **Step 1: Import the component**

Add next to the existing `ClusterOverview` import (the line `import { ClusterOverview } from "./cluster-overview"`):

```tsx
import { ClusterVms } from "./cluster-vms"
```

- [ ] **Step 2: Render it below the node cards**

Replace the Cluster tab content (`proxmox-dashboard.tsx:837`):

```tsx
          <TabsContent value="cluster" className="space-y-4 md:space-y-6 mt-0">
            <ClusterOverview key={`cluster-${componentKey}`} />
          </TabsContent>
```

with:

```tsx
          <TabsContent value="cluster" className="space-y-4 md:space-y-6 mt-0">
            <ClusterOverview key={`cluster-${componentKey}`} />
            <ClusterVms key={`cluster-vms-${componentKey}`} />
          </TabsContent>
```

- [ ] **Step 3: Build**

Run: `cd AppImage && npx tsc --noEmit 2>&1 | grep -E "cluster-vms|proxmox-dashboard" | grep -v "Property '(success|update_available|health)' does not exist"; npm run build`
Expected: no new type errors in the edited/new files; `next build` reports compiled + exported.

- [ ] **Step 4: Commit**

```bash
git add AppImage/components/proxmox-dashboard.tsx
git commit -m "feat(cluster-vms): mount unified guests table in the Cluster tab"
```

---

### Task 3: Docs

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add a bullet under the 2026-06-14 heading**

After the existing 2026-06-14 entries, add:

```markdown
- **Cluster — unified guests list:** the Cluster tab now lists every VM/LXC of
  every node in one table (node column, status, CPU/RAM, LXC update/app badges);
  clicking a row drills into that node. Reuses the existing `/api/federation/vms`
  aggregation — no backend change.
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(cluster-vms): note unified guests list"
```

---

### Task 4: Manual verification (real cluster)

- [ ] **Step 1:** Rebuild the AppImage (CI workflow on the branch) and reinstall on the central node.
- [ ] **Step 2:** Open the **Cluster** tab → confirm the node cards (unchanged) plus a table listing guests from **both** nodes, each with its Node column.
- [ ] **Step 3:** Confirm LXC rows show the package/app update chips where applicable.
- [ ] **Step 4:** Click a row of the remote node → confirm the dashboard switches to that node.
- [ ] **Step 5:** Stop the Monitor on the peer → confirm the "couldn't reach" note appears and the local node's guests still list.

---

## Self-review notes (for the implementer)

- **mem/maxmem are bytes** from `/cluster/resources`; `toGB()` divides by 1024³ before `formatStorage` (which expects GB). Don't pass raw bytes to `formatStorage`.
- **Row click vs badge click:** the Updates cell stops propagation so clicking a badge doesn't also trigger the row's node-switch.
- **No backend work:** `/api/federation/vms` already returns everything; if a field is missing, fix it there — but it isn't (it forwards each node's `/api/vms` verbatim plus `_node`).
```
