# VMs "All nodes" In-place Management — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the VMs & LXCs tab always show every node's guests and manage any of them in place, routing each per-VM API call to that VM's node.

**Architecture:** Add a node-aware fetch layer in `lib/api-config.ts` (`fetchUrl` + pure `nodeEndpoint` + `fetchAtNode`). Switch the VMs list to the existing `/api/federation/vms` aggregation, add a node badge + node filter, and refactor every per-VM call site in `virtual-machines.tsx`, `metrics-dialog.tsx`, and `lxc-app-panel.tsx` to route via the VM's `_node`. Remote console stays disabled (WebSocket can't be proxied). Retire the now-redundant `cluster-vms.tsx` table.

**Tech Stack:** Next.js / React / TypeScript / shadcn-ui. (No JS test framework in repo → pure logic verified with a node check; UI verified with `next build` + manual.)

---

## Key facts (from the codebase)

- `/api/federation/vms` returns `{ vms: VMData[] }`, each entry = a node's `/api/vms` row plus `_node` and `_node_is_self`, and for LXC `update_check?`/`app_update?`. The `/api/federation/*` prefix is excluded from selector proxying, so it always hits the central. On a single-node install it returns just the local node's guests.
- `getLocalApiUrl(endpoint)` (already in `api-config.ts`) returns `getApiBaseUrl()+endpoint`, **ignoring** the global active node. `/api/proxy/<node>/...` paths pass through `getApiUrl` without double-proxy.
- Per-VM call sites (exact, current): SWR `useSWR<VMData[]>("/api/vms", fetcher, {refreshInterval:2500,...})` at `virtual-machines.tsx:599`; detail `fetchApi(\`/api/vms/${vm.vmid}\`)` :806 and `${lxc.vmid}` :716; mount points `\`/api/lxc/${vmid}/mount-points\`` :823; backups GET `\`/api/vms/${vmid}/backups\`` :866; firewall log `\`/api/vms/${vmid}/firewall/log?limit=500\`` :890; backup POST `\`/api/vms/${selectedVM.vmid}/backup\`` :926; control POST `\`/api/vms/${vmid}/control\`` :954; logs `\`/api/vms/${vmid}/logs\`` :982; description PUT `\`/api/vms/${selectedVM.vmid}/description\`` :1219. Terminal button at :3039-3048 (`openLxcTerminal(selectedVM.vmid, ...)`). `selectedVM` (full VMData) is in scope at every modal call site; list calls have `vm`/`lxc`.
- `metrics-dialog.tsx`: props `{vmid, vmName, vmType, onBack}` (`:10`); fetch `fetchApi(\`/api/vms/${vmid}/metrics?timeframe=${timeframe}\`)` (`:122`); invoked at `virtual-machines.tsx:3096`.
- `lxc-app-panel.tsx`: props `{vmid, appUpdate, onChanged}` (`:54`); calls `/api/vms/${vmid}/app` GET `:78`, POST `:92`, DELETE `:119`, `/app/check` POST `:107`; catalog `/api/lxc-app-catalog` `:75` (global, unchanged).

## File structure

- **Modify:** `AppImage/lib/api-config.ts` — `fetchUrl`, `nodeEndpoint`, `fetchAtNode`.
- **Modify:** `AppImage/components/virtual-machines.tsx` — data source, `_node` types, node badge + filter, refactor call sites, terminal disable.
- **Modify:** `AppImage/components/metrics-dialog.tsx` — node props + fetch.
- **Modify:** `AppImage/components/lxc-app-panel.tsx` — node props + fetch.
- **Modify:** `AppImage/components/proxmox-dashboard.tsx` — unmount `<ClusterVms />`.
- **Delete:** `AppImage/components/cluster-vms.tsx`.
- **Modify:** `CHANGELOG.md`.

---

## Phase 1 — Node-aware fetch layer

### Task 1: `nodeEndpoint` + `fetchAtNode` + `fetchUrl`

**Files:**
- Modify: `AppImage/lib/api-config.ts`

- [ ] **Step 1: Add the pure `nodeEndpoint` helper**

In `AppImage/lib/api-config.ts`, after `getLocalApiUrl` (right before `getAuthToken`), add:

```typescript
/**
 * Build the path for a per-VM call routed to a specific cluster node.
 * Local/self VM → the plain endpoint. Remote VM → the central's reverse proxy
 * for that node. Pure string logic (no window) so it's unit-checkable.
 */
export function nodeEndpoint(node: string | null | undefined, isSelf: boolean | undefined, endpoint: string): string {
  const normalized = endpoint.startsWith("/") ? endpoint : `/${endpoint}`
  if (!node || isSelf) return normalized
  return `/api/proxy/${encodeURIComponent(node)}${normalized}`
}
```

- [ ] **Step 2: Extract `fetchUrl` from `fetchApi`**

Refactor `fetchApi` so the auth+error core works on an already-resolved URL. Change the start of `fetchApi` (currently `const url = getApiUrl(endpoint)` at the top of the function body) to delegate:

```typescript
export async function fetchApi<T>(endpoint: string, options?: RequestInit): Promise<T> {
  return fetchUrl<T>(getApiUrl(endpoint), endpoint, options)
}

export async function fetchUrl<T>(url: string, label: string, options?: RequestInit): Promise<T> {
  const token = getAuthToken()

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options?.headers as Record<string, string>),
  }

  if (token) {
    headers["Authorization"] = `Bearer ${token}`
  }

  const response = await fetch(url, {
    ...options,
    headers,
    cache: "no-store",
  })
```

Then **keep the entire existing body** of the old `fetchApi` (the `if (!response.ok) { ... }` block through the final `return await response.json()`), **but** replace every remaining reference to `endpoint` inside that body with `label` (the 401 `throw new Error(\`Unauthorized: ${endpoint}\`)` → `${label}`, the "Invalid JSON response from ${endpoint}" → `${label}`). The `localStorage`/reload 401 logic stays identical.

- [ ] **Step 3: Add `fetchAtNode`**

After `fetchUrl`, add:

```typescript
/**
 * Like fetchApi but routes the call to a specific VM's node. Resolves the URL
 * relative to the central (ignoring the global node selector), so a self VM
 * stays local and a remote VM goes through /api/proxy/<node>.
 */
export async function fetchAtNode<T>(
  node: string | null | undefined,
  isSelf: boolean | undefined,
  endpoint: string,
  options?: RequestInit,
): Promise<T> {
  const path = nodeEndpoint(node, isSelf, endpoint)
  return fetchUrl<T>(getLocalApiUrl(path), endpoint, options)
}
```

- [ ] **Step 4: Verify `nodeEndpoint` logic + types**

Run:
```bash
cd AppImage && node -e '
const f = (node,isSelf,ep) => { const n = ep.startsWith("/")?ep:"/"+ep; return (!node||isSelf)?n:"/api/proxy/"+encodeURIComponent(node)+n; };
console.assert(f(null,undefined,"/api/vms/1/control")==="/api/vms/1/control","self/none");
console.assert(f("pve2",true,"/api/vms/1")==="/api/vms/1","isSelf overrides node");
console.assert(f("pve2",false,"/api/vms/1/control")==="/api/proxy/pve2/api/vms/1/control","remote");
console.assert(f("a b",false,"/api/vms/1")==="/api/proxy/a%20b/api/vms/1","encodes node");
console.log("nodeEndpoint logic OK");
'
npx tsc --noEmit 2>&1 | grep "lib/api-config.ts" | head
```
Expected: `nodeEndpoint logic OK`, and no type errors in `lib/api-config.ts`.

- [ ] **Step 5: Commit**

```bash
git add AppImage/lib/api-config.ts
git commit -m "feat(vms-all-nodes): node-aware fetch helpers (fetchAtNode/fetchUrl/nodeEndpoint)"
```

---

## Phase 2 — VMs list: aggregated source, node badge, node filter

### Task 2: Types + data source

**Files:**
- Modify: `AppImage/components/virtual-machines.tsx`

- [ ] **Step 1: Add `_node`/`_node_is_self` to VMData**

In the `VMData` interface, change the `app_update?: AppUpdate` line (added earlier) to also include node fields:

```tsx
  app_update?: AppUpdate
  _node?: string
  _node_is_self?: boolean
```

- [ ] **Step 2: Import the node-aware fetch + switch the SWR source**

Change the import line `import { fetchApi } from "../lib/api-config"` to:

```tsx
import { fetchApi, fetchAtNode } from "../lib/api-config"
```

Replace the SWR hook (`virtual-machines.tsx:599-605`):

