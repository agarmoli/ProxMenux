# Federation — Reactive node selection (kill reload + proxy-everything) — Fase 7

- **Fecha:** 2026-06-14
- **Estado:** Diseño aprobado, pendiente de plan. **NO implementar sobre base sin validar en
  hardware** — esta fase toca el mecanismo compartido del nodo activo (cimiento de las
  6 fases anteriores).
- **Ámbito:** ProxMenux Monitor (federación). Convertir la selección de nodo global de un
  modelo *reload + proxy-todo* a **selección reactiva**: cambiar de nodo (dropdown del
  selector, clic en tarjeta de cluster, escape de error remoto) refresca las superficies
  single-node **sin recargar la página**.
- **Rama:** `feature/federation`.
- **Roadmap:** `docs/superpowers/2026-06-14-cluster-first-dashboard-roadmap.md` (Fase 7, la final).
- **Depende de:** Fases 1-6 (todas las vistas ya son all-nodes vía el agregador).

---

## 1. Contexto y problema

Tras las Fases 1-6, **todas las vistas de información ya son all-nodes** (van por
`/api/federation/aggregate` u `/api/federation/overview`, que **ignoran** el nodo activo)
y tienen filtros/pickers por-vista. El "selector global" + `getActiveNode()` + el proxy de
`getApiUrl()` + `window.location.reload()` ya **solo** gobiernan el **drill-in a un nodo
concreto**: el detalle de Overview (`SystemOverview`) y las superficies de **config
por-nodo** (Backup, Security, Settings; Terminal es local-only).

El problema: cada cambio de nodo hace un **reload de página completa** (3 puntos), lo que
provoca flashazo blanco, pérdida de scroll y re-montaje total — un gesto central en un
dashboard cluster-first (saltar entre nodos) que se siente brusco y desentona con lo
pulido del resto.

**La visión original del roadmap ("selector = filtro global Todos/nodoX") quedó superada**
por los filtros por-vista construidos en las Fases 1-6; un filtro global encima sería
redundante y desincronizable (descartado, YAGNI).

## 2. Decisiones (brainstorming)

| Decisión | Elección |
|---|---|
| Objetivo de Fase 7 | **Selección reactiva** (matar los 3 `reload`), NO un filtro global ni "no hacer nada" |
| Fuente de verdad del nodo activo | **Sigue siendo `localStorage` + `getActiveNode()/setActiveNode()`** (así `getApiUrl` y todos los lectores existentes no cambian). Se añade solo **reactividad** encima |
| Mecanismo de reactividad | Hook `useActiveNode()` sobre un store de módulo (notificación al cambiar). Encaja con el idiom de eventos del codebase (`healthStatusUpdated`, `changeTab`…) |
| Radio de impacto | **Solo las ~5 superficies single-node** + el selector/tarjeta/escape + el shell. Las vistas all-nodes (Fases 1-6) **no se tocan** (ignoran el nodo activo) |
| Filtro global Todos/nodoX | **Descartado** (redundante con los filtros por-vista) |
| Limpieza incluida | Fix del **guard de error del nodo central de Storage** (diferido de la Fase 2) |

## 3. Arquitectura

### S1 — Primitiva reactiva `useActiveNode()` (`lib/api-config.ts`, o un hook nuevo)

- `getActiveNode()` (api-config.ts:21-29) y `setActiveNode()` (:31-39) **se mantienen**;
  `localStorage["proxmenux-active-node"]` sigue siendo la fuente de verdad.
- `setActiveNode()` gana una **notificación** a suscriptores: un set de listeners a nivel
  de módulo (`subscribe(cb)` / notificar en `setActiveNode`), o dispatch de un
  `CustomEvent("activeNodeChanged")`.
- Hook nuevo **`useActiveNode(): string | null`** implementado con `useSyncExternalStore`
  (subscribe al store, `getSnapshot = getActiveNode`, `getServerSnapshot = () => null`).
  Devuelve el nodo activo como **estado reactivo**.
- `getApiUrl()` (:75-93) **no cambia** — sigue leyendo `getActiveNode()` en tiempo de
  fetch; la reactividad solo hace que los componentes **re-ejecuten** sus fetches al
  cambiar el valor.

### S2 — Las ~5 superficies single-node refetchean reactivas

- **`system-overview.tsx`** (manual fetch + intervalos; fetches: `/api/system` :116,
  `/api/vms`, `/api/storage/summary`, `/api/network/summary`, `/api/proxmox-storage`):
  `const activeNode = useActiveNode()`; añadirlo a las deps del `useEffect` de carga;
  al cambiar, **resetear estado (loading/data) + recargar** para no mostrar el nodo viejo
  un instante.
- **`host-backup.tsx`** (SWR; keys `"/api/host-backups/jobs"` :137, `"/api/host-backups/archives"`
  :141): cambiar las keys a **array con el nodo activo** (`["/api/host-backups/jobs", activeNode]`)
  → cambio de nodo = nueva key = refetch (hoy con key estática SWR cachea y no refetcharía).
- **`security.tsx`** (fetches `/api/security/*`, `/api/network`): `activeNode` en deps/keys.
- **`settings.tsx`** (configs por-nodo): `activeNode` en deps/keys.
- **`terminal-panel.tsx`**: WebSocket, sin refetch; su `isRemoteNode` (deshabilitado en
  remoto) pasa a reactivo (ver S4).

