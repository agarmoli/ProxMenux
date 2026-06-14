# Federation System Logs All-Nodes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Convert the System Logs tab into an all-nodes cluster view — logs/events/notifications/backups merged across nodes and re-sorted by time, with a Node badge + local filter, and cluster-summed count cards. Read-only; the only drill-down (task-log download) routes to the event's node.

**Architecture:** Pure frontend migration reusing the Fase 1 aggregator (no backend). The 5 list/count endpoints (`/api/logs`, `/api/backups`, `/api/events`, `/api/notifications`, `/api/logs/counts`) are fetched via `aggregateUrl(...)` with `since_days`/`limit` appended as extra query params (the aggregator forwards any param besides `path`). Each node's entries are flattened into the existing `logs`/`events`/`notifications`/`backups` state, tagged `_node`/`_node_is_self`; the existing `combinedLogs` time-sort then naturally interleaves nodes. The count cards SUM across nodes (errors/warnings are summable, unlike Storage capacity). The task-log download routes via `fetchAtNode(event._node, ...)`.

**Design decisions (decided directly, no brainstorm):**
- Counts = **aggregate sum** across online nodes (respecting the node filter), not per-node cards.
- Node filter = **chips** (consistency with Network/Storage), default All.
- Node-scoped React keys (logs/notifications keys are composite `timestamp+service+...` → collide across nodes; events use `upid` which is unique; backups use `volid`).
- Single-node parity: no peers → no chips/badges, counts = that node, identical to today.

**Tech Stack:** React 19 / Next.js 15 / TS. System Logs uses manual `fetch` + `useEffect` (NOT SWR).

**Spec note:** This phase has no separate spec doc (3rd application of the Network/Storage pattern); the design lives in this header.

