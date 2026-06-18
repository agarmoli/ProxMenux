# Cluster Overview Dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the stacked-per-node Overview with a designed cluster dashboard: aggregated summary band + rich per-node cards + overlaid trend charts (one line per node) + reload-free drill-in to the full `SystemOverview(node)`.

**Architecture:** `overview-landing.tsx` branches single-node → `<SystemOverview/>` vs multi-node → new `<ClusterDashboard/>`. `ClusterDashboard` fetches `/api/federation/overview` + aggregated `/api/storage/summary`, renders the band + per-node cards, and holds a local `expandedNode` state for the drill-in (renders the node-parameterized `<SystemOverview node isSelf/>` + a back button — no `setActiveNode`/reload). New `ClusterMetricsCharts` fetches each node's `/api/node/metrics` and overlays one Recharts line per node. No backend changes.

**Tech Stack:** React 19 / Next.js 15 / TypeScript / SWR / Recharts. No JS test runner — gate is `npm run build` (completes) + scoped `tsc --noEmit` (no NEW errors per file) + manual.

**Spec:** `docs/superpowers/specs/2026-06-14-cluster-overview-dashboard-design.md`

## Global Constraints
- `next.config.mjs` has `ignoreBuildErrors`/`ignoreDuringBuilds: true` → `npm run build` does NOT fail on type/lint errors. Gate per touched file: `npx tsc --noEmit 2>&1 | grep -c "<file>"` must not exceed the pre-edit baseline (capture before). New files must be 0.
- Reuse existing helpers/styles: `fetchApi`, `fetchAtNode`, `aggregateUrl`, `AggregateResponse` from `lib/api-config`; `formatStorage` (GB→string) and card styling patterns from `system-overview.tsx`/`cluster-overview.tsx`; Recharts patterns from `node-metrics-charts.tsx`.
- `SystemOverview` already accepts `{ node?: string; isSelf?: boolean }` and routes via `fetchAtNode` — reuse as-is for the drill-in.
- `/api/node/metrics?timeframe=<t>` only accepts `t ∈ {hour,day,week,month,year}` (400 otherwise); display labels (1h/24h/…) map to those tokens.

---

## Task 1: `ClusterDashboard` — summary band + per-node cards + drill-in; wire landing

**Files:**
- Create: `AppImage/components/cluster-dashboard.tsx`
- Modify: `AppImage/components/overview-landing.tsx`
- Delete: `AppImage/components/cluster-overview.tsx` (obsolete; grep-confirm 0 references first)

**Interfaces:**
- Produces: `export function ClusterDashboard()` (self-fetching; no props). Renders the cluster band + per-node card grid + a `<ClusterMetricsCharts/>` slot (added in Task 2 — for now render nothing in its place), and manages the drill-in.
- Consumes (Task 2): `ClusterMetricsCharts` (added next task).

