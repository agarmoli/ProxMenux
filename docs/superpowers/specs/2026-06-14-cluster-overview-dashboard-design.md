# Cluster Overview Dashboard (designed multi-node landing) — design

- **Fecha:** 2026-06-14
- **Estado:** Diseño aprobado, pendiente de plan.
- **Ámbito:** ProxMenux Monitor (federación). Rediseñar la pestaña **Overview** en modo
  cluster: en vez de apilar dos copias del Overview single-node (lo actual, perezoso),
  un **dashboard de cluster diseñado** — banda de resumen agregado, tarjetas ricas por
  nodo, gráficas de tendencia **superpuestas (una línea por nodo)**, y drill-in al detalle
  completo de un nodo **sin recargar**.
- **Rama:** `feature/federation`.
- **Reemplaza:** el Overview apilado por-nodo (commits `742fb02a`/`0f9510a9`). `SystemOverview`
  ya está parametrizado por nodo (de ese trabajo) y se **reutiliza** para el drill-in.
- **Depende de:** Fases 1-6 (agregador, `fetchAtNode`, `SystemOverview(node)` parametrizado).
- **Independiente de la Fase 7:** el drill-in usa estado LOCAL, no el selector global ni reload.

---

## 1. Contexto y problema

El Overview multi-nodo actual **apila** `<SystemOverview/>` por cada nodo (dos dashboards
completos uno debajo del otro). Es la salida literal, no un diseño: largo, redundante, sin
comparación. El usuario quiere ver los nodos **de un vistazo y comparables**, manteniendo el
acceso al detalle completo. Solución: un **dashboard de cluster** (Dirección A del brainstorm)
con resumen agregado + tarjetas por nodo + **gráficas superpuestas** + drill-in.

## 2. Decisiones (brainstorming)

| Decisión | Elección |
|---|---|
| Dirección | **A — dashboard de cluster** (resumen + tarjetas por nodo + charts superpuestos + drill-in). Descartadas B (columnas lado a lado: densa, no escala, poco rediseñada) y C (widgets combinados: pierde el resumen) |
| Pieza clave de diseño | **Gráficas de tendencia con una línea por nodo** (CPU%/RAM%/Red en los mismos ejes) — la mejor forma de comparar 2+ nodos en el tiempo |
| Drill-in | **Estado local `expandedNode`** → `<SystemOverview node/>` inline + "← Cluster". **Sin** `setActiveNode`/reload (desacoplado del selector global) |
| Single-node | `<SystemOverview/>` normal, sin dashboard |
| Reutilización | `SystemOverview(node)` (ya parametrizado) para el detalle; nuevo `ClusterDashboard` + `ClusterMetricsCharts` |

## 3. Arquitectura

### `overview-landing.tsx` (reescrito)
- Fetch `/api/federation/nodes` → online nodes.
- `getActiveNode() !== null` → `<SystemOverview/>` (compat con el selector global, por si se usa).
- online ≤ 1 (o cargando) → `<SystemOverview/>`.
- online > 1 → `<ClusterDashboard nodes={online} />`.

### `cluster-dashboard.tsx` (nuevo)
- Estado local `expandedNode: {node,isSelf} | null`.
- Si `expandedNode` → `<button>← Cluster</button>` + `<SystemOverview node={…} isSelf={…} />`.
- Si null → el dashboard:
  1. **Banda de resumen** (S4 abajo).
  2. **Grid de tarjetas por nodo** (clic → `setExpandedNode`).
  3. **`<ClusterMetricsCharts nodes={…} />`** (gráficas superpuestas).

### `cluster-metrics-charts.tsx` (nuevo)
- Props: lista de nodos `{node,is_self}`.
- Por cada nodo, fetch `fetchAtNode(node, isSelf, '/api/node/metrics?timeframe=<tf>')`.
- Merge de las series por timestamp en un dataset; Recharts con **una `<Line>` por nodo**
  (color estable por nodo) para CPU%, RAM% y Red (↓/↑). Selector de timeframe compartido
  (1h/24h/7d/30d/1y), por defecto el actual del Overview.
- Reaprovecha utilidades de `node-metrics-charts.tsx`/`network-traffic-chart.tsx` donde aplique;
  es un componente nuevo porque aquellos son single-serie.

## 4. Banda de resumen de cluster

Agregada sobre los nodos online. Fuentes (todas vía central, en paralelo):
- `/api/federation/overview` → por nodo: `system` (cpu_usage, memory_usage, memory_used/total,
  temperature, uptime), `health` (status, critical/warning counts), `vm_count`.
- `aggregateUrl('/api/storage/summary')` → por nodo: total/used de almacenamiento.

Muestra: **CPU media** (de cpu_usage), **RAM** (Σ memory_used / Σ memory_total + %), **guests**
(Σ vm_count — combinado VM+LXC), **almacenamiento** (Σ used / Σ total), **salud peor** (rank
CRITICAL>WARNING>UNKNOWN>OK, + suma de alertas), **N nodos online** (y cuántos offline).