```tsx
  } = useSWR<VMData[]>("/api/vms", fetcher, {
    refreshInterval: 2500,
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
    dedupingInterval: 1000,
    errorRetryCount: 2,
  })
```

with:

```tsx
  } = useSWR<VMData[]>(
    "/api/federation/vms",
    (url: string) => fetchApi<{ vms: VMData[] }>(url).then((d) => d.vms || []),
    {
      refreshInterval: 8000,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
      dedupingInterval: 2000,
      errorRetryCount: 2,
    },
  )
```

- [ ] **Step 3: Build check**

Run: `cd AppImage && npx tsc --noEmit 2>&1 | grep "virtual-machines.tsx" | grep -v "Property '(success|update_available|health)' does not exist" | head`
Expected: no new errors from these two edits.

- [ ] **Step 4: Commit**

```bash
git add AppImage/components/virtual-machines.tsx
git commit -m "feat(vms-all-nodes): aggregate VM list from /api/federation/vms"
```

---

### Task 3: Node filter + node badge

**Files:**
- Modify: `AppImage/components/virtual-machines.tsx`

- [ ] **Step 1: Add the node-filter state + derived list**

Find where `safeVMData` is defined (the `vmData ?? []`-style array used by the `.map` at line 1493). Just before the render of the list, add the filter state and apply it. Add near the other `useState` hooks:

```tsx
  const [nodeFilter, setNodeFilter] = useState<string | null>(null)
```

Then where `safeVMData` is computed, derive the node list and filtered set. Locate the existing `const safeVMData = ...` and replace it with:

```tsx
  const allVMData = Array.isArray(vmData) ? vmData : []
  const nodeNames = Array.from(new Set(allVMData.map((v) => v._node).filter(Boolean))) as string[]
  const safeVMData = nodeFilter ? allVMData.filter((v) => v._node === nodeFilter) : allVMData
```