- [ ] **Step 1: Create `cluster-dashboard.tsx` with data + types.**
```tsx
"use client"

import { useState } from "react"
import useSWR from "swr"
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card"
import { Badge } from "./ui/badge"
import { Button } from "./ui/button"
import { Server, ArrowLeft, Cpu, MemoryStick, Thermometer, Boxes, HardDrive, Clock } from "lucide-react"
import { SystemOverview } from "./system-overview"
import { fetchApi, aggregateUrl, type AggregateResponse } from "../lib/api-config"
import { formatStorage } from "../lib/format" // if formatStorage lives elsewhere, import from where system-overview imports it

interface NodeSummary {
  node: string
  is_self: boolean
  online: boolean
  error: string | null
  system: {
    cpu_usage?: number
    memory_usage?: number
    memory_used?: number   // GB
    memory_total?: number  // GB
    temperature?: number | { cpu?: number } | null
    uptime?: string
  } | null
  health: { status?: string; critical_count?: number; warning_count?: number } | null
  vm_count: number | null
}

interface StorageSummary { total: number; used: number; available: number; disk_count: number } // total=TB, used/available=GB

const STATUS_RANK: Record<string, number> = { CRITICAL: 3, WARNING: 2, UNKNOWN: 1, OK: 0 }
const tempNum = (t: NodeSummary["system"]) =>
  typeof t?.temperature === "number" ? t.temperature
  : (t?.temperature && typeof t.temperature === "object" ? t.temperature.cpu ?? 0 : 0)

export function ClusterDashboard() {
  const [expanded, setExpanded] = useState<{ node: string; isSelf: boolean } | null>(null)

  const { data: ov } = useSWR<{ nodes: NodeSummary[] }>(
    "/api/federation/overview",
    (u: string) => fetchApi(u),
    { refreshInterval: 20000 },
  )
  const { data: stoAgg } = useSWR<AggregateResponse<StorageSummary>>(
    aggregateUrl("/api/storage/summary"),
    (u: string) => fetchApi(u),
    { refreshInterval: 30000 },
  )

  if (expanded) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={() => setExpanded(null)} className="gap-2">
          <ArrowLeft className="h-4 w-4" /> Cluster
        </Button>
        <div className="flex items-center gap-2 border-b border-border pb-2">
          <Server className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">{expanded.node}{expanded.isSelf ? " (this node)" : ""}</h2>
        </div>
        <SystemOverview node={expanded.node} isSelf={expanded.isSelf} />
      </div>
    )
  }

  const nodes = ov?.nodes ?? []
  const onlineNodes = nodes.filter((n) => n.online && n.system)
  const offlineNodes = nodes.filter((n) => !n.online)
  // storage per node (normalize total TB -> GB)
  const stoByNode = new Map<string, { used: number; totalGB: number }>()
  for (const n of stoAgg?.nodes ?? []) {
    if (n.online && n.data) stoByNode.set(n.node, { used: n.data.used ?? 0, totalGB: (n.data.total ?? 0) * 1024 })
  }

  // ── cluster band aggregates ──
  const avgCpu = onlineNodes.length
    ? onlineNodes.reduce((a, n) => a + (n.system!.cpu_usage ?? 0), 0) / onlineNodes.length : 0
  const ramUsed = onlineNodes.reduce((a, n) => a + (n.system!.memory_used ?? 0), 0)
  const ramTotal = onlineNodes.reduce((a, n) => a + (n.system!.memory_total ?? 0), 0)
  const guests = onlineNodes.reduce((a, n) => a + (n.vm_count ?? 0), 0)
  const stoUsed = [...stoByNode.values()].reduce((a, s) => a + s.used, 0)
  const stoTotal = [...stoByNode.values()].reduce((a, s) => a + s.totalGB, 0)
  const alerts = onlineNodes.reduce((a, n) => a + (n.health?.critical_count ?? 0) + (n.health?.warning_count ?? 0), 0)
  const worst = onlineNodes.reduce((w, n) => {
    const s = (n.health?.status ?? "OK").toUpperCase()
    return (STATUS_RANK[s] ?? 0) > (STATUS_RANK[w] ?? 0) ? s : w
  }, "OK")
  const worstColor = worst === "CRITICAL" ? "text-red-500" : worst === "WARNING" ? "text-yellow-500" : "text-green-500"

  return (
    <div className="space-y-6">
      {/* ── Cluster summary band ── */}
      <Card className="bg-card border-border">
        <CardContent className="py-4 flex flex-wrap items-center gap-x-8 gap-y-3">
          <div><div className="text-xs text-muted-foreground">CPU (avg)</div><div className="text-xl font-bold">{avgCpu.toFixed(0)}%</div></div>
          <div><div className="text-xs text-muted-foreground">Memory</div><div className="text-xl font-bold">{ramTotal ? Math.round((ramUsed / ramTotal) * 100) : 0}%</div><div className="text-[10px] text-muted-foreground">{formatStorage(ramUsed)} / {formatStorage(ramTotal)}</div></div>
          <div><div className="text-xs text-muted-foreground">Guests</div><div className="text-xl font-bold">{guests}</div></div>
          <div><div className="text-xs text-muted-foreground">Storage</div><div className="text-xl font-bold">{stoTotal ? Math.round((stoUsed / stoTotal) * 100) : 0}%</div><div className="text-[10px] text-muted-foreground">{formatStorage(stoUsed)} / {formatStorage(stoTotal)}</div></div>
          <div><div className="text-xs text-muted-foreground">Health</div><div className={`text-xl font-bold ${worstColor}`}>{worst}{alerts ? ` · ${alerts}` : ""}</div></div>
          <div className="ml-auto text-xs text-muted-foreground">{onlineNodes.length} online{offlineNodes.length ? ` · ${offlineNodes.length} offline` : ""}</div>
        </CardContent>
      </Card>

      {/* ── Per-node cards ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
        {onlineNodes.map((n) => {
          const sto = stoByNode.get(n.node)
          const hs = (n.health?.status ?? "OK").toUpperCase()
          const hColor = hs === "CRITICAL" ? "bg-red-500/10 text-red-500 border-red-500/20" : hs === "WARNING" ? "bg-yellow-500/10 text-yellow-500 border-yellow-500/20" : "bg-green-500/10 text-green-500 border-green-500/20"
          return (
            <Card key={n.node} className="bg-card border-border cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => setExpanded({ node: n.node, isSelf: n.is_self })}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-base flex items-center gap-2"><Server className="h-4 w-4 text-muted-foreground" />{n.node}{n.is_self ? " (this node)" : ""}</CardTitle>
                <Badge variant="outline" className={hColor}>{hs}</Badge>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <div className="flex items-center gap-1"><Cpu className="h-3.5 w-3.5 text-muted-foreground" />{(n.system!.cpu_usage ?? 0).toFixed(0)}%</div>
                <div className="flex items-center gap-1"><MemoryStick className="h-3.5 w-3.5 text-muted-foreground" />{(n.system!.memory_usage ?? 0).toFixed(0)}%</div>
                <div className="flex items-center gap-1"><Thermometer className="h-3.5 w-3.5 text-muted-foreground" />{tempNum(n.system) || "—"}{tempNum(n.system) ? "°C" : ""}</div>
                <div className="flex items-center gap-1"><Boxes className="h-3.5 w-3.5 text-muted-foreground" />{n.vm_count ?? 0} guests</div>
                <div className="flex items-center gap-1"><HardDrive className="h-3.5 w-3.5 text-muted-foreground" />{sto ? `${formatStorage(sto.used)} / ${formatStorage(sto.totalGB)}` : "—"}</div>
                <div className="flex items-center gap-1"><Clock className="h-3.5 w-3.5 text-muted-foreground" />{n.system!.uptime ?? "—"}</div>
              </CardContent>
            </Card>
          )
        })}
        {offlineNodes.map((n) => (
          <Card key={n.node} className="bg-card border-border opacity-60">
            <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Server className="h-4 w-4" />{n.node}</CardTitle></CardHeader>
            <CardContent className="text-sm text-muted-foreground">offline{n.error ? ` — ${n.error}` : ""}</CardContent>
          </Card>
        ))}
      </div>

      {/* ClusterMetricsCharts slot — added in Task 2 */}
    </div>
  )
}
```
IMPORTANT: verify where `formatStorage` is imported from in `system-overview.tsx` (it's a shared util — match that import path exactly; do NOT invent `../lib/format`). If lucide icon names differ, adjust. The card styling mirrors `cluster-overview.tsx`/`system-overview.tsx` — tweak class names to match the repo's look.

- [ ] **Step 2: Rewrite `overview-landing.tsx` to use ClusterDashboard.** Replace the multi-node branch (the `online.map(... <SystemOverview .../> ...)` block) with `<ClusterDashboard />`. Keep the `getActiveNode() !== null → <SystemOverview/>` and `online.length <= 1 → <SystemOverview/>` branches. Add `import { ClusterDashboard } from "./cluster-dashboard"`; remove the now-unused `Server`/`SystemOverview` imports only if no longer used (SystemOverview is still used in the single-node branches — keep it; `Server` is no longer used here — remove).

- [ ] **Step 3: Delete the obsolete simple-cards component.** `grep -rn "cluster-overview\|ClusterOverview" AppImage/` — confirm the ONLY hits are the file itself. Then `git rm AppImage/components/cluster-overview.tsx`.

- [ ] **Step 4: Build + scoped tsc.** `cd AppImage && npm run build` → COMPLETE. `npx tsc --noEmit 2>&1 | grep -cE "cluster-dashboard|overview-landing"` → 0 (new/clean files). Fix any NEW errors (likely the `formatStorage` import path).

- [ ] **Step 5: Commit.**
```bash
git add AppImage/components/cluster-dashboard.tsx AppImage/components/overview-landing.tsx
git rm AppImage/components/cluster-overview.tsx 2>/dev/null; git add -A AppImage/components/cluster-overview.tsx 2>/dev/null
git commit -m "feat(overview): cluster dashboard — summary band + per-node cards + reload-free drill-in"
```

---

## Task 2: `ClusterMetricsCharts` — overlaid trend charts (one line per node)

**Files:**
- Create: `AppImage/components/cluster-metrics-charts.tsx`
- Modify: `AppImage/components/cluster-dashboard.tsx` (render it in the slot)

**Interfaces:**
- Consumes: a node list `{ node: string; is_self: boolean }[]` (pass the online nodes from ClusterDashboard).
- Produces: `export function ClusterMetricsCharts({ nodes }: { nodes: { node: string; is_self: boolean }[] })`.

- [ ] **Step 1: Create `cluster-metrics-charts.tsx`.** Fetch each node's metrics, merge by `time`, render 3 overlaid line charts (CPU%, RAM%, Net throughput).
```tsx
"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select"
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts"
import { fetchAtNode } from "../lib/api-config"

const TIMEFRAMES = [
  { token: "hour", label: "1 Hour" },
  { token: "day", label: "24 Hours" },
  { token: "week", label: "7 Days" },
  { token: "month", label: "30 Days" },
  { token: "year", label: "1 Year" },
]
const COLORS = ["#3b82f6", "#22c55e", "#f59e0b", "#a855f7", "#ef4444", "#06b6d4"]

interface Node { node: string; is_self: boolean }
type Row = { time: number } & Record<string, number>

export function ClusterMetricsCharts({ nodes }: { nodes: Node[] }) {
  const [timeframe, setTimeframe] = useState("day")
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all(
      nodes.map((n) =>
        fetchAtNode<any>(n.node, n.is_self, `/api/node/metrics?timeframe=${timeframe}`)
          .then((r) => ({ node: n.node, data: Array.isArray(r?.data) ? r.data : [] }))
          .catch(() => ({ node: n.node, data: [] as any[] })),
      ),
    ).then((perNode) => {
      if (cancelled) return
      // merge by epoch `time`
      const byTime = new Map<number, Row>()
      for (const { node, data } of perNode) {
        for (const it of data) {
          const t = it.time as number
          if (!byTime.has(t)) byTime.set(t, { time: t } as Row)
          const row = byTime.get(t)!
          row[`cpu_${node}`] = it.cpu != null ? Number((it.cpu * 100).toFixed(1)) : 0
          row[`mem_${node}`] = it.memtotal ? Number(((it.memused / it.memtotal) * 100).toFixed(1)) : 0
          row[`netin_${node}`] = it.netin != null ? Number((it.netin / 1024 / 1024).toFixed(2)) : 0   // MB/s
          row[`netout_${node}`] = it.netout != null ? Number((it.netout / 1024 / 1024).toFixed(2)) : 0
        }
      }
      setRows([...byTime.values()].sort((a, b) => a.time - b.time))
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [timeframe, JSON.stringify(nodes.map((n) => n.node))])

  const tick = (t: number) => new Date(t * 1000).toLocaleString("en-US",
    timeframe === "hour" || timeframe === "day" ? { hour: "2-digit", minute: "2-digit", hour12: false } : { month: "short", day: "numeric" })

  const chart = (title: string, keyPrefix: string, unit: string) => (
    <Card className="bg-card border-border">
      <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle></CardHeader>
      <CardContent>
        <div className="h-[220px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="time" tickFormatter={tick} tick={{ fontSize: 11 }} minTickGap={40} />
              <YAxis tick={{ fontSize: 11 }} unit={unit} />
              <Tooltip labelFormatter={(t) => tick(t as number)} />
              <Legend />
              {nodes.map((n, i) => (
                <Line key={n.node} type="monotone" dataKey={`${keyPrefix}_${n.node}`} name={n.node}
                      stroke={COLORS[i % COLORS.length]} dot={false} strokeWidth={1.5} isAnimationActive={false} connectNulls />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  )

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Select value={timeframe} onValueChange={setTimeframe}>
          <SelectTrigger className="w-[160px] bg-card border-border"><SelectValue /></SelectTrigger>
          <SelectContent>{TIMEFRAMES.map((t) => <SelectItem key={t.token} value={t.token}>{t.label}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      {chart("CPU %", "cpu", "%")}
      {chart("Memory %", "mem", "%")}
      {chart("Network in (MB/s)", "netin", "")}
      {loading && <div className="text-xs text-muted-foreground">Loading metrics…</div>}
    </div>
  )
}
```
(Net: shows inbound MB/s overlaid per node; if you also want outbound, add a 4th `chart("Network out (MB/s)", "netout", "")`. Keep it to in for now per YAGNI — adjust if the design wants both.)

- [ ] **Step 2: Render it in `ClusterDashboard`.** Import `ClusterMetricsCharts`; replace the `{/* ClusterMetricsCharts slot */}` comment with:
```tsx
      {onlineNodes.length > 0 && (
        <ClusterMetricsCharts nodes={onlineNodes.map((n) => ({ node: n.node, is_self: n.is_self }))} />
      )}
```

- [ ] **Step 3: Build + scoped tsc.** `npm run build` → COMPLETE. `npx tsc --noEmit 2>&1 | grep -cE "cluster-metrics-charts|cluster-dashboard"` → 0.

- [ ] **Step 4: Commit.**
```bash
git add AppImage/components/cluster-metrics-charts.tsx AppImage/components/cluster-dashboard.tsx
git commit -m "feat(overview): overlaid per-node trend charts (CPU/RAM/Net, one line per node)"
```

---

## Task 3: Build the AppImage, commit it, verify

**Files:** `AppImage/ProxMenux-1.2.2.2-beta.AppImage`, `AppImage/ProxMenux-Monitor.AppImage.sha256` (rebuild artifacts).

- [ ] **Step 1: Build.** `bash AppImage/scripts/build_appimage.sh` → `AppImage/dist/ProxMenux-1.2.2.2-beta.AppImage`. (Needs node/python3/pip3/FUSE/libupsclient7 — present on this host.)
- [ ] **Step 2: Verify the new code is in it.**
```bash
cd /tmp && rm -rf v && mkdir v && cd v && /home/adrian/code/ProxMenux/AppImage/dist/ProxMenux-1.2.2.2-beta.AppImage --appimage-extract >/dev/null
grep -rl "ClusterDashboard\|cluster-metrics" squashfs-root/web 2>/dev/null | head   # expect a hit
cd /tmp && rm -rf v
```
- [ ] **Step 3: Replace committed AppImage + sha256, drop pip junk, commit, push.**
```bash
cd /home/adrian/code/ProxMenux
git checkout -- 'AppImage/scripts/=0.6.0' 'AppImage/scripts/=1.7.0' 'AppImage/scripts/=3.0.0' 2>/dev/null
cp -f AppImage/dist/ProxMenux-1.2.2.2-beta.AppImage AppImage/ProxMenux-1.2.2.2-beta.AppImage
sha256sum AppImage/ProxMenux-1.2.2.2-beta.AppImage | awk '{print $1}' > AppImage/ProxMenux-Monitor.AppImage.sha256
git add AppImage/ProxMenux-1.2.2.2-beta.AppImage AppImage/ProxMenux-Monitor.AppImage.sha256
git commit -m "build: rebuild AppImage with cluster Overview dashboard"
git push origin feature/federation
```
- [ ] **Step 4: Manual (user, on the 2 nodes).** Reinstall via the one-liner; on the Overview landing (no node selected): cluster band aggregates correctly; per-node cards show CPU/RAM/temp/guests/uptime/disk; 3 charts draw one line per node and the timeframe re-fetches; click a card → that node's full detail, "← Cluster" returns without reload; offline node greyed; single-node shows the normal Overview.

---

## Notes for the executor
- No backend changes. All data via `/api/federation/overview`, `aggregateUrl('/api/storage/summary')`, and per-node `/api/node/metrics` (through `fetchAtNode`).
- Confirm the real import path of `formatStorage` (used by `system-overview.tsx`) — do not invent one.
- `/api/node/metrics` fields are RRD: `time` (epoch s), `cpu` (0-1), `memused`/`memtotal` (bytes), `netin`/`netout` (bytes/s). Derive %/MB as shown.
- Drill-in is LOCAL state — never call `setActiveNode`/reload (keeps it independent of the global selector / Fase 7).
