# Federation — Generic aggregator + Network pilot (cluster-first, Fase 1)

- **Fecha:** 2026-06-14
- **Estado:** Diseño aprobado, pendiente de plan
- **Ámbito:** ProxMenux Monitor (federación). Pieza base del dashboard "cluster-first":
  un agregador genérico que hace fan-out de **cualquier** path de la API a todos los
  nodos, más el **primer consumidor** (la pestaña Network) como slice vertical que
  valida el patrón de punta a punta.
- **Rama:** `feature/federation`.
- **Roadmap:** `docs/superpowers/2026-06-14-cluster-first-dashboard-roadmap.md` (Fase 1).

---

## 1. Contexto y problema

El dashboard federado muestra hoy **un nodo cada vez**: el selector global escribe
`proxmenux-active-node` en `localStorage`, recarga la página, y `fetchApi()` proxya
**todas** las llamadas al nodo activo vía `/api/proxy/<nodo>`. El objetivo del roadmap
es invertir eso: cada vista de **información** muestra **todos los nodos a la vez** por
defecto, y el selector se degrada a filtro.

Ya existen tres agregadores a medida (`/api/federation/overview`, `/nodes`, `/vms`)
con el mismo patrón repetido: `collect(self in-process) + ThreadPoolExecutor(peers por
proxy)`. Escribir un endpoint por dominio (network, storage, logs, health…) duplicaría
esa fontanería N veces. En lugar de eso, **un solo agregador genérico** parametrizado
por `path` alimenta a todas las vistas.

Esta fase entrega la pieza base **y un consumidor real** (Network), porque un endpoint
sin consumidor se diseña a ciegas: solo una vista de verdad valida que la forma de la
respuesta sirve para pintar.

### Por qué Network y no Storage como piloto

Storage parecía el candidato natural, pero la revisión del código lo descartó:
`storage-overview.tsx` son 4500+ líneas con ~15 llamadas por disco (SMART JSON,
observations, historial/lanzar test SMART, schedules, instalar herramientas) y
**acciones POST + config por-nodo** (¿los SMART schedules son per-node? ¿instalar
smartctl en qué nodo?). Es la pestaña más pesada del dashboard — mal candidato a
"piloto barato".

`network-metrics.tsx` es el slice vertical correcto: **read-only**, sin acciones, su
drill-down son ~8 GETs que se enrutan por nodo con un swap mecánico
`fetchApi → fetchAtNode` (sin preguntas de semántica). Valida la plantilla completa
(agregador → tabla unificada con columna Nodo → filtro local → drill-down enrutado)
que las fases siguientes repetirán. Storage pasa a su propia fase dedicada, con
presupuesto para sus ~15 call-sites.

## 2. Decisiones (brainstorming)

| Decisión | Elección |
|---|---|
| Alcance Fase 1 | **Slice vertical**: agregador genérico + piloto Network de punta a punta |
| Piloto | **Network** (read-only, drill-down acotado), no Storage (demasiado pesada) |
| Forma del agregador | **Tubo tonto**: fan-out puro; devuelve el `data` de cada nodo **verbatim, anidado**. No conoce la forma de la respuesta; el aplanado/columna-Nodo lo hace el frontend por vista |
| Forma de respuesta | **Forma-lista** `{path, nodes:[{node,is_self,online,status,error,data}]}` (igual convención que `/overview` y `/nodes`), llevando `online/status/error` por nodo |
| Multi-path por vista | El agregador toma **un** `path`; una vista llama al agregador **una vez por endpoint** (N claves SWR). El agregador se queda dead-simple |
| Drill-down por ítem | Enrutado al nodo del ítem con `fetchAtNode(_node, _node_is_self, …)` (patrón ya probado por VMs) |
| Patrón de pintado | Calcado de VMs: tabla unificada con **columna Nodo** + **filtro local** de chips (Todos/nodoX), filtrado en cliente, por defecto *Todos* |
| Selector global | **No se toca** en esta fase. Su conversión a filtro reactivo (matar `reload`+proxy-todo) se hace **al final**, cuando todas las vistas ya saben pintar todos los nodos |
| Migrar `/api/federation/vms` al agregador | **No** (YAGNI): funciona; se queda tal cual |

### Reordenación del roadmap (acordada)

El roadmap original ponía "selector → filtro global" como Fase 2, antes de las vistas.
Se reordena: **cada vista se migra con su filtro local** (como VMs), una por fase; la
**conversión del selector global** se deja para el final. Razón: mecánicamente cada
vista lleva su filtro local de forma independiente (VMs lo demuestra), y convertir el
selector global es más seguro cuando todas las vistas ya manejan datos all-nodes.

