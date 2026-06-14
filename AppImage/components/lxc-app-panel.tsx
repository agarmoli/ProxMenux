"use client"

import { useEffect, useState } from "react"
import { Package, ArrowUp, RefreshCw, ExternalLink, Trash2 } from "lucide-react"
import { Badge } from "./ui/badge"
import { Button } from "./ui/button"
import { Input } from "./ui/input"
import { Label } from "./ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select"
import { fetchApi, fetchAtNode } from "../lib/api-config"

export interface AppUpdate {
  app_id?: string
  name?: string
  repo?: string
  installed?: string | null
  latest?: string | null
  update_available?: boolean
  non_semver?: boolean
  error?: string | null
  last_check?: string | null
}

interface CatalogApp {
  id: string
  name: string
  repo: string
}

/** Compact chip shown on LXC rows / modal header. */
export function renderAppUpdateBadge(app?: AppUpdate, compact = false, onClick?: () => void) {
  if (!app || (!app.installed && !app.latest && !app.error)) return null
  const up = !!app.update_available
  const cls = up
    ? "bg-amber-500/10 text-amber-400 border-amber-500/30"
    : "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
  const label = up
    ? `${app.installed ?? "?"} → ${app.latest ?? "?"}`
    : (app.installed ?? app.error ?? "—")
  return (
    <Badge
      variant="outline"
      className={`${cls} flex items-center gap-1 flex-shrink-0 ${onClick ? "cursor-pointer" : ""}`}
      title={app.error ? `App: ${app.error}` : `${app.name ?? "App"} ${app.installed ?? "?"} (latest ${app.latest ?? "?"})`}
      onClick={onClick}
    >
      {up ? <ArrowUp className="h-3 w-3" /> : <Package className="h-3 w-3" />}
      {compact ? (app.name ?? "App") : `${app.name ?? "App"} ${label}`}
    </Badge>
  )
}

/** Modal "Application" tab: shows current status + assignment form. */
export function LxcAppPanel({
  vmid,
  node,
  isSelf,
  appUpdate,
  onChanged,
}: {
  vmid: number
  node?: string
  isSelf?: boolean
  appUpdate?: AppUpdate
  onChanged?: () => void
}) {
  const [catalog, setCatalog] = useState<CatalogApp[]>([])
  const [appId, setAppId] = useState<string>(appUpdate?.app_id ?? "")
  const [repo, setRepo] = useState("")
  const [source, setSource] = useState<"releases" | "tags">("releases")
  const [method, setMethod] = useState<"file" | "command">("command")
  const [value, setValue] = useState("")
  const [regex, setRegex] = useState("(\\d+\\.\\d+\\.\\d+)")
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [current, setCurrent] = useState<AppUpdate | undefined>(appUpdate)

  useEffect(() => {
    fetchApi<{ apps: CatalogApp[] }>("/api/lxc-app-catalog")
      .then((d) => setCatalog(d.apps || []))
      .catch(() => setCatalog([]))
    fetchAtNode<{ assignment: any }>(node, isSelf, `/api/vms/${vmid}/app`)
      .then((d) => { if (d.assignment?.app_id) setAppId(d.assignment.app_id) })
      .catch(() => {})
  }, [vmid])

  const save = async () => {
    setBusy(true); setMsg(null)
    const body: any = { app_id: appId }
    if (appId === "custom") {
      body.repo = repo
      body.github_source = source
      body.installed = { method, value, regex }
    }
    try {
      const res = await fetchAtNode<{ app_update: AppUpdate }>(node, isSelf, `/api/vms/${vmid}/app`, {
        method: "POST", body: JSON.stringify(body),
      })
      setCurrent(res.app_update)
      onChanged?.()
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const recheck = async () => {
    setBusy(true); setMsg(null)
    try {
      const res = await fetchAtNode<{ app_update: AppUpdate }>(node, isSelf, `/api/vms/${vmid}/app/check`, { method: "POST" })
      setCurrent(res.app_update); onChanged?.()
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true); setMsg(null)
    try {
      await fetchAtNode(node, isSelf, `/api/vms/${vmid}/app`, { method: "DELETE" })
      setCurrent(undefined); setAppId(""); onChanged?.()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      {current && (current.installed || current.latest || current.error) && (
        <div className="rounded-lg border border-border p-3 text-sm space-y-1">
          <div className="flex items-center justify-between">
            <span className="font-medium">{current.name ?? current.repo}</span>
            {current.repo && (
              <a className="text-xs text-blue-400 inline-flex items-center gap-1"
                 href={`https://github.com/${current.repo}`} target="_blank" rel="noreferrer">
                GitHub <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
          <div>Installed: <strong>{current.installed ?? "—"}</strong></div>
          <div>Latest: <strong>{current.latest ?? "—"}</strong></div>
          {current.update_available && <div className="text-amber-400">Update available{current.non_semver ? " (non-semver compare)" : ""}</div>}
          {current.error && <div className="text-red-400">{current.error}</div>}
        </div>
      )}

      <div className="space-y-2">
        <Label>Application</Label>
        <Select value={appId} onValueChange={setAppId}>
          <SelectTrigger><SelectValue placeholder="Select an app…" /></SelectTrigger>
          <SelectContent>
            {catalog.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
            <SelectItem value="custom">Custom…</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {appId === "custom" && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div><Label>GitHub repo (owner/name)</Label><Input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name" /></div>
          <div>
            <Label>Latest from</Label>
            <Select value={source} onValueChange={(v) => setSource(v as any)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="releases">releases</SelectItem>
                <SelectItem value="tags">tags</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Installed via</Label>
            <Select value={method} onValueChange={(v) => setMethod(v as any)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="command">command</SelectItem>
                <SelectItem value="file">file (cat)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div><Label>{method === "file" ? "File path" : "Command"}</Label><Input value={value} onChange={(e) => setValue(e.target.value)} placeholder={method === "file" ? "/opt/app/VERSION" : "app --version"} /></div>
          <div className="sm:col-span-2"><Label>Version regex</Label><Input value={regex} onChange={(e) => setRegex(e.target.value)} /></div>
        </div>
      )}

      {msg && <div className="text-sm text-red-400">{msg}</div>}

      <div className="flex flex-wrap gap-2">
        <Button onClick={save} disabled={busy || !appId || (appId === "custom" && (!repo || !value))}>Save</Button>
        <Button variant="outline" onClick={recheck} disabled={busy || !appId}><RefreshCw className="h-4 w-4 mr-2" />Check now</Button>
        {current && <Button variant="ghost" onClick={remove} disabled={busy}><Trash2 className="h-4 w-4" /></Button>}
      </div>
    </div>
  )
}
