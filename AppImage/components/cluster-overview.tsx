"use client"

import { useEffect, useState } from "react"
import { Cpu, MemoryStick, Thermometer, Boxes, CircleAlert } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card"
import { fetchApi, getActiveNode, setActiveNode } from "../lib/api-config"

interface NodeSummary {
  node: string
  is_self: boolean
  online: boolean
  error: string | null
  system: {
    cpu_usage?: number
    memory_usage?: number
    temperature?: number | { cpu?: number } | null
  } | null
  health: {
    status?: string
    critical_count?: number
    warning_count?: number
  } | null
  vm_count: number | null
}

function tempValue(t: unknown): number | null {
  if (typeof t === "number") return t
  if (t && typeof t === "object" && typeof (t as any).cpu === "number") return (t as any).cpu
  return null
}

export function ClusterOverview() {
  const [nodes, setNodes] = useState<NodeSummary[]>([])
  const [loading, setLoading] = useState(true)

  const load = () => {
    setLoading(true)
    fetchApi<{ nodes: NodeSummary[] }>("/api/federation/overview")
      .then((d) => setNodes(d.nodes || []))
      .catch(() => setNodes([]))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
    const id = setInterval(load, 30000)
    return () => clearInterval(id)
  }, [])

  const openNode = (n: NodeSummary) => {
    setActiveNode(n.is_self ? null : n.node)
    window.location.reload()
  }

  if (loading && nodes.length === 0) {
    return <div className="text-sm text-muted-foreground p-4">Loading cluster…</div>
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {nodes.map((n) => {
        const alerts =
          (n.health?.critical_count ?? 0) + (n.health?.warning_count ?? 0)
        const temp = tempValue(n.system?.temperature)
        const isActive =
          (getActiveNode() ?? "") === n.node || (n.is_self && !getActiveNode())
        return (
          <Card
            key={n.node}
            className={`cursor-pointer transition-colors hover:border-primary ${
              isActive ? "border-primary" : ""
            } ${!n.online ? "opacity-60" : ""}`}
            onClick={() => openNode(n)}
          >
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center justify-between text-base">
                <span>
                  {n.node}
                  {n.is_self ? " (this node)" : ""}
                </span>
                <span
                  className={`text-xs px-2 py-0.5 rounded-full ${
                    n.online
                      ? "bg-green-500/15 text-green-600"
                      : "bg-red-500/15 text-red-600"
                  }`}
                >
                  {n.online ? "online" : "offline"}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {n.online ? (
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="flex items-center gap-2">
                    <Cpu className="h-4 w-4 text-muted-foreground" />
                    {n.system?.cpu_usage != null ? `${n.system.cpu_usage}%` : "—"}
                  </div>
                  <div className="flex items-center gap-2">
                    <MemoryStick className="h-4 w-4 text-muted-foreground" />
                    {n.system?.memory_usage != null ? `${n.system.memory_usage}%` : "—"}
                  </div>
                  <div className="flex items-center gap-2">
                    <Thermometer className="h-4 w-4 text-muted-foreground" />
                    {temp != null ? `${temp}°C` : "—"}
                  </div>
                  <div className="flex items-center gap-2">
                    <Boxes className="h-4 w-4 text-muted-foreground" />
                    {n.vm_count != null ? `${n.vm_count} VMs/CTs` : "—"}
                  </div>
                  <div className="col-span-2 flex items-center gap-2">
                    <CircleAlert
                      className={`h-4 w-4 ${
                        alerts > 0 ? "text-amber-500" : "text-muted-foreground"
                      }`}
                    />
                    {n.health?.status ?? "—"}
                    {alerts > 0 ? ` · ${alerts} alert(s)` : ""}
                  </div>
                </div>
              ) : (
                <div className="text-sm text-red-600">{n.error || "unreachable"}</div>
              )}
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
