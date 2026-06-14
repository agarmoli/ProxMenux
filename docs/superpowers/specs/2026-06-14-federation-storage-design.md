# Federation — Storage unificado all-nodes (cluster-first, Fase 2)

- **Fecha:** 2026-06-14
- **Estado:** Diseño aprobado, pendiente de plan
- **Ámbito:** ProxMenux Monitor (federación). Convertir la pestaña **Storage** de un nodo a
  vista all-nodes: tablas unificadas con columna Nodo + filtro local + resumen por nodo, y
  el modal de disco (incluida la gestión SMART) enrutado al nodo de cada disco.
- **Rama:** `feature/federation`.
- **Depende de:** Fase 1 (agregador genérico `/api/federation/aggregate` + `aggregateUrl`
  + `fetchAtNode`), ya entregada.
- **Roadmap:** `docs/superpowers/2026-06-14-cluster-first-dashboard-roadmap.md` (Fase 2).

---

## 1. Contexto y problema

`components/storage-overview.tsx` (~4768 líneas) es la pestaña más rica del dashboard:
4 tarjetas de resumen, 4 tablas (discos físicos, ZFS pools, PVE-storage, mounts remotos),
y un modal de disco con 4 tabs (Overview/SMART/History/Schedule) que incluye **acciones y
config**: lanzar tests SMART, gestionar schedules, instalar herramientas, borrar historial.
Hoy todo pega al nodo activo vía `fetchApi`. El roadmap la marcó como la fase más pesada por
la "semántica de schedules/tools por-nodo".

**Hallazgo que simplifica el diseño:** toda la config/acción de Storage se alcanza **siempre
a través de un disco**, y un disco pertenece a un nodo. El tab Schedule, Install tools, Run
test, borrar historial — todos viven dentro del modal de un disco concreto. Por tanto
`fetchAtNode(selectedDisk._node, …)` enruta el modal **entero** al nodo correcto. Las
schedules son "globales **por nodo**" (cada nodo tiene su `/api/storage/smart/schedules`); al
abrirse siempre desde un disco de ese nodo, **no hay colisión** y **no hace falta tocar el
backend ni el esquema**.

**Conclusión: Storage es una migración puramente frontend**, mismo patrón que Network
(Fase 1), reutilizando el agregador y `fetchAtNode`. Solo más grande (4 tablas + resumen +
~17 call-sites de fetch en el modal y subcomponentes).

## 2. Decisiones (brainstorming)

| Decisión | Elección |
|---|---|
| Backend | **Ninguno.** Se reutiliza `/api/federation/aggregate` y `fetchAtNode` tal cual |
| Schedules/tools por-nodo | **Route-by-disk-node**: el modal entero (incl. Schedule/Tools) se enruta al `_node` del disco. Descartado: añadir un campo `node` al esquema de schedules (innecesario) |
| Resumen | **Tarjetas por nodo (apiladas)**: `onlineNodes.map(...)`, 4 tarjetas calculadas de cada `n.data`. Factible sin hooks (el resumen se calcula del listado, no se fetchea — a diferencia de la latencia de Network) |
| Patrón de pintado | Calcado de Network/VMs: tablas con **columna Nodo** + **filtro local** de chips + banner de nodo offline; por defecto *Todos* |
| Identidad de disco | Clave React **node-scoped** `${_node}:${disk.name}` (porque `sda`/`nvme0n1` colisionan entre nodos) |
| Troceo | **2 sub-fases instalables**: **2a** listado+resumen+filtro; **2b** modal de disco enrutado. (Igual que Network: listado / drill-down) |
| Selector global | **No se toca** (su conversión sigue siendo la fase final del roadmap) |

## 3. Arquitectura

### Backend — sin cambios

`/api/federation/aggregate?path=/api/storage|/api/proxmox-storage|/api/mounts` ya hace el
fan-out. Los endpoints por-disco (`/api/storage/smart/...`, `/api/disk/.../temperature/...`,
`/api/storage/observations`) se alcanzan en cada nodo vía el proxy existente
(`/api/proxy/<nodo>/...`) que usa `fetchAtNode`. Nada nuevo.

### Frontend 2a — `storage-overview.tsx` (listado + resumen + filtro)

- **3 claves SWR** → `aggregateUrl('/api/storage' | '/api/proxmox-storage' | '/api/mounts')`,
  cada una `AggregateResponse<T>` (`StorageData` / `ProxmoxStorageData` / `RemoteMountsData`).
- **Merge cliente** tageando cada fila con `_node`/`_node_is_self` (helper `tag(...)` como en
  Network), y `applyNodeFilter`:
  - `data.disks` → tabla de discos unificada (columna Nodo; clave `${_node}:${name}`).
  - `data.zfs_pools` → ZFS unificado.
  - `data.storage` (PVE) → unificado. *(Nota: `ProxmoxStorage` ya trae un campo `node` propio
    de PVE; se ignora para la federación y se usa `_node` del wrapper del agregador, como en
    VMs/Network, para no mezclar semánticas.)*
  - `data.mounts` → mounts unificados.
- **Resumen por nodo**: `onlineNodes.map(n => …)` renderiza las 4 tarjetas
  (Total/Local/Remote/Physical-disks) **calculadas de `n.data`** (`getDiskHealthBreakdown`,
  `diskTypesBreakdown`, totales). Etiqueta con el nombre del nodo cuando `nodeNames.length>1`.
