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