**Gates (next.config ignoreBuildErrors:true → build won't fail on types; use BOTH):**
- `cd /home/adrian/code/ProxMenux/AppImage && npm run build` must COMPLETE.
- Scoped types: `npx tsc --noEmit 2>&1 | grep -c "system-logs"` — **baseline is 0 (the file is clean)**. Every commit must keep it at **0** (zero new type errors).
- READ the file around cited lines — they're anchors.

**Shared (Fase 1, `lib/api-config.ts`):** `aggregateUrl(path)`, `fetchApi`, `fetchAtNode(node,isSelf,endpoint)` (node undefined → local call), types `AggregateResponse<T>`/`AggregateNode<T>`.

---

## Task 1: Data layer — fetch via aggregator, flatten+tag, sum counts, node filter

**File:** `AppImage/components/system-logs.tsx`
- Interfaces `SystemLog` (~65-74), `Event` (~44-55), `Notification` (~57-63), `Backup` (~33-42), `CombinedLogEntry` (~76-88)
- Imports (~top), state (~95-126), the load `useEffect` (~130-160), `fetchSystemLogs` (~171-183), `combinedLogs` (~336-352), `filteredCombinedLogs` (~354-371)

- [ ] **Step 1: Tag the entry interfaces.** Add to `SystemLog`, `Event`, `Notification`, `Backup`, AND `CombinedLogEntry`:
```ts
  _node?: string
  _node_is_self?: boolean
```

- [ ] **Step 2: Update the api-config import** (find the line importing `fetchApi` from `../lib/api-config`):
```ts
import { fetchApi, fetchAtNode, aggregateUrl, type AggregateResponse, type AggregateNode } from "../lib/api-config"
```

- [ ] **Step 3: Add node state.** Near the other `useState` (~95-101):
```ts
  const [nodesMeta, setNodesMeta] = useState<AggregateNode<unknown>[]>([])
  const [nodeFilter, setNodeFilter] = useState<string | null>(null)
```

- [ ] **Step 4: Replace the load `Promise.all` + setters (~138-150) with aggregator fetches + flatten/tag/sum.**
```ts
        const [logsRes, backupsRes, eventsRes, notificationsRes, countsRes] = await Promise.all([
          fetchApi<AggregateResponse<{ logs?: SystemLog[] } | SystemLog[]>>(aggregateUrl("/api/logs") + `&since_days=${clampedDays}`),
          fetchApi<AggregateResponse<{ backups?: Backup[] }>>(aggregateUrl("/api/backups")),
          fetchApi<AggregateResponse<{ events?: Event[] }>>(aggregateUrl("/api/events") + `&limit=50`),
          fetchApi<AggregateResponse<{ notifications?: Notification[] }>>(aggregateUrl("/api/notifications")),
          fetchApi<AggregateResponse<{ total: number; errors: number; warnings: number; info: number }>>(aggregateUrl("/api/logs/counts") + `&since_days=${clampedDays}`),
        ])
        if (cancelled) return
        const tag = <T,>(rows: T[] | undefined, n: AggregateNode<unknown>): T[] =>
          (rows ?? []).map((r) => ({ ...r, _node: n.node, _node_is_self: n.is_self }))
        const onlineOf = <T,>(res: AggregateResponse<T>) => res.nodes.filter((n) => n.online)

        setNodesMeta(logsRes.nodes)
        setLogs(onlineOf(logsRes).flatMap((n) => {
          const d = n.data as { logs?: SystemLog[] } | SystemLog[] | null
          const arr = Array.isArray(d) ? d : (d?.logs ?? [])
          return tag(arr, n)
        }))
        setBackups(onlineOf(backupsRes).flatMap((n) => tag(n.data?.backups, n)))
        setEvents(onlineOf(eventsRes).flatMap((n) => tag(n.data?.events, n)))
        setNotifications(onlineOf(notificationsRes).flatMap((n) => tag(n.data?.notifications, n)))
        setLogsCounts(
          countsRes.nodes.reduce(
            (acc, n) => {
              const c = n.data
              if (c) { acc.total += c.total || 0; acc.errors += c.errors || 0; acc.warnings += c.warnings || 0; acc.info += c.info || 0 }
              return acc
            },
            { total: 0, errors: 0, warnings: 0, info: 0 },
          ),
        )
```
(The `clampedDays` const is already computed just above at ~136-137.)

- [ ] **Step 5: Remove the now-unused `fetchSystemLogs` helper** (~171-183) — the logs fetch is inlined above. Grep `fetchSystemLogs` to confirm no other references, then delete it.

- [ ] **Step 6: Thread `_node` into `combinedLogs`** (~336-352). The logs branch spreads `...log` (carries `_node`). The EVENTS branch builds a new object — add `_node`/`_node_is_self`:
```ts
        ...events.map((event) => ({
          timestamp: event.starttime,
          level: event.level,
          service: event.type,
          message: `${event.type}${event.vmid ? ` (VM/CT ${event.vmid})` : ""} - ${event.status}`,
          source: `Node: ${event.node} • User: ${event.user}`,
          isEvent: true,
          eventData: event,
          sortTimestamp: new Date(event.starttime).getTime(),
          _node: event._node,
          _node_is_self: event._node_is_self,
        })),
```

- [ ] **Step 7: Add a Node clause to `filteredCombinedLogs`** (~354-371): add `const matchesNode = !nodeFilter || log._node === nodeFilter` and include `&& matchesNode` in the return; add `nodeFilter` to the `useMemo` deps array.

- [ ] **Step 8: Derive node lists.** Right after `filteredCombinedLogs` (or near the other derived consts), add:
```ts
  const onlineNodeNames = nodesMeta.filter((n) => n.online).map((n) => n.node)
  const offlineNodes = nodesMeta.filter((n) => !n.online)
```

- [ ] **Step 9: Build + scoped tsc.** `npm run build` COMPLETE; `npx tsc --noEmit 2>&1 | grep -c "system-logs"` must not exceed the baseline you recorded. Fix any NEW breakage (e.g. a leftover `fetchSystemLogs` ref). 

- [ ] **Step 10: Commit.**
```bash
git add AppImage/components/system-logs.tsx
git commit -m "feat(logs): fetch via aggregator + flatten/tag/sum across nodes (data layer)"
```

---

## Task 2: Render — Node badge + filter chips + offline banners + task-log routing

**File:** `AppImage/components/system-logs.tsx`
- Logs tab list (~748-899), Backups tab (~902-988), Notifications tab (~991-1044), stat cards (~593-640), filter row (~787), task-log fetch (~264)

- [ ] **Step 1: Node-scoped React keys.** Prefix each list's row key with the node so cross-node duplicates don't collide:
  - Combined logs (the Logs tab `.map`, key currently composite `timestamp+service+pid` ~828): prepend `` `${log._node ?? ""}:` `` to the key.
  - Notifications (~996, composite key): prepend `` `${notification._node ?? ""}:` ``.
  - Backups: key on `volid` — make it `` `${backup._node ?? ""}:${backup.volid}` ``.
  - Events appear inside the combined-logs list (via `eventData`); their key is the combined-log key above. (If events are also rendered standalone, prefix with `_node` there too.)

- [ ] **Step 2: Node badge per row** (only when >1 node). In each rendered row (combined log entry, notification, backup), next to the message/title, add (`Server` from lucide — add to the lucide import if absent):
```tsx
{row._node && onlineNodeNames.length > 1 && (
  <Badge variant="outline" className="flex-shrink-0 bg-muted/60 text-muted-foreground border-border">
    <Server className="h-3 w-3 mr-1" />{row._node}
  </Badge>
)}
```
(replace `row` with the iter var: the combined-log var, `notification`, `backup`.)

- [ ] **Step 3: Node filter chips.** Above the existing filter/search row (~787, or just under the tab header), add:
```tsx
{onlineNodeNames.length > 1 && (
  <div className="flex items-center gap-1.5 mb-3">
    <button
      onClick={() => setNodeFilter(null)}
      className={`text-xs px-2 py-0.5 rounded-full border ${nodeFilter === null ? "bg-blue-500/15 text-blue-400 border-blue-500/30" : "border-border text-muted-foreground"}`}
    >All</button>
    {onlineNodeNames.map((nn) => (
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
    <AlertCircle className="h-3 w-3 text-yellow-500" />
    {n.node} — offline{n.error ? ` (${n.error})` : ""}
  </div>
))}
```
(Use whichever "warning triangle/alert" icon is already imported in this file — check the lucide import; if `AlertCircle` isn't imported, use the alert icon that is.)

- [ ] **Step 4: Apply the node filter to Notifications and Backups lists.** Those tabs render the raw `notifications`/`backups` arrays. Filter by node at render: `notifications.filter((x) => !nodeFilter || x._node === nodeFilter)` and `backups.filter((x) => !nodeFilter || x._node === nodeFilter)`. (The combined logs already filter via Task 1 Step 7.)

- [ ] **Step 5: Route the task-log download to the event's node.** Find the `/api/task-log/${upid}` fetch (~264). It runs in the context of an open event/notification. Route it via `fetchAtNode` on the selected event's node — change `fetchApi`/raw fetch to `fetchAtNode(selectedEvent?._node, selectedEvent?._node_is_self, \`/api/task-log/${upid}\`)`. (If the UPID comes from a notification rather than `selectedEvent`, use that selected entry's `_node`/`_node_is_self`. Read the surrounding code to pick the right tagged entry in scope.)

- [ ] **Step 6: Build + scoped tsc.** `npm run build` COMPLETE; `grep -c system-logs` ≤ baseline.

- [ ] **Step 7: Commit.**
```bash
git add AppImage/components/system-logs.tsx
git commit -m "feat(logs): Node badge + cluster filter chips + offline banners + task-log routing"
```

---

## Task 3: Build the AppImage and verify on the cluster

**Files:** none (build + manual — the real acceptance gate).

- [ ] **Step 1:** On a Proxmox node (the build needs `libupsclient`, absent on WSL): `AppImage/scripts/build_appimage.sh`.
- [ ] **Step 2:** Install on both nodes; open the System Logs tab on the central node.
- [ ] **Step 3:** Verify: logs/events/notifications/backups from BOTH nodes interleaved by time, each row with a Node badge; the cluster count cards (Total/Errors/Warnings/Backups) sum both nodes; the Node filter chips narrow every tab; opening an event's task log downloads from the right node; a stopped peer shows an inline "offline" banner.
- [ ] **Step 4:** Single-node parity: a node with no peers looks identical to before (no chips/badges, counts = that node).
- [ ] **Step 5: Commit the build artifact.**
```bash
git add AppImage/ProxMenux-*.AppImage
git commit -m "build: refresh Monitor AppImage with federation Logs all-nodes [skip ci]"
```

---

## Notes for the executor
- No backend changes. The aggregator forwards `since_days`/`limit` because they are query params other than `path`.
- `fetchAtNode(undefined, undefined, p)` == plain local call → single-node parity is automatic.
- Counts SUM across nodes (don't show per-node count cards).
- Do not touch the global header node selector.