- **Filtro local** `nodeFilter` (chips Todos/nodoX) + **banners de offline**, calcado de
  Network. Por defecto *Todos*.
- **Paridad single-node**: sin peers → 1 nodo → columna/chips/repetición ocultas → idéntico
  a hoy.

### Frontend 2b — modal de disco enrutado por nodo

`selectedDisk` lleva `_node`/`_node_is_self` (del merge de 2a). Se enrutan **todas** las
llamadas del modal y subcomponentes con `fetchAtNode(selectedDisk._node,
selectedDisk._node_is_self, …)`. Inventario (de la exploración del código):

| Tab / origen | Método | Endpoint | Línea aprox. |
|---|---|---|---|
| handleDiskClick | GET | `/api/storage/observations?device=&serial=` | 366 |
| handleDiskClick | GET | `/api/storage/smart/<disk>/latest` | 383 |
| Overview (DiskTemperatureCard) | GET | `/api/disk/<disk>/temperature/history` | 2373 / card |
| SMART | GET | `/api/storage/smart/<disk>` (status + poll) | 3864 / 3885 / 3959 |
| SMART | **POST** | `/api/storage/smart/tools/install` | 3921 |
| SMART | **POST** | `/api/storage/smart/<disk>/test` | 3943 |
| History | GET | `/api/storage/smart/<disk>/history?limit=50` | 4248 |
| History | **DELETE** | `/api/storage/smart/<disk>/history/<file>` | 4262 |
| History | GET | `/api/storage/smart/<disk>/history/<file>` (download) | 4273 |
| History | GET | `/api/storage/smart/<disk>` (report) | 4296 |
| Schedule | GET | `/api/storage/smart/schedules` | 4461 |
| Schedule | **POST** | `/api/storage/smart/schedules/toggle` | 4477 |
| Schedule | **POST** | `/api/storage/smart/schedules` | 4498 |
| Schedule | **DELETE** | `/api/storage/smart/schedules/<id>` | 4518 |
| DiskTemperatureDetailModal | GET | `/api/disk/<disk>/temperature/history` | modal ~103 |

- Subcomponentes `DiskTemperatureCard` y `DiskTemperatureDetailModal` ganan props
  `node`/`isSelf` y enrutan su fetch (mismo patrón que `NetworkTrafficChart`/
  `LatencyDetailModal` en Fase 1).
- **Schedule tab**: enruta al nodo del disco → muestra/gestiona las schedules **de ese nodo**
  (su `disks: string[]` son nombres de disco de ese nodo; sin colisión cross-node).

## 4. Flujo de datos

1. Storage tab → 3× `fetchApi(aggregateUrl('/api/storage' | …))` → central agrega
   (self in-process + peers por proxy) → `{nodes:[{node, online, data}]}` por cada path.
2. Merge cliente → tablas con columna Nodo (filtro/chips) + 4 tarjetas por nodo.
3. Abrir un disco (remoto o local) → modal con `selectedDisk._node` → cada acción/lectura
   `fetchAtNode(_node, _node_is_self, endpoint)` → self: central local; remoto: central →
   `/api/proxy/<nodo>` → nodo (token del peer lo pone el proxy). Run test / schedules / tools
   actúan sobre **ese** nodo.

## 5. Errores / estados

- **Nodo offline** → entrada `online:false`; banner inline; request global 200 (semántica del
  agregador). Sus discos no aparecen en las tablas.
- **Disco remoto inalcanzable en una acción** → el proxy devuelve 502; la UI muestra el error
  de esa acción sin romper la tabla.
- **Sin federación (1 nodo)** → agregador devuelve solo el local; vista idéntica a hoy,
  incluido el modal (`fetchAtNode(undefined,…)` = llamada local).

## 6. Pruebas

- No hay runner JS (igual que Network). **Gate por sub-fase:**
  1. `cd AppImage && npm run build` completa (caza syntax/imports).
  2. `npx tsc --noEmit` → **0 errores nuevos** en los ficheros tocados (`storage-overview.tsx`,
     `disk-temperature-card.tsx`, `disk-temperature-detail-modal.tsx`) respecto a su baseline.
  3. **Manual (el grueso), 2 nodos:** discos/ZFS/PVE-storage/mounts de ambos con columna Nodo;
     filtro de chips; resumen por nodo correcto; abrir un disco **remoto** → Overview/SMART/
     History/Schedule muestran datos del **nodo correcto**; lanzar test / crear schedule /
     instalar tools actúan sobre el nodo del disco; nodo parado como "offline" sin romper la
     tabla; **single-node idéntico a hoy**.
- El agregador ya tiene sus pytest (Fase 1); 2a/2b no añaden backend.

## 7. Frontera

**Dentro (Fase 2):**
- **2a:** `storage-overview.tsx` — 3 fetches por agregador, merge con columna Nodo + claves
  node-scoped, 4 tablas unificadas, resumen por nodo, filtro local, banners offline, paridad
  single-node.
- **2b:** modal de disco + `DiskTemperatureCard` + `DiskTemperatureDetailModal` enrutados por
  `fetchAtNode(disk._node, …)` (los ~17 call-sites del inventario).
- Rebuild AppImage + instalación/verificación en los 2 nodos.

**Fuera:**
- Cambios de backend / esquema de schedules (no hacen falta).
- Conversión del selector global (fase final del roadmap).
- Resto de pestañas (Logs/Health/Hardware/Overview) — fases siguientes, mismo patrón.
- Acciones masivas multi-disco / multi-nodo.
