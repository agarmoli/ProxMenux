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
