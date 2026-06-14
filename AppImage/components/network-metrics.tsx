"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card"
import { Badge } from "./ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog"
import { Wifi, Activity, Network, Router, AlertCircle, Zap, Timer, Server } from 'lucide-react'
import useSWR from "swr"
import { NetworkTrafficChart } from "./network-traffic-chart"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select"
import { fetchApi, fetchAtNode, aggregateUrl, type AggregateResponse, type AggregateNode } from "../lib/api-config"
import { formatNetworkTraffic, getNetworkUnit } from "../lib/format-network"
import { LatencyDetailModal } from "./latency-detail-modal"
import { AreaChart, Area, LineChart, Line, ResponsiveContainer, YAxis } from "recharts"

interface NetworkData {
  interfaces: NetworkInterface[]
  physical_interfaces?: NetworkInterface[]
  bridge_interfaces?: NetworkInterface[]
  vm_lxc_interfaces?: NetworkInterface[]
  traffic: {
    bytes_sent: number
    bytes_recv: number
    packets_sent?: number
    packets_recv?: number
    packet_loss_in?: number
    packet_loss_out?: number
    dropin?: number
    dropout?: number
    errin?: number
    errout?: number
  }
  active_count?: number
  total_count?: number
  physical_active_count?: number
  physical_total_count?: number
  bridge_active_count?: number
  bridge_total_count?: number
  vm_lxc_active_count?: number
  vm_lxc_total_count?: number
  hostname?: string
  domain?: string
  dns_servers?: string[]
}

interface NetworkInterface {
  name: string
  type: string
  status: string
  speed: number
  duplex: string
  mtu: number
  mac_address: string | null
  addresses: Array<{
    ip: string
    netmask: string
  }>
  bytes_sent?: number
  bytes_recv?: number
  packets_sent?: number
  packets_recv?: number
  errors_in?: number
  errors_out?: number
  drops_in?: number
  drops_out?: number
  bond_mode?: string
  bond_slaves?: string[]
  bond_active_slave?: string | null
  bridge_members?: string[]
  bridge_physical_interface?: string
  bridge_bond_slaves?: string[]
  packet_loss_in?: number
  packet_loss_out?: number
  vmid?: number
  vm_name?: string
  vm_type?: string
  vm_status?: string
  _node?: string
  _node_is_self?: boolean
}

const getInterfaceTypeBadge = (type: string) => {
  switch (type) {
    case "physical":
      return { color: "bg-blue-500/10 text-blue-500 border-blue-500/20", label: "Physical" }
    case "bridge":
      return { color: "bg-green-500/10 text-green-500 border-green-500/20", label: "Bridge" }
    case "bond":
      return { color: "bg-purple-500/10 text-purple-500 border-purple-500/20", label: "Bond" }
    case "vlan":
      return { color: "bg-cyan-500/10 text-cyan-500 border-cyan-500/20", label: "VLAN" }
    case "vm_lxc":
      return { color: "bg-orange-500/10 text-orange-500 border-orange-500/20", label: "Virtual" }
    case "virtual":
      return { color: "bg-orange-500/10 text-orange-500 border-orange-500/20", label: "Virtual" }
    default:
      return { color: "bg-gray-500/10 text-gray-500 border-gray-500/20", label: "Unknown" }
  }
}

const getVMTypeBadge = (vmType: string | undefined) => {
  if (vmType === "lxc") {
    return { color: "bg-cyan-500/10 text-cyan-500 border-cyan-500/20", label: "LXC" }
  } else if (vmType === "vm") {
    return { color: "bg-purple-500/10 text-purple-500 border-purple-500/20", label: "VM" }
  }
  return { color: "bg-gray-500/10 text-gray-500 border-gray-500/20", label: "Unknown" }
}