## 3. Arquitectura

### Backend — `flask_federation_routes.py` (view-agnostic, sirve a TODAS las vistas)

Endpoint nuevo `GET /api/federation/aggregate` (≈25 líneas, clon de `federation_vms`):

```python
@federation_bp.route("/api/federation/aggregate", methods=["GET"])
@require_auth
def aggregate():
    raw = request.args.get("path", "").strip()
    if not raw:
        return jsonify({"error": "path parameter required"}), 400
    target_path, err = _normalize_proxy_path(raw.lstrip("/"))
    if err == "invalid path": return jsonify({"error": err}), 400
    if err:                    return jsonify({"error": err}), 403

    incoming_auth = request.headers.get("Authorization")
    extra = {k: v for k, v in request.args.items() if k != "path"} or None

    def collect(name, is_self, peer=None):
        r = (_fetch_local(target_path, incoming_auth, params=extra) if is_self
             else peer_client.fetch_json(peer, target_path, params=extra))
        return {"node": name, "is_self": is_self, "online": r["online"],
                "status": r["status"], "error": r["error"], "data": r["data"]}

    nodes = [collect(_self_node_name(), True)]
    peers = [p for p in federation_config.load_peers() if p["enabled"]]
    if peers:
        with ThreadPoolExecutor(max_workers=min(8, len(peers))) as ex:
            nodes.extend(ex.map(lambda p: collect(p["name"], False, p), peers))
    return jsonify({"path": target_path, "nodes": nodes})
```

- **Seguridad:** reutiliza `_normalize_proxy_path` → bloquea travesía (`..`) y la
  allowlist no-proxyable (`/api/auth`, `/api/federation`, `/api/proxy`). Inválido→400;
  no-proxyable→403. El `path` debe ser una ruta limpia (sin `?`); los query params van
  aparte en la URL del agregador y se reenvían como `params`.
- **Auth:** self con el `Authorization` entrante (válido para el central, vía
  `test_client`); peers con su token (`peer_client.fetch_json` ya lo pone).
- **Concurrencia:** `ThreadPoolExecutor(max_workers=min(8, len(peers)))`, idéntico al
  resto de agregadores.
- **Único cambio colateral:** `_fetch_local(path, incoming_auth, params=None)` gana un
  parámetro `params` opcional (hoy `_fetch_local(path, incoming_auth)`) para reenviar
  query params al `test_client` (`client.get(path, query_string=params, …)`).
  `peer_client.fetch_json` ya acepta `params`. Las 2 llamadas existentes a
  `_fetch_local` (líneas 172, 227) no cambian (el nuevo arg es opcional).

### Frontend — `lib/api-config.ts`

Helper nuevo `aggregateUrl(path)`:

```ts
export function aggregateUrl(path: string): string {
  return `/api/federation/aggregate?path=${encodeURIComponent(path)}`
}
```

Como la URL empieza por `/api/federation`, `fetchApi()` **nunca** la proxya al nodo
activo (`FEDERATION_LOCAL_PREFIXES` ya la excluye): siempre pega al central, que es
quien agrega. `fetchAtNode(node, isSelf, endpoint)` ya existe (lo introdujo VMs) y es
el que usa el drill-down.

### Frontend — `network-metrics.tsx` (+ hijos)

**Lista (agregador):** la clave SWR `/api/network` pasa a `aggregateUrl('/api/network')`
y devuelve `{nodes:[{node,is_self,online,data:NetworkData}]}`.

- **Merge en cliente:** por cada nodo `online`, se toman sus interfaces
  (`physical_interfaces`/`bridge_interfaces`/`vm_lxc_interfaces`) y se aplanan
  **tageando cada interfaz con `_node`/`_node_is_self`** → tablas unificadas con
  **columna Nodo**.
- **Filtro local** `nodeFilter` (chips Todos · nodoA · nodoB) derivado de los `_node`
  distintos; filtrado en cliente; por defecto *Todos*. Calcado de VMs.

**Resumen por-nodo (no per-interfaz):** los datos node-global (traffic totals, active
counts, hostname/dns, latencia al gateway, `/api/node/metrics`) **no** se mezclan: se
muestran como **una tira/tarjeta de resumen por nodo**. Cada tarjeta enruta sus
lecturas al suyo con `fetchAtNode(node, is_self, …)`:
- `/api/network/latency/history` · `/api/network/latency/current` (sparkline + modal)
- `/api/node/metrics?timeframe=` (histórico)