### S3 — Matar los 3 `reload` + `openNode`

- **`node-selector.tsx:40-42`**: `setActiveNode(value === selfName ? null : value)` →
  **eliminar** `window.location.reload()`. La vista actual refetchea si es single-node;
  las all-nodes no se enteran.
- **`cluster-overview.tsx:51-54`** `openNode`: `setActiveNode(n.is_self ? null : n.node)`
  + **cambiar a la pestaña `overview`** disparando el evento `"changeTab"` (que el
  dashboard ya escucha, ~262/273) → **eliminar** `reload`.
- **`proxmox-dashboard.tsx:460-461`** (botón "Back to this node" del banner de error
  remoto): `setActiveNode(null)` → **eliminar** `reload`.

### S4 — Shell del dashboard reactivo (`proxmox-dashboard.tsx`)

- `isRemoteNode` (hoy `setIsRemoteNode(getActiveNode() !== null)` en mount, :131) y el
  banner de error remoto y la lógica de landing (:138, :227) pasan a leer
  **`const activeNode = useActiveNode()`** (reactivo). El banner re-evalúa solo; el escape
  funciona sin reload; `isRemoteNode` se deriva de `activeNode !== null`.
- El efecto de landing cluster-first (keys off `getActiveNode()`) sigue válido — lee el
  valor reactivo; al hacer drill-in (`setActiveNode` + `changeTab→overview`) ya no hay
  reload que lo re-dispare, así que el cambio de pestaña lo hace `openNode` explícitamente.

## 4. Flujo de datos (cambio de nodo, reactivo)

1. Usuario elige nodo (dropdown / tarjeta cluster / escape) → `setActiveNode(node)`
   actualiza `localStorage` **y notifica** a los suscriptores.
2. `useActiveNode()` re-renderiza los componentes single-node montados → sus fetches
   (con `activeNode` en deps/keys) **re-ejecutan** → `getApiUrl` resuelve a
   `/api/proxy/<node>/…` → datos del nuevo nodo. **Sin reload.**
3. Las vistas all-nodes (agregador) no dependen de `activeNode` → no se re-fetchean
   (correcto).
4. `openNode` además dispara `"changeTab"→overview` para llevar al detalle del nodo.

## 5. Errores / estados

- **Nodo remoto inalcanzable:** el refetch reactivo falla → el banner remoto existente
  aparece (ahora reactivo, sin reload); el escape (`setActiveNode(null)`) recupera
  reactivo.
- **Guard de error del nodo central de Storage (fix diferido, incluido):**
  `storage-overview.tsx` tiene `if (!storageData || storageData.error) return <error>`,
  donde `storageData` es el nodo central/primero — hoy **tapa toda la pestaña** si el
  `/api/storage` del central falla aunque haya peers sanos. Cambiar el guard a basarse en
  "**ningún nodo online**" (p.ej. `onlineNodes.length === 0`) en vez del nodo central.
- **Persistencia:** `setActiveNode` sigue escribiendo `localStorage` → un refresh manual
  restaura el nodo activo (los componentes lo leen en mount vía `useActiveNode`).
- **Single-node (sin peers):** el selector no se muestra → `activeNode` siempre `null` →
  todo local, idéntico a hoy (el reload nunca aportaba nada).

## 6. Pruebas

- No hay runner JS → **gate = `npm run build` completa + tsc scoped sin firmas nuevas +
  manual (el grueso)**.
- **Manual (2 nodos):**
  - Cambiar de nodo por el **dropdown** → Overview-detalle/Backup/Security/Settings se
    actualizan al nuevo nodo **sin recargar** (sin flashazo blanco, scroll conservado).
  - Clic en **tarjeta de cluster** → entra al detalle de ese nodo **sin reload** (cambia a
    Overview).
  - **Nodo remoto caído** → banner de error remoto; botón "Back to this node" recupera
    **sin reload**.
  - Las vistas all-nodes (Network/Storage/Logs/Health/Hardware/Cluster) **no se ven
    afectadas** por el cambio de nodo.
  - **Refresh manual** restaura el nodo activo seleccionado.
  - **Single-node** (sin peers): idéntico a hoy.
  - **Storage:** con el `/api/storage` del central forzado a fallar pero un peer sano, la
    pestaña Storage **muestra el peer** (no se tapa entera).

## 7. Frontera

**Dentro (Fase 7):**
- `useActiveNode()` + la notificación en `setActiveNode`.
- Refetch reactivo en `system-overview.tsx`, `host-backup.tsx`, `security.tsx`,
  `settings.tsx`; `isRemoteNode` reactivo para Terminal.
- Eliminar los 3 `window.location.reload()` (selector, openNode, escape); `openNode`
  dispara `changeTab→overview`.
- Shell del dashboard reactivo (banner remoto, landing, isRemoteNode).
- Fix del guard de error del nodo central de Storage.
- Rebuild + verificación manual en 2 nodos.

**Fuera:**
- Las vistas all-nodes de las Fases 1-6 (no dependen del nodo activo).
- `getApiUrl` / el modelo de proxy (`/api/proxy/<node>`) — se mantiene; solo se quita el
  `reload`, no el proxy (el proxy es correcto para las superficies single-node).
- Terminal multi-nodo (sigue siendo local-only por el WebSocket).
- Convertir Backup/Security/Settings a all-nodes (son config por-nodo; se quedan
  single-node con selección reactiva).
