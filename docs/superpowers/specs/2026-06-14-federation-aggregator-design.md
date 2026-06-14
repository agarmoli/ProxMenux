# Federation — Generic aggregator + Storage pilot (cluster-first, Fase 1)

- **Fecha:** 2026-06-14
- **Estado:** Diseño aprobado, pendiente de plan
- **Ámbito:** ProxMenux Monitor (federación). Pieza base del dashboard "cluster-first":
  un agregador genérico que hace fan-out de **cualquier** path de la API a todos los
  nodos, más el **primer consumidor** (la pestaña Storage) como slice vertical que
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
proxy)`. Escribir un endpoint por dominio (storage, network, logs, health…) duplicaría
esa fontanería N veces. En lugar de eso, **un solo agregador genérico** parametrizado
por `path` alimenta a todas las vistas.

Esta fase entrega la pieza base **y un consumidor real** (Storage), porque un endpoint
sin consumidor se diseña a ciegas: solo una vista de verdad valida que la forma de la
respuesta sirve para pintar.

## 2. Decisiones (brainstorming)

| Decisión | Elección |
|---|---|
| Alcance Fase 1 | **Slice vertical**: agregador genérico + piloto Storage de punta a punta |
| Forma del agregador | **Tubo tonto**: fan-out puro; devuelve el `data` de cada nodo **verbatim, anidado**. No conoce la forma de la respuesta; el aplanado/columna-Nodo lo hace el frontend por vista |
| Forma de respuesta | **Forma-lista** `{path, nodes:[{node,is_self,online,status,error,data}]}` (igual convención que `/overview` y `/nodes`), llevando `online/status/error` por nodo |
| Multi-path por vista | El agregador toma **un** `path`; una vista con varios endpoints (Storage: 3) lo llama **N veces** (N claves SWR). El agregador se queda dead-simple |
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

### Backend — `flask_federation_routes.py`

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
  no-proxyable→403.
- **Auth:** self con el `Authorization` entrante (válido para el central, vía
  `test_client`); peers con su token (`peer_client.fetch_json` ya lo pone).
- **Concurrencia:** `ThreadPoolExecutor(max_workers=min(8, len(peers)))`, idéntico al
  resto de agregadores.
- **Único cambio colateral:** `_fetch_local(path, incoming_auth, params=None)` gana un
  parámetro `params` opcional (hoy no lo acepta) para reenviar query params extra al
  `test_client`. `peer_client.fetch_json` ya acepta `params`.

### Frontend — `lib/api-config.ts`

Helper nuevo `aggregateUrl(path)`:

```ts
export function aggregateUrl(path: string): string {
  return `/api/federation/aggregate?path=${encodeURIComponent(path)}`
}
```

Como la URL empieza por `/api/federation`, `fetchApi()` **nunca** la proxya al nodo
activo (`FEDERATION_LOCAL_PREFIXES` ya la excluye): siempre pega al central, que es
quien agrega.

### Frontend — `storage-overview.tsx`

- Las **3 claves SWR** (`/api/storage`, `/api/proxmox-storage`, `/api/mounts`) pasan
  a `aggregateUrl('/api/storage' | …)`. Cada una devuelve `{path, nodes:[…]}`.
- **Merge en cliente:** por cada nodo `online`, se toma su `data` (la `StorageData` /
  `ProxmoxStorageData` / lista de mounts de ese nodo) y se aplanan discos / ZFS pools /
  PVE-storages / mounts **tageando cada fila con `node`** → tablas unificadas con
  **columna Nodo**.
- **Filtro local** `nodeFilter` (chips Todos · nodoA · nodoB) derivado de los `node`
  distintos; filtrado en cliente; por defecto *Todos*. Calcado de VMs.
- **Totales de cabecera:** pasan a ser **por nodo** (tira compacta una por nodo), no un
  único agregado que mezclaría discos de máquinas distintas de forma engañosa.
- **Paridad single-node:** sin peers el agregador devuelve solo el local; la columna
  Nodo, los chips y la tira por-nodo **se ocultan** → instalación de un nodo idéntica a
  hoy. (Mismo criterio que el badge de VMs.)

## 4. Flujo de datos

1. Storage tab → 3× `fetchApi(aggregateUrl('/api/storage' | …))` → central.
2. Central: `collect(self)` in-process (`test_client`) + `collect(peers)` por
   `/api/proxy` en paralelo → `{nodes:[{node, online, data}]}` por cada path.
3. Render: merge de los `data` por nodo → tablas con columna Nodo; filtro de chips en
   cliente; tira de totales por nodo.

## 5. Errores / estados

- **Peer caído** → su entrada llega `online:false, data:null, error:…`; el request
  global sigue **200**. La UI muestra una banda inline "pve2 — offline", no se traga en
  silencio.
- **Error en self** (p.ej. `/api/storage` da 500) → `online:true, status:500,
  error:"HTTP 500", data:<lo que devuelva>` (comportamiento actual de `_fetch_local`).
- **Peers `enabled:false`** se excluyen del fan-out.
- **Path inválido / no-proxyable** → 400 / 403 antes de tocar ningún nodo.
- **Sin federación (1 nodo)** → `{nodes:[self]}`; Storage se ve idéntico a hoy.

## 6. Pruebas

- **pytest** (sobre `tests/test_federation_routes.py`, mockeando `peer_client` y
  `federation_config.load_peers` como hacen los tests existentes):
  - **self-only** (sin peers) → 1 entrada, `online:true`, `data` passthrough del
    endpoint local.
  - **peer online** (mock) → 2 entradas, `data` por nodo.
  - **peer offline** (mock lanza/`online:false`) → entrada `online:false, data:null`;
    status global **200**.
  - **validación de path:** falta `path`→400; `/api/auth/login`→403;
    `/api/federation/x`→403; `api/x/../auth`→400 (travesía).
  - **peer `enabled:false`** → excluido del resultado.
  - (opcional) **query params extra** reenviados a cada nodo.
- **Manual (el grueso):** con 2 nodos, la pestaña Storage lista discos/pools/PVE-storage
  /mounts de ambos con columna Nodo; el filtro de chips acota; un nodo parado aparece
  como "offline" sin romper la tabla; en single-node la vista es idéntica a hoy.

## 7. Frontera de la Fase 1

**Dentro:**
- Endpoint `/api/federation/aggregate` + extensión `params` de `_fetch_local` + pytest.
- Helper `aggregateUrl` en `api-config.ts`.
- `storage-overview.tsx` migrada: tablas unificadas con columna Nodo, filtro local,
  tira de totales por nodo, paridad single-node.
- Rebuild AppImage + instalación en los 2 nodos (criterio "instalable y útil": ver
  Storage de ambos de un vistazo).

**Fuera (fases siguientes):**
- Conversión del selector global a filtro reactivo (matar `reload`+proxy-todo).
- Migración de Overview / Network / Logs / Health / Hardware al agregador.
- Migrar el `/api/federation/vms` existente al agregador genérico (se queda; funciona).
- Terminal/consola y config por-nodo (mantienen su propio picker dentro de la pestaña).