**Drill-down por interfaz:** al abrir una interfaz, su gráfico/metrics se enruta al
nodo de esa interfaz con `fetchAtNode(iface._node, iface._node_is_self, …)`:
- `network-card.tsx:97` → `/api/network/<iface>/metrics?timeframe=`
- `network-traffic-chart.tsx:114` → metrics per-interfaz
- `latency-detail-modal.tsx:754,770` → enrutadas al nodo de su tarjeta

Todos son **GET**; el cambio es mecánico (`fetchApi(path)` → `fetchAtNode(node,
isSelf, path)`), pasando `_node`/`_node_is_self` a los componentes hijo como props.

**Paridad single-node:** sin peers el agregador devuelve solo el local; la columna
Nodo, los chips y la multi-tira por-nodo **se ocultan** → instalación de un nodo
idéntica a hoy. (Mismo criterio que el badge de VMs.)

**No se toca el selector global del header.** Su conversión queda para el final.

## 4. Flujo de datos

1. Network tab → `fetchApi(aggregateUrl('/api/network'))` → central.
2. Central: `collect(self)` in-process (`test_client`) + `collect(peers)` por
   `/api/proxy` en paralelo → `{nodes:[{node, online, data:NetworkData}]}`.
3. Render: merge de las interfaces por nodo → tabla con columna Nodo; filtro de chips
   en cliente; multi-tira de resumen por nodo.
4. Abrir interfaz remota / leer latencia de un nodo → `fetchAtNode(node, is_self,
   endpoint)` → self: central local; remoto: central → `/api/proxy/<nodo>` → nodo. El
   token del peer lo pone el central (proxy ya implementado).

## 5. Errores / estados

- **Peer caído** → su entrada llega `online:false, data:null, error:…`; el request
  global sigue **200**. La UI muestra una banda inline "pve2 — offline", no se traga en
  silencio.
- **Error en self** (p.ej. `/api/network` da 500) → `online:true, status:500,
  error:"HTTP 500", data:<lo que devuelva>` (comportamiento actual de `_fetch_local`).
- **Peers `enabled:false`** se excluyen del fan-out.
- **Path inválido / no-proxyable** → 400 / 403 antes de tocar ningún nodo.
- **Drill-down de interfaz remota inalcanzable** → el proxy devuelve 502; el modal/
  gráfico muestra su error sin romper la lista.
- **Sin federación (1 nodo)** → `{nodes:[self]}`; Network se ve idéntico a hoy.

## 6. Pruebas

- **pytest** del agregador (sobre `tests/test_federation_routes.py`, mockeando
  `peer_client` y `federation_config.load_peers` como los tests existentes):
  - **self-only** (sin peers) → 1 entrada, `online:true`, `data` passthrough del
    endpoint local.
  - **peer online** (mock) → 2 entradas, `data` por nodo.
  - **peer offline** (mock `online:false`) → entrada `online:false, data:null`; status
    global **200**.
  - **validación de path:** falta `path`→400; `/api/auth/login`→403;
    `/api/federation/x`→403; `api/x/../auth`→400 (travesía).
  - **peer `enabled:false`** → excluido del resultado.
  - **query params extra** reenviados a cada nodo (self vía `query_string`, peer vía
    `params`).
- **Manual (el grueso):** con 2 nodos, la pestaña Network lista interfaces de ambos con
  columna Nodo; el filtro de chips acota; cada tarjeta de resumen muestra la latencia/
  histórico de SU nodo; abrir una interfaz remota muestra su gráfico (enrutado al nodo
  correcto); un nodo parado aparece "offline" sin romper la tabla; en single-node la
  vista es idéntica a hoy.

## 7. Frontera de la Fase 1

**Dentro:**
- Endpoint `/api/federation/aggregate` + extensión `params` de `_fetch_local` + pytest.
- Helper `aggregateUrl` en `api-config.ts`.
- `network-metrics.tsx` (+ `network-card.tsx`, `network-traffic-chart.tsx`,
  `latency-detail-modal.tsx`) migrados: tabla de interfaces unificada con columna Nodo,
  filtro local, multi-tira de resumen por nodo, drill-down enrutado con `fetchAtNode`,
  paridad single-node.
- Rebuild AppImage + instalación en los 2 nodos (criterio "instalable y útil": ver la
  red de ambos de un vistazo).

**Fuera (fases siguientes):**
- Conversión del selector global a filtro reactivo (matar `reload`+proxy-todo).
- Migración de Storage (fase dedicada, ~15 call-sites + semántica de schedules/tools),
  Logs, Health, Hardware, Overview al agregador.
- Migrar el `/api/federation/vms` existente al agregador genérico (se queda; funciona).
- Terminal/consola y config por-nodo (mantienen su propio picker dentro de la pestaña).