**⚠️ Unidades de almacenamiento:** `/api/storage/summary` devuelve `used`/`available` en **GB**
pero `total` en **TB**. Antes de sumar, normalizar a GB: `totalGB = total * 1024`. La banda
suma `used` (GB) y `totalGB` entre nodos y formatea con `formatStorage` (GB→TB).

## 5. Tarjetas por nodo

Una por nodo online (grid responsive). De `/api/federation/overview` + la summary agregada
de storage:
- Cabecera: nombre + "(this node)" si self + badge online/health.
- Métricas: **CPU% · RAM% (memory_used/memory_total) · Temp · guests (Σ vm_count, combinado
  VM+LXC) · uptime (string ya formateado) · disco usado/total** (normalizado a GB como en §4).
- Toda la tarjeta es clic → `setExpandedNode({node,is_self})` → detalle completo.
- Nodo **offline** → tarjeta gris con "offline" + error; no clicable.

> **Sin "Red ↓/↑" en las tarjetas:** `/api/network/summary` solo da contadores acumulados
> desde boot (no un rate), engañoso como ↓/↑. La comparación de red por nodo la cubre la
> gráfica superpuesta de Red (§6), que usa el rate real `netin/netout` de `/api/node/metrics`.
> Por eso el dashboard NO fetchea `/api/network/summary`.

## 6. Gráficas superpuestas (`ClusterMetricsCharts`)

- 3 gráficas: **CPU %**, **RAM %**, **Red** (throughput). Cada una con una línea por nodo
  (leyenda = nombre del nodo, color estable).
- Datos: `fetchAtNode(n.node, n.is_self, '/api/node/metrics?timeframe=<token>')` por nodo.
  La respuesta es `{node, timeframe, data: [...]}` donde `data` son puntos RRD de PVE.
  **Formas reales (NO `{timestamp,cpu,mem,net_in/out}`):** la clave temporal es **`time`**
  (epoch en **segundos**); `cpu` es **fracción 0-1** (×100 para %); **no hay campo de RAM%**
  → derivar `memused/memtotal*100`; red = **`netin`/`netout`** (bytes/seg, rate ya integrado
  por bucket). Mergear por `time` en filas `{time, cpu_<nodeA>, cpu_<nodeB>, …}` para Recharts
  (una `<Line dataKey="cpu_<node>">` por nodo).
- **Timeframe:** el selector muestra `1h/24h/7d/30d/1y` pero **envía** el token de API
  `hour|day|week|month|year` (mapear como hace `system-overview.tsx` ~390-405; la API rechaza
  otros con 400). Un solo selector re-fetchea todas las series.
- Si un nodo no devuelve `data` (viejo/caído/array vacío), su línea se omite (las demás siguen;
  Recharts tolera claves dispersas).

## 7. Drill-in sin reload

`expandedNode` es estado local de `ClusterDashboard`. Clic en tarjeta → set; el dashboard se
reemplaza por `<SystemOverview node={n.node} isSelf={n.is_self} />` (detalle completo de ese
nodo, datos vía `fetchAtNode`) + un botón "← Cluster" que lo limpia. **No** toca
`localStorage`/`setActiveNode` ni recarga la página. (Si el selector global SÍ tiene un nodo
activo, `OverviewLanding` ya muestra el `SystemOverview` de ese nodo — coherente.)

## 8. Datos / errores / paridad

- Fetches del dashboard (paralelo, vía central): `/api/federation/overview` +
  `aggregateUrl('/api/storage/summary')`; y los `/api/node/metrics` por nodo dentro de
  `ClusterMetricsCharts`. (Nada de `/api/network/summary` — ver §5.)
- Refresco: la banda/tarjetas en intervalo razonable (~15-30s); los charts según su timeframe.
- **Nodo offline** → cuenta en la banda + tarjeta gris; nunca rompe la vista.
- **1 nodo** → `SystemOverview` normal (sin dashboard, sin charts superpuestos).
- Loading: skeleton/placeholder por sección mientras llegan los datos.

## 9. Pruebas

Sin runner JS → **gate = `npm run build` completa + tsc scoped sin firmas nuevas + manual**.
Manual (2 nodos): la banda agrega correctamente (RAM sumada, peor salud); las tarjetas muestran
las métricas por nodo; los 3 charts dibujan **una línea por nodo** y el timeframe re-fetchea;
clic en tarjeta entra al detalle del nodo y "← Cluster" vuelve **sin recargar**; nodo parado
sale en gris; en single-node se ve el `SystemOverview` de siempre.

## 10. Frontera

**Dentro:**
- `overview-landing.tsx` reescrito (branch single/cluster).
- `cluster-dashboard.tsx` (banda + tarjetas + drill-in local).
- `cluster-metrics-charts.tsx` (gráficas superpuestas).
- Reúso de `SystemOverview(node)` para el detalle.
- Rebuild AppImage + verificación manual.

**Fuera:**
- El backend (no cambia — todo vía agregador / `/api/node/metrics` existente).
- La Fase 7 (selector global → reactivo): el drill-in aquí es local, no depende de ella.
- La pestaña Cluster ya se retiró; el detalle single-node sigue siendo `SystemOverview`.
- El componente `cluster-overview.tsx` (tarjetas simples) queda obsoleto; puede borrarse en el
  plan si nada más lo usa.
