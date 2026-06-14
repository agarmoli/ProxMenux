# VMs & LXC — "All nodes" in-place management

- **Fecha:** 2026-06-14
- **Estado:** Diseño aprobado, pendiente de plan
- **Ámbito:** ProxMenux Monitor (federación). La pestaña VMs & LXCs muestra todas las guests de todos los nodos a la vez y permite **gestionarlas in-place** (modal, acciones) enrutando cada llamada al nodo de esa VM.
- **Rama:** `feature/federation`.

---

## 1. Contexto y problema

Con la federación, el selector cambia las vistas a **un** nodo cada vez. El usuario
quiere ver y **gestionar** todas las VMs/LXC de los dos nodos sin ir cambiando.
Hoy la pestaña VMs (`virtual-machines.tsx`) trae `/api/vms` proxiado al nodo activo
y **todas** sus acciones (control, backups, logs, modal, métricas, asignar app,
notas) van también a ese nodo activo. Ya existe `/api/federation/vms` (todas las
guests de todos los nodos, etiquetadas con `_node`/`_node_is_self`) pero la pestaña
VMs no lo usa.

## 2. Decisiones (brainstorming)

| Decisión | Elección |
|---|---|
| Qué hace la vista combinada | **Gestión completa in-place** (no solo ver) |
| Dónde | La pestaña **VMs & LXCs** muestra **siempre todos los nodos** (no depende del selector), con un **filtro por nodo** (chips) para acotar |
| Selector global | Sigue gobernando las **otras** pestañas (Storage/Network/Hardware/Logs); deja de afectar a VMs |
| Acciones por VM | Enrutadas al **nodo de esa VM** (`/api/proxy/<nodo>/…` si es remota; local si es self) |
| Consola/terminal remota | **Deshabilitada** (WebSocket no proxiable; ya es local-only) — único hueco |
| Tabla del Cluster tab | **Se retira** (queda redundante); el Cluster tab mantiene las tarjetas-resumen |

## 3. Arquitectura

**Fontanería node-aware (en `lib/api-config.ts`):**
- Refactor: extraer de `fetchApi` un núcleo `fetchUrl<T>(url, options)` que hace la
  cabecera `Authorization` + manejo de errores sobre una URL ya resuelta. `fetchApi`
  pasa a ser `fetchUrl(getApiUrl(endpoint), options)`.
- Nuevo helper `fetchAtNode<T>(node, isSelf, endpoint, options)`:
  - `isSelf` → `fetchUrl(getLocalApiUrl(endpoint), …)` (central, **sin** proxy del
    selector global).
  - remoto → `fetchUrl(getLocalApiUrl("/api/proxy/" + node + endpoint), …)` (central
    → proxy al nodo). Usa `getLocalApiUrl` para **ignorar el nodo activo global**.
- Por qué `getLocalApiUrl`: si usáramos `getApiUrl`, una VM *self* se proxiaría al
  nodo del selector cuando hay uno activo (incorrecto). `getLocalApiUrl` resuelve
  siempre relativo al central. Las rutas `/api/proxy/...` ya están excluidas del
  doble-proxy.

**`virtual-machines.tsx`:**
- Fuente de datos: `fetchApi("/api/federation/vms")` (sigue siendo central, prefijo
  `/api/federation` excluido del proxy). Polling más relajado (~8-10 s) porque el
  agregado pega a todos los nodos.
- Cada VM ya trae `_node`/`_node_is_self`. Se añade una **etiqueta de Nodo** en la
  tarjeta y un **filtro de chips** (Todos · nodoA · nodoB) derivado de los `_node`
  distintos; filtrado en cliente; por defecto *Todos*.
- **Refactor de call-sites:** todas las llamadas por VM pasan de
  `fetchApi(`/api/vms/${vmid}/…`)` a `fetchAtNode(vm._node, vm._node_is_self,
  `/api/vms/${vmid}/…`)`. Afecta a: detalle (`/api/vms/<id>`), control, backups
  (GET y POST), logs, firewall log, editar descripción (PUT), asignación de app
  (`/api/vms/<id>/app[/check]`), y el badge/recheck del panel de app.

**`metrics-dialog.tsx`:** recibe la VM (o su `node`/`is_self`) y usa `fetchAtNode`
para `/api/vms/<id>/metrics`.

**Consola:** en el modal, el botón de terminal/consola se deshabilita cuando la VM
es remota (`!_node_is_self`), con el aviso "entra al nodo para la consola".

**Limpieza:** se elimina `components/cluster-vms.tsx` y su montaje en la pestaña
Cluster (`proxmox-dashboard.tsx`). El Cluster tab vuelve a solo `<ClusterOverview />`.

## 4. Flujo de datos

1. VMs tab → `fetchApi("/api/federation/vms")` → central agrega (self in-process +
   peers por HTTP) → lista con `_node`.
2. Render: tarjetas con etiqueta de nodo; filtro de chips en cliente.
3. Abrir/gestionar una VM → `fetchAtNode(vm._node, vm._node_is_self, endpoint)` →
   self: central local; remota: central → `/api/proxy/<nodo>` → nodo. El token del
   peer lo pone el central (ya implementado en el proxy).

## 5. Errores / estados

- Nodo peer caído → sus VMs no llegan (el endpoint los salta); aviso pequeño
  "no se pudo alcanzar X" leyendo `/api/federation/nodes`.
- Acción contra una VM remota inalcanzable → el proxy devuelve 502; la UI muestra el
  error de esa acción sin romper la lista.
- Sin federación (1 nodo) → `/api/federation/vms` devuelve solo el local; idéntico a
  hoy.

## 6. Pruebas

- **Unitario (ligero):** `fetchAtNode` construye la URL correcta (self vs remoto)
  ignorando el nodo activo global; el filtro por nodo filtra bien.
- **Manual (el grueso):** con 2 nodos, la pestaña VMs lista guests de ambos; abrir
  una VM remota muestra detalle/métricas/logs y permite arrancar/parar (enrutado al
  nodo correcto); consola remota deshabilitada; filtro por nodo funciona; un nodo
  parado se omite con aviso.

## 7. Fuera de alcance (v1)

- Consola/terminal de VMs remotas (sigue siendo local-only).
- Combinar Storage/Network/Hardware entre nodos (esas pestañas siguen por selector).
- Acciones masivas multi-VM.
