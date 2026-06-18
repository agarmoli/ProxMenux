"use client"

import { useState } from "react"
import useSWR from "swr"
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card"
import { Badge } from "./ui/badge"
import { Button } from "./ui/button"
import { Server, ArrowLeft, Cpu, MemoryStick, Thermometer, Boxes, HardDrive, Clock } from "lucide-react"
import { SystemOverview } from "./system-overview"
import { ClusterMetricsCharts } from "./cluster-metrics-charts"
import { fetchApi, aggregateUrl, type AggregateResponse } from "../lib/api-config"
import { formatStorage } from "../lib/utils"

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

      {onlineNodes.length > 0 && (
        <ClusterMetricsCharts nodes={onlineNodes.map((n) => ({ node: n.node, is_self: n.is_self }))} />
      )}
    </div>
  )
}