const formatBytes = (bytes: number | undefined): string => {
  if (!bytes || bytes === 0) return "0 B"
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`
}

const formatStorage = (bytes: number): string => {
  if (bytes === 0) return "0 B"
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB", "TB", "PB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  const value = bytes / Math.pow(k, i)

  // Use 1 decimal place for values >= 10, 2 decimal places for values < 10
  const decimals = value >= 10 ? 1 : 2
  return `${value.toFixed(decimals)} ${sizes[i]}`
}

const formatSpeed = (speed: number): string => {
  if (speed === 0) return "N/A"
  if (speed >= 1000) return `${(speed / 1000).toFixed(1)} Gbps`
  return `${speed} Mbps`
}

export function NetworkMetrics() {
  const {
    data: agg,
    error,
    isLoading,
  } = useSWR<AggregateResponse<NetworkData>>(
    aggregateUrl("/api/network"),
    (url: string) => fetchApi<AggregateResponse<NetworkData>>(url),
    {
      refreshInterval: 15000,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
    },
  )

  const [selectedInterface, setSelectedInterface] = useState<NetworkInterface | null>(null)
  const [nodeFilter, setNodeFilter] = useState<string | null>(null)
  const [timeframe, setTimeframe] = useState<"hour" | "day" | "week" | "month" | "year">("day")
  const [modalTimeframe, setModalTimeframe] = useState<"hour" | "day" | "week" | "month" | "year">("day")
  const [networkTotals, setNetworkTotals] = useState<{ received: number; sent: number }>({ received: 0, sent: 0 })
  const [interfaceTotals, setInterfaceTotals] = useState<{ received: number; sent: number }>({ received: 0, sent: 0 })
  const [latencyModalOpen, setLatencyModalOpen] = useState(false)

  const [networkUnit, setNetworkUnit] = useState<"Bytes" | "Bits">(() => getNetworkUnit())

  // Derive node info ABOVE all secondary hooks (plain consts, not hooks — allowed before any return)
  const aggNodes = agg?.nodes ?? []
  const onlineNodes = aggNodes.filter((n) => n.online && n.data)
  const offlineNodes = aggNodes.filter((n) => !n.online)
  const nodeNames = onlineNodes.map((n) => n.node)
  // The summary (overview cards, overall traffic chart, latency) reflects ONE
  // node: the filtered node, or the central/first node when "All" is selected.
  const summaryNode = nodeFilter ? onlineNodes.find((n) => n.node === nodeFilter) : onlineNodes[0]

  // Latency history for sparkline (last hour) — routed to summaryNode
  const { data: latencyData } = useSWR<{
    data: Array<{ timestamp: number; value: number }>
    stats: { min: number; max: number; avg: number; current: number }
    target: string
  }>(
    summaryNode ? `latency-history@${summaryNode.node}` : null,
    () => fetchAtNode(summaryNode!.node, summaryNode!.is_self, "/api/network/latency/history?target=gateway&timeframe=hour"),
    { refreshInterval: 60000, revalidateOnFocus: false },
  )

  useEffect(() => {
    setNetworkUnit(getNetworkUnit())

    const handleUnitChange = (e: CustomEvent) => {
      setNetworkUnit(e.detail === "Bits" ? "Bits" : "Bytes")
    }

    window.addEventListener("networkUnitChanged" as any, handleUnitChange)
    return () => window.removeEventListener("networkUnitChanged" as any, handleUnitChange)
  }, [])

  const { data: modalNetworkData } = useSWR<NetworkData>(
    selectedInterface ? `modal-network@${selectedInterface._node ?? "self"}` : null,
    () => fetchAtNode<NetworkData>(selectedInterface!._node, selectedInterface!._node_is_self, "/api/network"),
    { refreshInterval: 17000, revalidateOnFocus: false, revalidateOnReconnect: true },
  )

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
        <div className="relative">
          <div className="h-12 w-12 rounded-full border-2 border-muted"></div>
          <div className="absolute inset-0 h-12 w-12 rounded-full border-2 border-transparent border-t-primary animate-spin"></div>
        </div>
        <div className="text-sm font-medium text-foreground">Loading network data...</div>
        <p className="text-xs text-muted-foreground">Scanning interfaces, bridges and traffic</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="space-y-6">
        <Card className="bg-red-500/10 border-red-500/20">
          <CardContent className="p-6">
            <div className="flex items-center gap-3 text-red-600">
              <AlertCircle className="h-6 w-6" />
              <div>
                <div className="font-semibold text-lg mb-1">Flask Server Not Available</div>
                <div className="text-sm">
                  {error?.message ||
                    "Unable to connect to the Flask server. Please ensure the server is running and try again."}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  const tag = (
    list: NetworkInterface[] | undefined,
    n: AggregateNode<NetworkData>,
  ): NetworkInterface[] =>
    (list ?? []).map((i) => ({ ...i, _node: n.node, _node_is_self: n.is_self }))

  const applyNodeFilter = (xs: NetworkInterface[]) =>
    nodeFilter ? xs.filter((i) => i._node === nodeFilter) : xs

  const mergedPhysical = applyNodeFilter(onlineNodes.flatMap((n) => tag(n.data!.physical_interfaces, n)))
  const mergedBridge = applyNodeFilter(onlineNodes.flatMap((n) => tag(n.data!.bridge_interfaces, n)))
  const mergedVmLxc = applyNodeFilter(onlineNodes.flatMap((n) => tag(n.data!.vm_lxc_interfaces, n)))

  const networkData = summaryNode?.data
  if (!networkData) {
    return (
      <div className="text-sm text-muted-foreground p-6">No network data available.</div>
    )
  }

  const trafficInFormatted = formatNetworkTraffic(
    networkTotals.received * 1024 ** 3,
    networkUnit,
    2
  )
  const trafficOutFormatted = formatNetworkTraffic(
    networkTotals.sent * 1024 ** 3,
    networkUnit,
    2
  )
  const packetsRecvK = networkData.traffic.packets_recv ? (networkData.traffic.packets_recv / 1000).toFixed(0) : "0"

  const totalErrors = (networkData.traffic.errin || 0) + (networkData.traffic.errout || 0)
  const packetLossIn = networkData.traffic.packet_loss_in || 0
  const packetLossOut = networkData.traffic.packet_loss_out || 0
  const avgPacketLoss = ((packetLossIn + packetLossOut) / 2).toFixed(2)

  // Determine health status
  let healthStatus = "Healthy"
  let healthColor = "bg-green-500/10 text-green-500 border-green-500/20"

  if (Number.parseFloat(avgPacketLoss) > 5 || totalErrors > 1000) {
    healthStatus = "Critical"
    healthColor = "bg-red-500/10 text-red-500 border-red-500/20"
  } else if (Number.parseFloat(avgPacketLoss) >= 1 || totalErrors >= 100) {
    healthStatus = "Warning"
    healthColor = "bg-yellow-500/10 text-yellow-500 border-yellow-500/20"
  }

  const physIfacesOfNode = (node?: string): NetworkInterface[] =>
    onlineNodes.find((n) => n.node === node)?.data?.physical_interfaces ?? []

  const vmLxcInterfaces = [...mergedVmLxc].sort((a, b) => {
    const vmidA = a.vmid ?? Number.MAX_SAFE_INTEGER
    const vmidB = b.vmid ?? Number.MAX_SAFE_INTEGER
    return vmidA - vmidB
  })

  const topInterface =
    vmLxcInterfaces.length > 0
      ? vmLxcInterfaces.reduce((top, iface) => {
          const ifaceTraffic = (iface.bytes_recv || 0) + (iface.bytes_sent || 0)
          const topTraffic = (top.bytes_recv || 0) + (top.bytes_sent || 0)
          return ifaceTraffic > topTraffic ? iface : top
        }, vmLxcInterfaces[0])
      : { name: "No VM/LXC", type: "unknown", bytes_recv: 0, bytes_sent: 0, vm_name: "N/A" }

  const topInterfaceTraffic = (topInterface.bytes_recv || 0) + (topInterface.bytes_sent || 0)

  const getTimeframeLabel = () => {
    switch (timeframe) {
      case "hour":
        return "1 Hour"
      case "day":
        return "24 Hours"
      case "week":
        return "7 Days"
      case "month":
        return "30 Days"
      case "year":
        return "1 Year"
      default:
        return "24 Hours"
    }
  }

  // Compact form for inline header use. The full "24 Hours" gets noisy
  // next to the title; "Past 24 h" keeps the same meaning in less space.
  const getTimeframeShortLabel = () => {
    switch (timeframe) {
      case "hour":
        return "Past 1 h"
      case "day":
        return "Past 24 h"
      case "week":
        return "Past 7 d"
      case "month":
        return "Past 30 d"
      case "year":
        return "Past 1 y"
      default:
        return "Past 24 h"
    }
  }

  const hostname = networkData.hostname || "N/A"
  const domain = networkData.domain || "N/A"
  const dnsServers = networkData.dns_servers || []
  const primaryDNS = dnsServers[0] || "N/A"
  const secondaryDNS = dnsServers[1] || "N/A"

  return (
    <div className="space-y-6">
      {/* Node filter chips */}
      {nodeNames.length > 1 && (
        <div className="flex items-center gap-1.5 mb-3">
          <button
            onClick={() => setNodeFilter(null)}
            className={`text-xs px-2 py-0.5 rounded-full border ${nodeFilter === null ? "bg-blue-500/15 text-blue-400 border-blue-500/30" : "border-border text-muted-foreground"}`}
          >All</button>
          {nodeNames.map((n) => (
            <button
              key={n}
              onClick={() => setNodeFilter(n)}
              className={`text-xs px-2 py-0.5 rounded-full border ${nodeFilter === n ? "bg-blue-500/15 text-blue-400 border-blue-500/30" : "border-border text-muted-foreground"}`}
            >{n}</button>
          ))}
        </div>
      )}
      {/* Offline node banners */}
      {offlineNodes.map((n) => (
        <div key={n.node} className="flex items-center gap-2 text-xs text-muted-foreground border border-border rounded-md px-2 py-1 mb-1">
          <AlertCircle className="h-3 w-3 text-yellow-500" />
          {n.node} — offline{n.error ? ` (${n.error})` : ""}
        </div>
      ))}
      {/* Summary node label in multi-node mode */}
      {nodeNames.length > 1 && summaryNode && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Server className="h-3 w-3" />
          Summary for <span className="font-medium text-foreground">{summaryNode.node}</span>
          {summaryNode.is_self ? " (this node)" : ""} — pick a node above to switch
        </div>
      )}
      {/* Network Overview Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 xl:gap-6">
        {/* ── Network Traffic (preview restyle: Down/Up dual headline + stacked bar) ── */}
        {(() => {
          const downBytes = networkData.traffic.bytes_recv || 0
          const upBytes = networkData.traffic.bytes_sent || 0
          const totalBytes = downBytes + upBytes
          const downPct = totalBytes > 0 ? (downBytes / totalBytes) * 100 : 50
          const upPct = totalBytes > 0 ? (upBytes / totalBytes) * 100 : 50
          return (
            <Card className="bg-card border-border">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <div className="flex flex-col gap-0.5 min-w-0">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Network Traffic</CardTitle>
                  <span className="text-[10px] text-muted-foreground/70 font-normal">{getTimeframeShortLabel()}</span>
                </div>
                <Activity className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-3 mb-3">
                  <div>
                    <div className="text-xs font-medium text-muted-foreground mb-1">
                      <span className="text-green-500">↓</span> Down
                    </div>
                    <div className="text-xl lg:text-2xl font-bold leading-tight text-green-500">{trafficInFormatted}</div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-muted-foreground mb-1">
                      <span className="text-blue-500">↑</span> Up
                    </div>
                    <div className="text-xl lg:text-2xl font-bold leading-tight text-blue-500">{trafficOutFormatted}</div>
                  </div>
                </div>
                <div className="flex h-1.5 rounded-full overflow-hidden gap-[2px]">
                  <div style={{ width: `${downPct}%`, background: '#22c55e' }}></div>
                  <div style={{ width: `${upPct}%`, background: '#3b82f6' }}></div>
                </div>
                <div className="mt-2 flex justify-between text-xs text-muted-foreground">
                  <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-green-500"></span>Down {Math.round(downPct)}%</span>
                  <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-blue-500"></span>Up {Math.round(upPct)}%</span>
                </div>
              </CardContent>
            </Card>
          )
        })()}

        {/* ── Active Interfaces (preview restyle v2: revertido al original con title uppercase) ── */}
        <Card className="bg-card border-border">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Active Interfaces</CardTitle>
            <Network className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-xl lg:text-2xl font-bold text-foreground">
              {(networkData.physical_active_count ?? 0) + (networkData.bridge_active_count ?? 0)}
            </div>
            <div className="flex flex-wrap items-center gap-2 mt-2">
              <Badge variant="outline" className="bg-blue-500/10 text-blue-500 border-blue-500/20">
                Physical: {networkData.physical_active_count ?? 0}/{networkData.physical_total_count ?? 0}
              </Badge>
              <Badge variant="outline" className="bg-green-500/10 text-green-500 border-green-500/20">
                Bridges: {networkData.bridge_active_count ?? 0}/{networkData.bridge_total_count ?? 0}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              {(networkData.physical_total_count ?? 0) + (networkData.bridge_total_count ?? 0)} total interfaces
            </p>
          </CardContent>
        </Card>

        {/* ── Network Status (preview restyle: packet-loss highlight + 2x2 grid) ── */}
        <Card className="bg-card border-border">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Network Status</CardTitle>
            <Badge variant="outline" className={`${healthColor}`}>{healthStatus === 'Healthy' ? '✓ ' : ''}{healthStatus}</Badge>
          </CardHeader>
          <CardContent>
            {(() => {
              const lossPct = Number.parseFloat(avgPacketLoss) || 0
              const lossColor =
                lossPct >= 5 ? 'text-red-500' :
                lossPct >= 1 ? 'text-orange-500' :
                lossPct > 0  ? 'text-yellow-500' :
                               'text-blue-500'
              return (
                <div className={`mb-3 text-xl lg:text-2xl font-bold ${lossColor} leading-none`}>
                  {avgPacketLoss}<span className="text-sm font-normal text-muted-foreground">% </span>
                  <span className="text-sm font-normal text-muted-foreground">Packet Loss</span>
                </div>
              )
            })()}
            <div className="grid grid-cols-2 gap-x-3 gap-y-3 pt-3 border-t border-border/50 text-sm">
              <div className="min-w-0">
                <div className="text-muted-foreground">Hostname:</div>
                <div className="font-medium font-mono truncate">{hostname}</div>
              </div>
              <div className="min-w-0">
                <div className="text-muted-foreground">DNS:</div>
                <div className="font-medium font-mono truncate">{primaryDNS}</div>
              </div>
              <div className="min-w-0">
                <div className="text-muted-foreground">Errors:</div>
                <div className="font-medium font-mono">{totalErrors}</div>
              </div>
              <div className="min-w-0">
                <div className="text-muted-foreground">Domain:</div>
                <div className="font-medium font-mono truncate">{networkData.domain || '—'}</div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Latency Card with Sparkline */}
        <Card 
          className="bg-card border-border cursor-pointer hover:bg-muted/50 transition-colors"
          onClick={() => setLatencyModalOpen(true)}
        >
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Network Latency</CardTitle>
            <Timer className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between mb-2">
              <div className="text-xl lg:text-2xl font-bold text-foreground">
                {latencyData?.stats?.current ?? 0} <span className="text-sm font-normal text-muted-foreground">ms</span>
              </div>
              <Badge 
                variant="outline" 
                className={
                  (latencyData?.stats?.current ?? 0) < 50 
                    ? "bg-green-500/10 text-green-500 border-green-500/20"
                    : (latencyData?.stats?.current ?? 0) < 100
                    ? "bg-green-500/10 text-green-500 border-green-500/20"
                    : (latencyData?.stats?.current ?? 0) < 200
                    ? "bg-yellow-500/10 text-yellow-500 border-yellow-500/20"
                    : "bg-red-500/10 text-red-500 border-red-500/20"
                }
              >
                {(latencyData?.stats?.current ?? 0) < 50 ? "Excellent" : 
                 (latencyData?.stats?.current ?? 0) < 100 ? "Good" :
                 (latencyData?.stats?.current ?? 0) < 200 ? "Fair" : "Poor"}
              </Badge>
            </div>
            {/* Sparkline */}
            {latencyData?.data && latencyData.data.length > 0 && (
              <div className="h-[40px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={latencyData.data.slice(-30)} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="latencySparkGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.4} />
                        <stop offset="100%" stopColor="#3b82f6" stopOpacity={0.05} />
                      </linearGradient>
                    </defs>
                    <Area
                      type="monotone"
                      dataKey="value"
                      stroke="#3b82f6"
                      strokeWidth={1.5}
                      fill="url(#latencySparkGradient)"
                      dot={false}
                      isAnimationActive={false}
                      baseValue="dataMin"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
            <p className="text-xs text-muted-foreground mt-1">
              Avg: {latencyData?.stats?.avg ?? 0}ms | Max: {latencyData?.stats?.max ?? 0}ms
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Timeframe Selector */}
      <div className="flex justify-end">
        <Select value={timeframe} onValueChange={(value: any) => setTimeframe(value)}>
          <SelectTrigger className="w-[180px] bg-card border-border">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="hour">1 Hour</SelectItem>
            <SelectItem value="day">24 Hours</SelectItem>
            <SelectItem value="week">7 Days</SelectItem>
            <SelectItem value="month">30 Days</SelectItem>
            <SelectItem value="year">1 Year</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Network Traffic Card with Chart */}
      <Card className="bg-card border-border">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-foreground flex items-center">
            <Activity className="h-5 w-5 mr-2" />
            Network Traffic
          </CardTitle>
        </CardHeader>
        <CardContent>
          <NetworkTrafficChart timeframe={timeframe} onTotalsCalculated={setNetworkTotals} networkUnit={networkUnit} node={summaryNode?.node} isSelf={summaryNode?.is_self} />
        </CardContent>
      </Card>

      {/* Physical Interfaces section */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-foreground flex items-center">
            <Router className="h-5 w-5 mr-2" />
            Physical Interfaces
            <Badge variant="outline" className="ml-3 bg-blue-500/10 text-blue-500 border-blue-500/20">
              {networkData.physical_active_count ?? 0}/{networkData.physical_total_count ?? 0} Active
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {mergedPhysical.map((interface_, index) => {
              const typeBadge = getInterfaceTypeBadge(interface_.type)

              return (
                <div
                  key={`${interface_._node}:${interface_.name}`}
                  className="flex flex-col gap-3 p-4 rounded-lg border border-white/10 bg-white/5 sm:bg-card sm:hover:bg-white/5 transition-colors cursor-pointer"
                  onClick={() => setSelectedInterface(interface_)}
                >
                  {/* First row: Icon, Name, Type Badge, Node Badge, Status */}
                  <div className="flex items-center gap-3 flex-wrap">
                    <Wifi className="h-5 w-5 text-muted-foreground flex-shrink-0" />
                    <div className="flex items-center gap-2 min-w-0 flex-1 flex-wrap">
                      <div className="font-medium text-foreground">{interface_.name}</div>
                      <Badge variant="outline" className={typeBadge.color}>
                        {typeBadge.label}
                      </Badge>
                      {interface_._node && nodeNames.length > 1 && (
                        <Badge variant="outline" className="flex-shrink-0 bg-muted/60 text-muted-foreground border-border">
                          <Server className="h-3 w-3 mr-1" />{interface_._node}
                        </Badge>
                      )}
                    </div>
                    <Badge
                      variant="outline"
                      className={
                        interface_.status === "up"
                          ? "bg-green-500/10 text-green-500 border-green-500/20"
                          : "bg-red-500/10 text-red-500 border-red-500/20"
                      }
                    >
                      {interface_.status.toUpperCase()}
                    </Badge>
                  </div>

                  {/* Second row: Details - Responsive layout */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                    <div>
                      <div className="text-muted-foreground text-xs">IP Address</div>
                      <div className="font-medium text-foreground font-mono text-sm truncate">
                        {interface_.addresses.length > 0 ? interface_.addresses[0].ip : "N/A"}
                      </div>
                    </div>

                    <div>
                      <div className="text-muted-foreground text-xs">Speed</div>
                      <div className="font-medium text-foreground flex items-center gap-1 text-xs">
                        <Zap className="h-3 w-3" />
                        {formatSpeed(interface_.speed)}
                      </div>
                    </div>

                    <div>
                      <div className="text-muted-foreground text-xs">Duplex</div>
                      <div className="font-medium text-foreground text-xs capitalize">{interface_.duplex}</div>
                    </div>

                    <div>
                      <div className="text-muted-foreground text-xs">MTU</div>
                      <div className="font-medium text-foreground text-xs">{interface_.mtu}</div>
                    </div>

                    {interface_.mac_address && (
                      <div className="col-span-2 md:col-span-4">
                        <div className="text-muted-foreground text-xs">MAC</div>
                        <div className="font-medium text-foreground font-mono text-xs truncate">
                          {interface_.mac_address}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {mergedBridge.length > 0 && (
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-foreground flex items-center">
              <Network className="h-5 w-5 mr-2" />
              Bridge Interfaces
              <Badge variant="outline" className="ml-3 bg-green-500/10 text-green-500 border-green-500/20">
                {networkData.bridge_active_count ?? 0}/{networkData.bridge_total_count ?? 0} Active
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {mergedBridge.map((interface_, index) => {
                const typeBadge = getInterfaceTypeBadge(interface_.type)

                return (
                  <div
                    key={`${interface_._node}:${interface_.name}`}
                    className="flex flex-col gap-3 p-4 rounded-lg border border-white/10 bg-white/5 sm:bg-card sm:hover:bg-white/5 transition-colors cursor-pointer"
                    onClick={() => setSelectedInterface(interface_)}
                  >
                    {/* First row: Icon, Name, Type Badge, Node Badge, Physical Interface (responsive), Status */}
                    <div className="flex items-center gap-3 flex-wrap">
                      <Wifi className="h-5 w-5 text-muted-foreground flex-shrink-0" />
                      <div className="flex items-center gap-2 min-w-0 flex-1 flex-wrap">
                        <div className="font-medium text-foreground">{interface_.name}</div>
                        <Badge variant="outline" className={typeBadge.color}>
                          {typeBadge.label}
                        </Badge>
                        {interface_._node && nodeNames.length > 1 && (
                          <Badge variant="outline" className="flex-shrink-0 bg-muted/60 text-muted-foreground border-border">
                            <Server className="h-3 w-3 mr-1" />{interface_._node}
                          </Badge>
                        )}
                        {interface_.bridge_physical_interface && (
                          <div className="text-sm text-blue-500 font-medium flex items-center gap-1 flex-wrap break-all">
                            → {interface_.bridge_physical_interface}
                            {interface_.bridge_physical_interface.startsWith("bond") && (
                                <>
                                  {(() => {
                                    const bondInterface = physIfacesOfNode(interface_._node).find(
                                      (iface) => iface.name === interface_.bridge_physical_interface,
                                    )
                                    if (bondInterface?.bond_slaves && bondInterface.bond_slaves.length > 0) {
                                      return (
                                        <span className="text-muted-foreground text-xs break-all">
                                          ({bondInterface.bond_slaves.join(", ")})
                                        </span>
                                      )
                                    }
                                    return null
                                  })()}
                                </>
                              )}
                            {interface_.bridge_bond_slaves && interface_.bridge_bond_slaves.length > 0 && (
                              <span className="text-muted-foreground text-xs break-all">
                                ({interface_.bridge_bond_slaves.join(", ")})
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                      <Badge
                        variant="outline"
                        className={
                          interface_.status === "up"
                            ? "bg-green-500/10 text-green-500 border-green-500/20"
                            : "bg-red-500/10 text-red-500 border-red-500/20"
                        }
                      >
                        {interface_.status.toUpperCase()}
                      </Badge>
                    </div>

                    {/* Second row: Details - Responsive layout */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                      <div>
                        <div className="text-muted-foreground text-xs">IP Address</div>
                        <div className="font-medium text-foreground font-mono text-sm truncate">
                          {interface_.addresses.length > 0 ? interface_.addresses[0].ip : "N/A"}
                        </div>
                      </div>

                      <div>
                        <div className="text-muted-foreground text-xs">Speed</div>
                        <div className="font-medium text-foreground flex items-center gap-1">
                          <Zap className="h-3 w-3" />
                          {formatSpeed(interface_.speed)}
                        </div>
                      </div>

                      <div>
                        <div className="text-muted-foreground text-xs">Duplex</div>
                        <div className="font-medium text-foreground text-xs capitalize">{interface_.duplex}</div>
                      </div>

                      <div>
                        <div className="text-muted-foreground text-xs">MTU</div>
                        <div className="font-medium text-foreground text-xs">{interface_.mtu}</div>
                      </div>

                      {interface_.mac_address && (
                        <div className="col-span-2 md:col-span-4">
                          <div className="text-muted-foreground text-xs">MAC</div>
                          <div className="font-medium text-foreground font-mono text-xs truncate">
                            {interface_.mac_address}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* VM & LXC Network Interfaces section */}
      {mergedVmLxc.length > 0 && (
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-foreground flex items-center">
              <Network className="h-5 w-5 mr-2" />
              VM & LXC Network Interfaces
              <Badge variant="outline" className="ml-3 bg-orange-500/10 text-orange-500 border-orange-500/20">
                {networkData.vm_lxc_active_count ?? 0} / {networkData.vm_lxc_total_count ?? 0} Active
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {vmLxcInterfaces.map((interface_, index) => {
                const vmTypeBadge = getVMTypeBadge(interface_.vm_type)

                return (
                  <div
                    key={`${interface_._node}:${interface_.name}`}
                    className="flex flex-col gap-3 p-4 rounded-lg border border-white/10 bg-white/5 sm:bg-card sm:hover:bg-white/5 transition-colors cursor-pointer"
                    onClick={() => setSelectedInterface(interface_)}
                  >
                    {/* First row: Icon, Name, VM/LXC Badge, Node Badge, VM Name, Status */}
                    <div className="flex items-center gap-3 flex-wrap">
                      <Wifi className="h-5 w-5 text-muted-foreground flex-shrink-0" />
                      <div className="flex items-center gap-2 min-w-0 flex-1 flex-wrap">
                        <div className="font-medium text-foreground">{interface_.name}</div>
                        <Badge variant="outline" className={vmTypeBadge.color}>
                          {vmTypeBadge.label}
                        </Badge>
                        {interface_._node && nodeNames.length > 1 && (
                          <Badge variant="outline" className="flex-shrink-0 bg-muted/60 text-muted-foreground border-border">
                            <Server className="h-3 w-3 mr-1" />{interface_._node}
                          </Badge>
                        )}
                        {interface_.vm_name && (
                          <div className="text-sm text-muted-foreground truncate">→ {interface_.vm_name}</div>
                        )}
                      </div>
                      <Badge
                        variant="outline"
                        className={
                          interface_.status === "up"
                            ? "bg-green-500/10 text-green-500 border-green-500/20"
                            : "bg-red-500/10 text-red-500 border-red-500/20"
                        }
                      >
                        {interface_.status.toUpperCase()}
                      </Badge>
                    </div>

                    {/* Second row: Details - Responsive layout */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                      <div>
                        <div className="text-sm text-muted-foreground">VMID</div>
                        <div className="font-medium">{interface_.vmid ?? "N/A"}</div>
                      </div>

                      <div>
                        <div className="text-sm text-muted-foreground">Speed</div>
                        <div className="font-medium text-foreground flex items-center gap-1">
                          <Zap className="h-3 w-3" />
                          {formatSpeed(interface_.speed)}
                        </div>
                      </div>

                      <div>
                        <div className="text-sm text-muted-foreground">Duplex</div>
                        <div className="font-medium text-foreground text-xs capitalize">{interface_.duplex}</div>
                      </div>

                      <div>
                        <div className="text-sm text-muted-foreground">MTU</div>
                        <div className="font-medium text-foreground text-xs">{interface_.mtu}</div>
                      </div>

                      {interface_.mac_address && (
                        <div className="col-span-2 md:col-span-4">
                          <div className="text-sm text-muted-foreground">MAC</div>
                          <div className="font-medium text-foreground font-mono text-xs truncate">
                            {interface_.mac_address}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Interface Details Modal */}
      <Dialog open={!!selectedInterface} onOpenChange={() => setSelectedInterface(null)}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Router className="h-5 w-5" />
              {selectedInterface?.name} - Interface Details
            </DialogTitle>
            <DialogDescription>
              View detailed information and network traffic statistics for this interface
            </DialogDescription>
            {selectedInterface?.status.toLowerCase() === "up" && selectedInterface?.vm_type !== "vm" && (
              <div className="flex justify-end pt-2">
                <Select value={modalTimeframe} onValueChange={(value: any) => setModalTimeframe(value)}>
                  <SelectTrigger className="w-[140px] bg-card border-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="hour">1 Hour</SelectItem>
                    <SelectItem value="day">24 Hours</SelectItem>
                    <SelectItem value="week">7 Days</SelectItem>
                    <SelectItem value="month">30 Days</SelectItem>
                    <SelectItem value="year">1 Year</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </DialogHeader>

          {selectedInterface && (
            <div className="space-y-6">
              {(() => {
                // Find the current interface data from modalNetworkData if available
                const currentInterfaceData = modalNetworkData
                  ? [
                      ...(modalNetworkData.physical_interfaces || []),
                      ...(modalNetworkData.bridge_interfaces || []),
                      ...(modalNetworkData.vm_lxc_interfaces || []),
                    ].find((iface) => iface.name === selectedInterface.name)
                  : selectedInterface

                // Carry the origin-node tags forward: currentInterfaceData comes
                // from modalNetworkData (untagged API objects), so without this the
                // per-interface chart would route to the local node for remote ifaces.
                const displayInterface = {
                  ...(currentInterfaceData || selectedInterface),
                  _node: selectedInterface._node,
                  _node_is_self: selectedInterface._node_is_self,
                }

                return (
                  <>
                    {/* Basic Information */}
                    <div>
                      <h3 className="text-sm font-semibold text-muted-foreground mb-3">Basic Information</h3>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <div className="text-sm text-muted-foreground">Interface Name</div>
                          <div className="font-medium">{displayInterface.name}</div>
                        </div>
                        <div>
                          <div className="text-sm text-muted-foreground">Type</div>
                          <Badge variant="outline" className={getInterfaceTypeBadge(displayInterface.type).color}>
                            {getInterfaceTypeBadge(displayInterface.type).label}
                          </Badge>
                        </div>
                        {displayInterface.type === "bridge" && displayInterface.bridge_physical_interface && (
                          <div className="col-span-2">
                            <div className="text-sm text-muted-foreground">Physical Interface</div>
                            <div className="font-medium text-blue-500 text-lg break-all">
                              {displayInterface.bridge_physical_interface}
                            </div>
                            {displayInterface.bridge_physical_interface.startsWith("bond") &&
                              modalNetworkData?.physical_interfaces && (
                                <>
                                  {(() => {
                                    const bondInterface = modalNetworkData.physical_interfaces.find(
                                      (iface) => iface.name === displayInterface.bridge_physical_interface,
                                    )
                                    if (bondInterface?.bond_slaves && bondInterface.bond_slaves.length > 0) {
                                      return (
                                        <div className="mt-2">
                                          <div className="text-sm text-muted-foreground mb-2">Bond Members</div>
                                          <div className="flex flex-wrap gap-2">
                                            {bondInterface.bond_slaves.map((slave, idx) => (
                                              <Badge
                                                key={idx}
                                                variant="outline"
                                                className="bg-purple-500/10 text-purple-500 border-purple-500/20"
                                              >
                                                {slave}
                                              </Badge>
                                            ))}
                                          </div>
                                        </div>
                                      )
                                    }
                                    return null
                                  })()}
                                </>
                              )}
                            {displayInterface.bridge_bond_slaves && displayInterface.bridge_bond_slaves.length > 0 && (
                              <div className="mt-2">
                                <div className="text-sm text-muted-foreground mb-2">Bond Members</div>
                                <div className="flex flex-wrap gap-2">
                                  {displayInterface.bridge_bond_slaves.map((slave, idx) => (
                                    <Badge
                                      key={idx}
                                      variant="outline"
                                      className="bg-purple-500/10 text-purple-500 border-purple-500/20"
                                    >
                                      {slave}
                                    </Badge>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                        {displayInterface.type === "vm_lxc" && displayInterface.vm_name && (
                          <div className="col-span-2">
                            <div className="text-sm text-muted-foreground">VM/LXC Name</div>
                            <div className="font-medium text-orange-500 text-lg flex items-center gap-2">
                              {displayInterface.vm_name}
                              {displayInterface.vm_type && (
                                <Badge variant="outline" className={getVMTypeBadge(displayInterface.vm_type).color}>
                                  {getVMTypeBadge(displayInterface.vm_type).label}
                                </Badge>
                              )}
                            </div>
                          </div>
                        )}
                        <div>
                          <div className="text-sm text-muted-foreground">Status</div>
                          <Badge
                            variant="outline"
                            className={
                              displayInterface.status === "up"
                                ? "bg-green-500/10 text-green-500 border-green-500/20"
                                : "bg-red-500/10 text-red-500 border-red-500/20"
                            }
                          >
                            {displayInterface.status.toUpperCase()}
                          </Badge>
                        </div>
                        <div>
                          <div className="text-sm text-muted-foreground">Speed</div>
                          <div className="font-medium">{formatSpeed(displayInterface.speed)}</div>
                        </div>
                        <div>
                          <div className="text-sm text-muted-foreground">Duplex</div>
                          <div className="font-medium capitalize">{displayInterface.duplex}</div>
                        </div>
                        <div>
                          <div className="text-sm text-muted-foreground">MTU</div>
                          <div className="font-medium">{displayInterface.mtu}</div>
                        </div>
                        {displayInterface.mac_address && (
                          <div className="col-span-2">
                            <div className="text-sm text-muted-foreground">MAC Address</div>
                            <div className="font-medium font-mono">{displayInterface.mac_address}</div>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* IP Addresses */}
                    {displayInterface.addresses.length > 0 && (
                      <div>
                        <h3 className="text-sm font-semibold text-muted-foreground mb-3">IP Addresses</h3>
                        <div className="space-y-2">
                          {displayInterface.addresses.map((addr, idx) => (
                            <div key={idx} className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
                              <div>
                                <div className="font-medium font-mono">{addr.ip}</div>
                                <div className="text-sm text-muted-foreground">Netmask: {addr.netmask}</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Network Traffic Statistics - Only show if interface is UP and NOT a VM interface */}
                    {displayInterface.status.toLowerCase() === "up" && displayInterface.vm_type !== "vm" ? (
                      <div>
                        <h3 className="text-sm font-semibold text-muted-foreground mb-4">
                          Network Traffic Statistics (
                          {modalTimeframe === "hour"
                            ? "Last Hour"
                            : modalTimeframe === "day"
                              ? "Last 24 Hours"
                              : modalTimeframe === "week"
                                ? "Last 7 Days"
                                : modalTimeframe === "month"
                                  ? "Last 30 Days"
                                  : "Last Year"}
                          )
                        </h3>
                        <div className="space-y-4">
                          <div className="grid grid-cols-2 gap-4">
                            <div>
                              <div className="text-sm text-muted-foreground">
                                {networkUnit === "Bits" ? "Bits Received" : "Bytes Received"}
                              </div>
                              <div className="font-medium text-green-500 text-lg">
                                {formatNetworkTraffic(
                                  interfaceTotals.received * 1024 ** 3,
                                  networkUnit,
                                  2
                                )}
                              </div>
                            </div>
                            <div>
                              <div className="text-sm text-muted-foreground">
                                {networkUnit === "Bits" ? "Bits Sent" : "Bytes Sent"}
                              </div>
                              <div className="font-medium text-blue-500 text-lg">
                                {formatNetworkTraffic(
                                  interfaceTotals.sent * 1024 ** 3,
                                  networkUnit,
                                  2
                                )}
                              </div>
                            </div>
                          </div>

                          <div className="bg-muted/30 rounded-lg p-4">
                            <NetworkTrafficChart
                              timeframe={modalTimeframe}
                              interfaceName={displayInterface.name}
                              onTotalsCalculated={setInterfaceTotals}
                              refreshInterval={60000}
                              networkUnit={networkUnit}
                              node={displayInterface._node}
                              isSelf={displayInterface._node_is_self}
                            />
                          </div>

                          <div className="grid grid-cols-2 gap-4 pt-4 border-t border-border">
                            <div>
                              <div className="text-sm text-muted-foreground">Packets Received</div>
                              <div className="font-medium">
                                {displayInterface.packets_recv?.toLocaleString() || "N/A"}
                              </div>
                            </div>
                            <div>
                              <div className="text-sm text-muted-foreground">Packets Sent</div>
                              <div className="font-medium">
                                {displayInterface.packets_sent?.toLocaleString() || "N/A"}
                              </div>
                            </div>
                            <div>
                              <div className="text-sm text-muted-foreground">Errors In</div>
                              <div className="font-medium text-red-500">{displayInterface.errors_in || 0}</div>
                            </div>
                            <div>
                              <div className="text-sm text-muted-foreground">Errors Out</div>
                              <div className="font-medium text-red-500">{displayInterface.errors_out || 0}</div>
                            </div>
                            <div>
                              <div className="text-sm text-muted-foreground">Drops In</div>
                              <div className="font-medium text-yellow-500">{displayInterface.drops_in || 0}</div>
                            </div>
                            <div>
                              <div className="text-sm text-muted-foreground">Drops Out</div>
                              <div className="font-medium text-yellow-500">{displayInterface.drops_out || 0}</div>
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : displayInterface.status.toLowerCase() === "up" && displayInterface.vm_type === "vm" ? (
                      <div>
                        <h3 className="text-sm font-semibold text-muted-foreground mb-4">Traffic since last boot</h3>
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <div className="text-sm text-muted-foreground">
                              {networkUnit === "Bits" ? "Bits Received" : "Bytes Received"}
                            </div>
                            <div className="font-medium text-green-500 text-lg">
                              {formatNetworkTraffic(displayInterface.bytes_recv || 0, networkUnit)}
                            </div>
                          </div>
                          <div>
                            <div className="text-sm text-muted-foreground">
                              {networkUnit === "Bits" ? "Bits Sent" : "Bytes Sent"}
                            </div>
                            <div className="font-medium text-blue-500 text-lg">
                              {formatNetworkTraffic(displayInterface.bytes_sent || 0, networkUnit)}
                            </div>
                          </div>
                          <div>
                            <div className="text-sm text-muted-foreground">Packets Received</div>
                            <div className="font-medium">
                              {displayInterface.packets_recv?.toLocaleString() || "N/A"}
                            </div>
                          </div>
                          <div>
                            <div className="text-sm text-muted-foreground">Packets Sent</div>
                            <div className="font-medium">
                              {displayInterface.packets_sent?.toLocaleString() || "N/A"}
                            </div>
                          </div>
                          <div>
                            <div className="text-sm text-muted-foreground">Errors In</div>
                            <div className="font-medium text-red-500">{displayInterface.errors_in || 0}</div>
                          </div>
                          <div>
                            <div className="text-sm text-muted-foreground">Errors Out</div>
                            <div className="font-medium text-red-500">{displayInterface.errors_out || 0}</div>
                          </div>
                          <div>
                            <div className="text-sm text-muted-foreground">Drops In</div>
                            <div className="font-medium text-yellow-500">{displayInterface.drops_in || 0}</div>
                          </div>
                          <div>
                            <div className="text-sm text-muted-foreground">Drops Out</div>
                            <div className="font-medium text-yellow-500">{displayInterface.drops_out || 0}</div>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="bg-muted/30 rounded-lg p-6 text-center">
                        <AlertCircle className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
                        <h3 className="text-lg font-semibold text-foreground mb-2">Interface Inactive</h3>
                        <p className="text-sm text-muted-foreground">
                          This interface is currently down. Network traffic statistics are not available.
                        </p>
                      </div>
                    )}

                    {/* Bond Information */}
                    {displayInterface.type === "bond" && displayInterface.bond_slaves && (
                      <div>
                        <h3 className="text-sm font-semibold text-muted-foreground mb-3">Bond Configuration</h3>
                        <div className="space-y-3">
                          <div>
                            <div className="text-sm text-muted-foreground">Bonding Mode</div>
                            <div className="font-medium">{displayInterface.bond_mode || "Unknown"}</div>
                          </div>
                          {displayInterface.bond_active_slave && (
                            <div>
                              <div className="text-sm text-muted-foreground">Active Slave</div>
                              <div className="font-medium">{displayInterface.bond_active_slave}</div>
                            </div>
                          )}
                          <div>
                            <div className="text-sm text-muted-foreground mb-2">Slave Interfaces</div>
                            <div className="flex flex-wrap gap-2">
                              {displayInterface.bond_slaves.map((slave, idx) => (
                                <Badge
                                  key={idx}
                                  variant="outline"
                                  className="bg-purple-500/10 text-purple-500 border-purple-500/20"
                                >
                                  {slave}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Bridge Information */}
                    {displayInterface.type === "bridge" && displayInterface.bridge_members && (
                      <div>
                        <h3 className="text-sm font-semibold text-muted-foreground mb-3">Bridge Configuration</h3>
                        <div>
                          <div className="text-sm text-muted-foreground mb-2">Virtual Member Interfaces</div>
                          <div className="flex flex-wrap gap-2">
                            {displayInterface.bridge_members.length > 0 ? (
                              displayInterface.bridge_members
                                .filter(
                                  (member) =>
                                    !member.startsWith("enp") &&
                                    !member.startsWith("eth") &&
                                    !member.startsWith("eno") &&
                                    !member.startsWith("ens") &&
                                    !member.startsWith("wlan") &&
                                    !member.startsWith("wlp"),
                                )
                                .map((member, idx) => (
                                  <Badge
                                    key={idx}
                                    variant="outline"
                                    className="bg-green-500/10 text-green-500 border-green-500/20"
                                  >
                                    {member}
                                  </Badge>
                                ))
                            ) : (
                              <div className="text-sm text-muted-foreground">No virtual members</div>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                )
              })()}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Latency Detail Modal */}
      <LatencyDetailModal
        open={latencyModalOpen}
        onOpenChange={setLatencyModalOpen}
        node={summaryNode?.node}
        isSelf={summaryNode?.is_self}
      />
    </div>
  )
}