(If the current name isn't `safeVMData`, apply the same `nodeFilter` filtering to whatever array the `.map(` at line 1493 iterates.)

- [ ] **Step 2: Render the node filter chips above the list**

Immediately before the `{safeVMData.map((vm) => {` block (line 1493), add (only shown when there's more than one node):

```tsx
        {nodeNames.length > 1 && (
          <div className="flex items-center gap-2 flex-wrap mb-3">
            <span className="text-xs text-muted-foreground">Node:</span>
            <button
              onClick={() => setNodeFilter(null)}
              className={`text-xs px-2 py-0.5 rounded-full border ${nodeFilter === null ? "bg-blue-500/15 text-blue-400 border-blue-500/30" : "border-border text-muted-foreground"}`}
            >
              All
            </button>
            {nodeNames.map((n) => (
              <button
                key={n}
                onClick={() => setNodeFilter(n)}
                className={`text-xs px-2 py-0.5 rounded-full border ${nodeFilter === n ? "bg-blue-500/15 text-blue-400 border-blue-500/30" : "border-border text-muted-foreground"}`}
              >
                {n}
              </button>
            ))}
          </div>
        )}
```

- [ ] **Step 3: Add a Node badge on each card (desktop + mobile)**

Desktop: in the row header (after the type badge, near line 1518), add:

```tsx
                    {vm._node && nodeNames.length > 1 && (
                      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-muted/60 text-muted-foreground flex-shrink-0">
                        <Server className="h-3 w-3" />{vm._node}
                      </span>
                    )}
```

Mobile: in the mobile header (after the type badge, near line 1638), add the same snippet.

(`Server` from `lucide-react` — confirm it's imported in this file; if not, add it to the existing `lucide-react` import.)

- [ ] **Step 4: Build check**

Run: `cd AppImage && npx tsc --noEmit 2>&1 | grep "virtual-machines.tsx" | grep -v "Property '(success|update_available|health)' does not exist" | head; npm run build 2>&1 | tail -3`
Expected: no new type errors; build compiles + exports.

- [ ] **Step 5: Commit**

```bash
git add AppImage/components/virtual-machines.tsx
git commit -m "feat(vms-all-nodes): node badge + node filter on the VM list"
```

---

## Phase 3 — Route per-VM calls to the VM's node

### Task 4: Refactor the modal/action call sites

**Files:**
- Modify: `AppImage/components/virtual-machines.tsx`

For each call site, replace `fetchApi(<endpoint>, opts)` with `fetchAtNode(<node>, <isSelf>, <endpoint>, opts)`. Modal call sites use `selectedVM?._node, selectedVM?._node_is_self`; list call sites use the in-scope `vm`/`lxc`.

- [ ] **Step 1: Detail fetch in `handleVMClick` (line 806)**

```tsx
      const details = await fetchAtNode(vm._node, vm._node_is_self, `/api/vms/${vm.vmid}`)
      setVMDetails(details)
```

- [ ] **Step 2: LXC IP batch detail (line 716)**

```tsx
                const details = await fetchAtNode<any>(lxc._node, lxc._node_is_self, `/api/vms/${lxc.vmid}`)
```

- [ ] **Step 3: Mount points (line 823)**

This call is `fetchApi<T>(\`/api/lxc/${vmid}/mount-points\`)` where `T` is the existing inline response type. Change **only** the function name and prepend the two node args — keep `<T>` and the endpoint string exactly as they are:

```tsx
// before:  fetchApi<T>(`/api/lxc/${vmid}/mount-points`)
// after:
fetchAtNode<T>(selectedVM?._node, selectedVM?._node_is_self, `/api/lxc/${vmid}/mount-points`)
```

- [ ] **Step 4: Backups GET (line 866)**

```tsx
      const response = await fetchAtNode<any>(selectedVM?._node, selectedVM?._node_is_self, `/api/vms/${vmid}/backups`)
```

- [ ] **Step 5: Firewall log (line 890)**

```tsx
      }>(selectedVM?._node, selectedVM?._node_is_self, `/api/vms/${vmid}/firewall/log?limit=500`)
```
i.e. change `fetchApi<...>(\`/api/vms/${vmid}/firewall/log?limit=500\`)` → `fetchAtNode<...>(selectedVM?._node, selectedVM?._node_is_self, \`/api/vms/${vmid}/firewall/log?limit=500\`)` keeping the inline type.

- [ ] **Step 6: Backup POST (line 926)**

```tsx
      await fetchAtNode(selectedVM._node, selectedVM._node_is_self, `/api/vms/${selectedVM.vmid}/backup`, {
        method: "POST",
        body: JSON.stringify({
          storage: selectedBackupStorage,
          mode: backupMode,
          compress: "zstd",
          protected: backupProtected,
          notification: backupNotification,
          notes: backupNotes,
          pbs_change_detection: backupPbsChangeMode
        }),
      })
```

- [ ] **Step 7: Control POST (line 954)**

```tsx
      await fetchAtNode(selectedVM?._node, selectedVM?._node_is_self, `/api/vms/${vmid}/control`, {
        method: "POST",
        body: JSON.stringify({ action }),
      })
```

- [ ] **Step 8: Logs (line 982)**

```tsx
      const data = await fetchAtNode<any>(selectedVM?._node, selectedVM?._node_is_self, `/api/vms/${vmid}/logs`)
```

- [ ] **Step 9: Description PUT (line 1219)**

```tsx
      await fetchAtNode(selectedVM._node, selectedVM._node_is_self, `/api/vms/${selectedVM.vmid}/description`, {
        method: "PUT",
        body: JSON.stringify({
          description: editedNotes,
        }),
      })
```

- [ ] **Step 10: Confirm no stray per-VM `fetchApi`**

Run:
```bash
cd AppImage && grep -nE 'fetchApi\(`?/api/(vms|lxc)/' components/virtual-machines.tsx
```
Expected: no output (all per-VM calls now go through `fetchAtNode`).

- [ ] **Step 11: Build + commit**

```bash
cd AppImage && npx tsc --noEmit 2>&1 | grep "virtual-machines.tsx" | grep -v "Property '(success|update_available|health)' does not exist" | head; npm run build 2>&1 | tail -3
git add AppImage/components/virtual-machines.tsx
git commit -m "feat(vms-all-nodes): route per-VM actions to the VM's node"
```

---

## Phase 4 — Child components: metrics + app panel

### Task 5: metrics-dialog node-aware

**Files:**
- Modify: `AppImage/components/metrics-dialog.tsx`
- Modify: `AppImage/components/virtual-machines.tsx` (the `<MetricsView>` invocation, line ~3096)

- [ ] **Step 1: Add node props**

In `metrics-dialog.tsx`, extend `MetricsViewProps` (line 10):

```tsx
interface MetricsViewProps {
  vmid: number
  vmName: string
  vmType: "qemu" | "lxc"
  node?: string
  isSelf?: boolean
  onBack: () => void
}
```

Destructure them in the component signature (add `node, isSelf` alongside `vmid, vmName, vmType, onBack`).

- [ ] **Step 2: Route the metrics fetch (line 122)**

Change the import to include `fetchAtNode` (e.g. `import { fetchApi, fetchAtNode } from "../lib/api-config"` — keep whatever else is imported), and replace:

```tsx
      const result = await fetchAtNode<any>(node, isSelf, `/api/vms/${vmid}/metrics?timeframe=${timeframe}`)
```

- [ ] **Step 3: Pass the props from the modal (virtual-machines.tsx ~3096)**

```tsx
              <MetricsView
                vmid={selectedVM.vmid}
                vmName={selectedVM.name}
                vmType={selectedVM.type as "qemu" | "lxc"}
                node={selectedVM._node}
                isSelf={selectedVM._node_is_self}
                onBack={handleBackToMain}
              />
```

- [ ] **Step 4: Build + commit**

```bash
cd AppImage && npx tsc --noEmit 2>&1 | grep -E "metrics-dialog|virtual-machines" | grep -v "Property '(success|update_available|health)' does not exist" | head; npm run build 2>&1 | tail -3
git add AppImage/components/metrics-dialog.tsx AppImage/components/virtual-machines.tsx
git commit -m "feat(vms-all-nodes): node-aware metrics dialog"
```

---

### Task 6: lxc-app-panel node-aware

**Files:**
- Modify: `AppImage/components/lxc-app-panel.tsx`
- Modify: `AppImage/components/virtual-machines.tsx` (the `<LxcAppPanel>` invocation)

- [ ] **Step 1: Add node props**

In `lxc-app-panel.tsx`, change the import to add `fetchAtNode` (`import { fetchApi, fetchAtNode } from "../lib/api-config"`) and the props (line 54):

```tsx
export function LxcAppPanel({
  vmid,
  node,
  isSelf,
  appUpdate,
  onChanged,
}: {
  vmid: number
  node?: string
  isSelf?: boolean
  appUpdate?: AppUpdate
  onChanged?: () => void
}) {
```

- [ ] **Step 2: Route the 4 per-VM calls**

- Line 78: `fetchAtNode<{ assignment: any }>(node, isSelf, \`/api/vms/${vmid}/app\`)`
- Line 92: `fetchAtNode<{ app_update: AppUpdate }>(node, isSelf, \`/api/vms/${vmid}/app\`, { method: "POST", body: JSON.stringify(body) })`
- Line 107: `fetchAtNode<{ app_update: AppUpdate }>(node, isSelf, \`/api/vms/${vmid}/app/check\`, { method: "POST" })`
- Line 119: `fetchAtNode(node, isSelf, \`/api/vms/${vmid}/app\`, { method: "DELETE" })`

(The catalog call at line 75 stays `fetchApi("/api/lxc-app-catalog")`.)

- [ ] **Step 3: Pass props from the modal**

In `virtual-machines.tsx`, the `<LxcAppPanel ... />` (the App tab content added earlier) becomes:

```tsx
              <LxcAppPanel
                vmid={selectedVM.vmid}
                node={selectedVM._node}
                isSelf={selectedVM._node_is_self}
                appUpdate={selectedVM.app_update}
                onChanged={() => mutate()}
              />
```

- [ ] **Step 4: Build + commit**

```bash
cd AppImage && npx tsc --noEmit 2>&1 | grep -E "lxc-app-panel|virtual-machines" | grep -v "Property '(success|update_available|health)' does not exist" | head; npm run build 2>&1 | tail -3
git add AppImage/components/lxc-app-panel.tsx AppImage/components/virtual-machines.tsx
git commit -m "feat(vms-all-nodes): node-aware LXC app panel"
```

---

## Phase 5 — Console + cleanup

### Task 7: Disable terminal for remote VMs

**Files:**
- Modify: `AppImage/components/virtual-machines.tsx` (terminal button ~3039-3048)

- [ ] **Step 1: Gate the button on self**

Replace the terminal button block (lines 3038-3049). When the VM is remote (`selectedVM?._node_is_self === false`), show a disabled note instead:

```tsx
                {/* Terminal button for LXC containers - only when running */}
                {selectedVM?.type === "lxc" && selectedVM?.status === "running" && (
                  <div className="mb-3">
                    {selectedVM?._node_is_self === false ? (
                      <div className="text-xs text-muted-foreground border border-border rounded-md p-2">
                        Console is only available on the node itself — switch to {selectedVM._node} to open it.
                      </div>
                    ) : (
                      <Button
                        className="w-full bg-zinc-600/20 border border-zinc-600/50 hover:bg-zinc-600/30 text-foreground"
                        onClick={() => selectedVM && openLxcTerminal(selectedVM.vmid, selectedVM.name)}
                      >
                        <Terminal className="h-4 w-4 mr-2" />
                        Open Terminal
                      </Button>
                    )}
                  </div>
                )}
```

(Keep the exact original `className` of the Button if it differs from the above — copy it from the current file.)

- [ ] **Step 2: Build + commit**

```bash
cd AppImage && npm run build 2>&1 | tail -3
git add AppImage/components/virtual-machines.tsx
git commit -m "feat(vms-all-nodes): disable web console for remote VMs"
```

---

### Task 8: Retire the cluster-vms table

**Files:**
- Delete: `AppImage/components/cluster-vms.tsx`
- Modify: `AppImage/components/proxmox-dashboard.tsx`

- [ ] **Step 1: Unmount it**

In `proxmox-dashboard.tsx`, remove the import `import { ClusterVms } from "./cluster-vms"` and the `<ClusterVms key={...} />` line in the Cluster tab, so the Cluster tab content is just:

```tsx
          <TabsContent value="cluster" className="space-y-4 md:space-y-6 mt-0">
            <ClusterOverview key={`cluster-${componentKey}`} />
          </TabsContent>
```

- [ ] **Step 2: Delete the file**

```bash
git rm AppImage/components/cluster-vms.tsx
```

- [ ] **Step 3: Build + commit**

```bash
cd AppImage && npx tsc --noEmit 2>&1 | grep -E "proxmox-dashboard|cluster-vms" | head; npm run build 2>&1 | tail -3
git add AppImage/components/proxmox-dashboard.tsx
git commit -m "refactor(vms-all-nodes): retire the Cluster-tab guests table (superseded)"
```

---

## Phase 6 — Verify + docs

### Task 9: Manual verification (real cluster)

- [ ] **Step 1:** Reinstall on the central (clean restart: `systemctl stop proxmenux-monitor; sleep 2; ss -lntp | grep ':8008' || echo free`, then the one-liner).
- [ ] **Step 2:** VMs & LXCs tab → confirm it lists guests from **both** nodes with a Node badge; the node-filter chips (All/nodeA/nodeB) narrow the list.
- [ ] **Step 3:** Open a **remote** VM → details, metrics, logs, backups load (routed to its node); start/stop works on it; description edit saves.
- [ ] **Step 4:** Open a **remote** LXC → App tab assign/check works; OS-update info shows; the **console** shows the "switch to <node>" note (disabled).
- [ ] **Step 5:** Stop the peer's Monitor → its guests drop out, local guests still listed; an action on an already-open remote VM surfaces a 502 error without crashing the view.

### Task 10: Docs

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1:** Replace the earlier "unified guests list" bullet (under 2026-06-14) with:

```markdown
- **Cluster — all-nodes VM management:** the VMs & LXCs tab now lists every guest of every node at once (Node badge + per-node filter) and manages any of them in place — details, metrics, logs, backups, start/stop, notes and LXC app assignment are routed to each guest's own node via the reverse proxy. The web console remains node-local. Replaces the earlier read-only cluster guests table.
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(vms-all-nodes): document all-nodes VM management"
```

---

## Self-review notes (for the implementer)

- **`getLocalApiUrl`, not `getApiUrl`**, inside `fetchAtNode` — otherwise a self VM gets proxied to whatever node the global selector points at. The whole point is per-VM routing independent of the selector.
- **`selectedVM` is in scope** at every modal call site, so `selectedVM?._node`/`selectedVM?._node_is_self` is always available; list calls use the in-scope `vm`/`lxc`.
- **Preserve inline generic types** at the fetch sites that use `fetchApi<{...}>(...)` — only the function name and the two leading node args change; keep the response type and the endpoint string identical.
- **Single-node installs** keep working: `/api/federation/vms` returns just the local node (one node → filter/badge hidden), and `fetchAtNode(localNode, true, ...)` resolves to plain local paths.
- **Remote console gap is intentional** — the xterm WebSocket can't be proxied; the note tells the user to switch nodes.
```
