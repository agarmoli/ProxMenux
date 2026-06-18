"use client"

import { useEffect, useState } from "react"
import { SystemOverview } from "./system-overview"
import { fetchApi, getActiveNode } from "../lib/api-config"
import { Server } from "lucide-react"

interface FedNode {
  node: string
  is_self: boolean
  online: boolean
}

export function OverviewLanding() {
  const [nodes, setNodes] = useState<FedNode[] | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchApi<{ nodes?: FedNode[] }>("/api/federation/nodes")
      .then((d) => {
        if (!cancelled) setNodes(d?.nodes ?? [])
      })
      .catch(() => {
        if (!cancelled) setNodes([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Drilled into a specific node (global active node set) → that node's detail.
  if (getActiveNode() !== null) return <SystemOverview />

  const online = (nodes ?? []).filter((n) => n.online)
  // Single node (or still loading) → the normal local detail.
  if (nodes === null || online.length <= 1) return <SystemOverview />

  // Multiple nodes → stack the FULL detail per node.
  return (
    <div className="space-y-8">
      {online.map((n) => (
        <section key={n.node} className="space-y-4">
          <div className="flex items-center gap-2 border-b border-border pb-2">
            <Server className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-lg font-semibold">
              {n.node}
              {n.is_self ? " (this node)" : ""}
            </h2>
          </div>
          <SystemOverview node={n.node} isSelf={n.is_self} />
        </section>
      ))}
    </div>
  )
}
