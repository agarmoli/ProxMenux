"use client"

import { useEffect, useState } from "react"
import { SystemOverview } from "./system-overview"
import { ClusterDashboard } from "./cluster-dashboard"
import { fetchApi, getActiveNode } from "../lib/api-config"

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

  // Multiple nodes → cluster dashboard (summary band + per-node cards + drill-in).
  return <ClusterDashboard />
}
