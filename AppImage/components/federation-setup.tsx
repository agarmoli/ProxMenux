"use client"

import { useEffect, useState } from "react"
import { Trash2, Plug } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card"
import { Button } from "./ui/button"
import { Input } from "./ui/input"
import { Label } from "./ui/label"
import { fetchApi } from "../lib/api-config"

interface Peer {
  name: string
  host: string
  port: number
  enabled: boolean
}

export function FederationSetup() {
  const [peers, setPeers] = useState<Peer[]>([])
  const [name, setName] = useState("")
  const [host, setHost] = useState("")
  const [port, setPort] = useState("8008")
  const [token, setToken] = useState("")
  const [msg, setMsg] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)

  const load = () => {
    fetchApi<{ peers: Peer[] }>("/api/federation/peers")
      .then((d) => setPeers(d.peers || []))
      .catch(() => setPeers([]))
  }
  useEffect(load, [])

  const testConnection = async () => {
    setTesting(true)
    setMsg(null)
    try {
      const res = await fetchApi<{ ok: boolean; node?: string; error?: string }>(
        "/api/federation/peers/test",
        { method: "POST", body: JSON.stringify({ host, port: Number(port), token }) }
      )
      setMsg(res.ok ? `OK — reached node "${res.node ?? "?"}"` : `Failed: ${res.error}`)
    } catch (e) {
      setMsg(`Failed: ${(e as Error).message}`)
    } finally {
      setTesting(false)
    }
  }

  const addPeer = async () => {
    setMsg(null)
    try {
      await fetchApi("/api/federation/peers", {
        method: "POST",
        body: JSON.stringify({ name, host, port: Number(port), token }),
      })
      setName(""); setHost(""); setPort("8008"); setToken("")
      load()
    } catch (e) {
      setMsg(`Error: ${(e as Error).message}`)
    }
  }

  const removePeer = async (peerName: string) => {
    await fetchApi(`/api/federation/peers/${encodeURIComponent(peerName)}`, {
      method: "DELETE",
    })
    load()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cluster Federation</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Add the other nodes of your Proxmox cluster to view them all from this
          dashboard. On each peer node, open ProxMenux → Settings → generate an API
          token with <strong>full_admin</strong> scope (needed to control VMs
          remotely), then paste it here. Use the node&apos;s hostname/FQDN so TLS
          verifies against the cluster CA.
        </p>

        {peers.length > 0 && (
          <div className="space-y-2">
            {peers.map((p) => (
              <div
                key={p.name}
                className="flex items-center justify-between border rounded-md px-3 py-2 text-sm"
              >
                <span>
                  <strong>{p.name}</strong> — {p.host}:{p.port}
                </span>
                <Button variant="ghost" size="sm" onClick={() => removePeer(p.name)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label htmlFor="fed-name">Node name</Label>
            <Input id="fed-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="pve2" />
          </div>
          <div>
            <Label htmlFor="fed-host">Host / FQDN</Label>
            <Input id="fed-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="pve2.lan" />
          </div>
          <div>
            <Label htmlFor="fed-port">Port</Label>
            <Input id="fed-port" value={port} onChange={(e) => setPort(e.target.value)} placeholder="8008" />
          </div>
          <div>
            <Label htmlFor="fed-token">API token</Label>
            <Input id="fed-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="eyJ…" />
          </div>
        </div>

        {msg && <div className="text-sm">{msg}</div>}

        <div className="flex gap-2">
          <Button variant="outline" onClick={testConnection} disabled={testing || !host || !token}>
            <Plug className="h-4 w-4 mr-2" />
            {testing ? "Testing…" : "Test connection"}
          </Button>
          <Button onClick={addPeer} disabled={!name || !host || !token}>
            Add node
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
