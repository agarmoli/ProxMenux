# Cluster — Unified VMs/LXC list

- **Fecha:** 2026-06-14
- **Estado:** Diseño aprobado, pendiente de plan
- **Ámbito:** ProxMenux Monitor (federación). Mostrar todas las VMs/LXC de todos los nodos del cluster en una sola tabla, sin tener que cambiar de nodo con el selector.
- **Rama:** `feature/federation` (aditivo sobre la federación existente).

---

## 1. Contexto

Con la federación, el selector de nodo cambia las vistas detalladas a **un** nodo
cada vez. La pestaña **Cluster** muestra tarjetas-resumen por nodo. Ya existe el
endpoint `/api/federation/vms` que devuelve **todas** las VMs/LXC de todos los
nodos juntas (cada entrada etiquetada con `_node` y `_node_is_self`, y para LXC con
`update_check`/`app_update`), pero **el frontend aún no lo usa**. Esta feature lo
surface como una tabla unificada.

## 2. Decisiones (brainstorming)

| Decisión | Elección |
|---|---|
| Qué se combina | Solo la **lista de VMs/LXC** (no storage/red/hardware) |
| Dónde vive | En la pestaña **Cluster**, debajo de las tarjetas de nodo |
| Interacción | Clic en fila → entra a ese nodo (fija nodo activo + recarga) |
| Acciones inline (start/stop) | **Fuera de v1** (se entra al nodo para gestionar) |
| Backend nuevo | Ninguno — `/api/federation/vms` ya da lo necesario |

## 3. Arquitectura / componente

Nuevo componente aislado `AppImage/components/cluster-vms.tsx`:
- `fetchApi("/api/federation/vms")` con polling (~15 s); estado de carga/empty.
- Renderiza una tabla. Se monta en el contenido de la pestaña Cluster
  (`proxmox-dashboard.tsx`), **después** de `<ClusterOverview />`. Las tarjetas de
  nodo no cambian.

Forma de los datos (ya provista por el endpoint): `{ vms: VM[] }`, cada `VM` con
`vmid, name, status, type ("lxc"|"qemu"), cpu, mem, maxmem, _node, _node_is_self`,
y para LXC `update_check?`, `app_update?`.

## 4. Tabla

Columnas: **Nodo · ID · Nombre · Tipo · Estado · CPU% · RAM · Updates**.
- **Estado** coloreado (running/stopped) reusando el patrón de `virtual-machines.tsx`.
- **CPU%** = `cpu*100` redondeado; **RAM** = usado/total en GB (`mem`/`maxmem`
  formateados con el helper de almacenamiento del repo).
- **Updates** (solo LXC): chip de app reusando `renderAppUpdateBadge` (exportado en
  `lxc-app-panel.tsx`); el de SO se muestra como contador desde
  `update_check.count` si está (sin extraer el helper de `virtual-machines.tsx`).
- Orden por defecto: por **nodo**, luego por **ID**. Cabecera ordenable simple.
- Filas compactas; en móvil, tarjetas apiladas (mismo patrón responsive del repo).

## 5. Interacción

Clic en una fila de un nodo remoto → `setActiveNode(node)` + `window.location.reload()`
(si la fila es del nodo local/self → `setActiveNode(null)`). El dashboard recarga
mostrando ese nodo; desde ahí se gestiona (modal, acciones, pestaña App, etc.).

## 6. Estados / errores

- **Cargando** / **lista vacía**: mensajes claros.
- **Nodo offline**: sus VMs no llegan (el endpoint salta peers caídos). Se muestra
  un aviso pequeño "no se pudo alcanzar el nodo X" leyendo el estado de
  `/api/federation/overview` (o `/nodes`), para que no parezca que el nodo no tiene
  guests.
- Fallo de fetch → mensaje de error, no rompe la pestaña.

## 7. Pruebas

- **Manual** (el grueso, es frontend): con 2 nodos, comprobar que la tabla lista las
  VMs/LXC de ambos con su columna de nodo; clic entra al nodo; un nodo parado
  muestra el aviso.
- Si se extrae alguna utilidad pura (p.ej. formateo/orden), test unitario ligero.

## 8. Fuera de alcance (v1)

- Acciones inline (start/stop) desde la tabla unificada.
- Combinar almacenamiento/red/hardware entre nodos.
- Modo "Todos los nodos" que reconvierta la pestaña VMs entera (era el enfoque B,
  descartado por invasivo).
