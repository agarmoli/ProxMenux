"use client"

import { useEffect, useState } from "react"
import { Server } from "lucide-react"
import { fetchApi, getActiveNode, setActiveNode } from "../lib/api-config"

interface FederationNode {
  node: string
  is_self: boolean
  online: boolean
  enabled?: boolean
}

/**
 * Header dropdown to switch the dashboard between cluster nodes.
 * Hidden entirely when no peers are configured (single-node install),
 * so the standalone experience is unchanged.
 */
export function NodeSelector() {
  const [nodes, setNodes] = useState<FederationNode[]>([])
  const [selfName, setSelfName] = useState<string>("")

  useEffect(() => {
    fetchApi<{ nodes: FederationNode[] }>("/api/federation/nodes")
      .then((data) => {
        setNodes(data.nodes || [])
        const self = (data.nodes || []).find((n) => n.is_self)
        if (self) setSelfName(self.node)
      })
      .catch(() => setNodes([]))
  }, [])

  // Only the local node → nothing to switch between.
  if (nodes.length <= 1) return null

  const active = getActiveNode() ?? selfName

  const onChange = (value: string) => {
    // Selecting the self node clears the active-node override.
    setActiveNode(value === selfName ? null : value)
    // Full reload re-fetches every panel against the newly selected node.
    window.location.reload()
  }

  return (
    <div className="flex items-center gap-2">
      <Server className="h-4 w-4 text-muted-foreground" />
      <select
        aria-label="Select cluster node"
        className="bg-background border border-input rounded-md px-2 py-1 text-sm"
        value={active}
        onChange={(e) => onChange(e.target.value)}
      >
        {nodes.map((n) => (
          <option key={n.node} value={n.node} disabled={!n.online && !n.is_self}>
            {n.node}
            {n.is_self ? " (this node)" : ""}
            {!n.online && !n.is_self ? " — offline" : ""}
          </option>
        ))}
      </select>
    </div>
  )
}
