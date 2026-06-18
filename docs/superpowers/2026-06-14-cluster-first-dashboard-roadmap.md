# Roadmap — Cluster-first dashboard (single pane of glass)

- **Fecha:** 2026-06-14
- **Estado:** Roadmap / pendiente de arrancar (próxima sesión)
- **Rama:** `feature/federation`
- **Objetivo:** Que el dashboard muestre **toda** la información de **todos** los nodos del cluster de un vistazo, sin tener que cambiar de nodo con el selector.

---

## Decisión de diseño central

**El selector de nodo pasa de "cambiar de nodo" a "filtro global", por defecto en "Todos".**
Cada vista muestra **todos los nodos a la vez por defecto**; el selector solo *acota* a un
nodo si el usuario quiere. (Mismo patrón que ya tiene la pestaña VMs: badge de Nodo +
filtro de chips.)

## Qué se combina y qué se queda por nodo

| Dominio | Combinable | Cómo |
|---|---|---|
| VMs/LXC | ✅ **ya hecho** | tabla all-nodes + acciones por nodo (`fetchAtNode`) |
| Overview (CPU/RAM/temp/uptime) | ✅ | tarjetas por nodo (ya en Cluster) → hacerlo el landing |
| Storage / discos / SMART | ✅ | tabla unificada con columna Nodo |
| Network / interfaces | ✅ | lista unificada con columna Nodo |
| Logs | ✅ | merge por tiempo con columna Nodo |
| Health | ✅ | checks de todos los nodos juntos |
| Hardware | ⚠️ | físico por máquina → secciones apiladas por nodo |
| Terminal/consola | ❌ | WebSocket no proxiable → picker de nodo *dentro* de la pestaña |
| Settings/Security por nodo (SSL…) | ❌ | config de un nodo → picker *dentro* de la pestaña |

Regla: lo que es **información para mirar** se unifica; lo que es **acción/consola/config
de un nodo concreto** mantiene elección de nodo, metida dentro de su pestaña.

## Arquitectura recomendada (DRY)

**Un agregador genérico** en el backend en vez de un endpoint por dominio:

```
GET /api/federation/aggregate?path=/api/storage
→ fan-out de ESE path a todos los nodos (self in-process vía test_client + peers vía
  peer_client), devuelve { nodes: [{ node, is_self, online, data }] }
```

Un solo endpoint reutilizable alimenta storage, network, logs, health… El frontend solo
añade columna/agrupación por Nodo en cada tab. Reaprovecha toda la fontanería de
federación existente (proxy `/api/proxy/<node>`, tokens, TLS contra CA, detección
http/https, `fetchAtNode`/`getLocalApiUrl` en `lib/api-config.ts`).

## Fases (cada una instalable y útil por separado)

> **Reorden acordado (2026-06-14):** cada vista se migra con su **filtro local** (como
> VMs/Network); la **conversión del selector global** a filtro reactivo se deja para el
> **final**, cuando todas las vistas ya pintan todos los nodos. El piloto fue **Network**
> (no Storage: Storage es la pestaña más pesada — ~15 call-sites de drill-down + acciones
> + config SMART por-nodo — y se trata como fase dedicada).

1. ✅ **Agregador genérico** `/api/federation/aggregate` (+ pytest) **+ piloto Network**
   (tabla all-nodes con columna Nodo + filtro local + drill-down enrutado por `fetchAtNode`;
   resumen sigue-al-filtro). *Hecho — specs/plans en `docs/superpowers/`.*
2. ✅ **Storage** unificado — 4 tablas con columna Nodo + filtro + resumen por-nodo;
   modal de disco (SMART/history/schedule/tools/temperatura) enrutado por `fetchAtNode`
   al nodo del disco; **cero backend** (las schedules son por-nodo, se alcanzan vía el
   disco). *Hecho — spec/plan en `docs/superpowers/`. Revisión final: SHIP-READY.*
   *(Limitación conocida pre-existente: si el `/api/storage` del nodo central falla, el
   guard de error tapa la pestaña aunque haya peers sanos — pendiente para más adelante.)*
3. ✅ **Logs** unificado — logs/events/notifications/backups **merge por tiempo** entre
   nodos + badge Nodo + filtro de cluster (chips sobre los tabs); count cards y backup
   stats **sumados y filtro-aware**; task-log download enrutado al nodo; **cero backend**.
   *Hecho — plan en `docs/superpowers/plans/`. Revisión final: SHIP-READY.*
4. ✅ **Health** unificado — indicador del header = **peor estado** del cluster + info
   **sumado**; modal con **picker de nodo** (por defecto el peor) reutilizando el render
   existente; acknowledge enrutado por nodo; `.status` lo gobierna la salud del cluster.
   **Cero backend.** *Hecho — plan en `docs/superpowers/plans/`. Reviews por-tarea + final
   cross-cutting OK (cazaron: ciclo de fetch, NaN months, guard de ack offline, carrera de
   status, UNKNOWN→verde). SHIP-READY. Falta gate manual.*
5. ✅ **Hardware** — **picker de nodo** en la pestaña (no apilado: 3000 líneas + 6 acciones
   de script lo hacían demasiado invasivo, y el hardware físico se mira de una máquina en una).
   Reutiliza el render; GPU-realtime + managed-installs enrutados por `fetchAtNode`; las 6
   acciones de script (drivers + GPU mode switch) **gated a nodo local** (terminal/WebSocket
   no proxiable) con aviso; modales de detalle se cierran al cambiar de nodo. **Cero backend.**
   *Hecho — plan en `docs/superpowers/plans/`. Reviews por-tarea + final OK. SHIP-READY.*
   *(Desviación del roadmap "apilado" → picker, por riesgo + seguridad de acciones.)*
6. ⏳ **Overview cluster** — iteró: (a) default a tarjetas Cluster, (b) detalle apilado por
   nodo (`SystemOverview` parametrizado por nodo, **construido e instalado** — commits
   `4a63d60d`/`742fb02a`/`0f9510a9`), (c) **rediseño a dashboard de cluster** (lo que el
   usuario quiere): banda agregada + tarjetas ricas por nodo + **gráficas superpuestas (una
   línea por nodo)** + drill-in sin reload al `SystemOverview(node)`. **(c) DISEÑADO Y
   PLANIFICADO, sin implementar** — spec `2026-06-14-cluster-overview-dashboard-design.md` +
   plan `2026-06-14-cluster-overview-dashboard.md` (review Opus aplicada). **← arrancar aquí
   la próxima sesión.** Hoy en los nodos corre la versión (b) apilada.
7. **(Final) Selector global → filtro reactivo** (matar `reload`+proxy-todo).
   **Terminal** y **config por-nodo** mantienen su propio picker dentro de la pestaña.
   Spec: `2026-06-14-federation-reactive-selector-design.md` (diseñado, sin implementar).

Cada fase = brainstorm corto → spec → plan → implementar → rebuild → instalar.

## Estado actual (lo ya hecho en `feature/federation`)

- Federación multi-nodo (proxy, selector, vista Cluster, auto http/https, TLS por peer).
- Detección de updates de apps LXC (catálogo + custom, `pct exec` + GitHub).
- VMs & LXC "Todos los nodos" con gestión in-place (`fetchAtNode`); consola remota
  deshabilitada; filtro por nodo.
- **Fase 1 ✅:** agregador genérico `/api/federation/aggregate` (8 tests pytest, suite 61
  verde) + **Network** convertido a all-nodes (columna Nodo, filtro local, drill-down
  enrutado, resumen sigue-al-filtro, paridad single-node). Revisión final: SHIP-READY.
- **Fase 2 ✅:** **Storage** convertido a all-nodes (4 tablas con columna Nodo, filtro,
  resumen por-nodo, modal de disco enrutado por `fetchAtNode`, cero backend). SHIP-READY.
- **Fase 3 ✅:** **Logs** all-nodes (merge por tiempo, badge Nodo, filtro de cluster sobre
  los tabs, counts/backup-stats filtro-aware, task-log enrutado, cero backend). SHIP-READY.
- **Fase 4 ✅:** **Health** all-nodes (header peor-estado+info sumado, modal con picker de
  nodo, acknowledge enrutado). Reviews por-tarea + final cross-cutting OK. SHIP-READY.
- **Fase 5 ✅:** **Hardware** con picker de nodo (GPU-realtime enrutado, acciones de script
  gated a local). Reviews por-tarea + final OK. SHIP-READY.
- **Fase 6 ⏳:** **Overview** — la versión apilada-por-nodo está construida e instalada en los
  nodos; el **rediseño a dashboard de cluster** (banda + tarjetas ricas + gráficas superpuestas
  + drill-in sin reload) está **diseñado y planificado, sin implementar** (es lo siguiente).
- **El AppImage YA se construye en esta máquina (WSL)**: el `build_appimage.sh` se arregló
  (añadido `libupsclient7`, había FUSE). Claude puede `build_appimage.sh` → reemplazar el
  AppImage commiteado (`AppImage/ProxMenux-1.2.2.2-beta.AppImage`) + regenerar el `.sha256` →
  commit + push, y el one-liner `install_proxmenux.sh` (clona la rama e instala ese AppImage
  prebuilt, NO compila) entrega el build nuevo. **Cada cambio de código necesita rebuild+commit
  del AppImage** para que el instalador lo sirva.
- Specs/planes en `docs/superpowers/specs|plans/`.

## Punto de arranque exacto para la próxima sesión

1. **Implementar el dashboard de cluster Overview (Fase 6c).** Spec + plan ya escritos y
   revisados (Opus): `docs/superpowers/specs/2026-06-14-cluster-overview-dashboard-design.md`
   y `docs/superpowers/plans/2026-06-14-cluster-overview-dashboard.md`. 3 tareas: ClusterDashboard
   (banda+tarjetas+drill-in) → ClusterMetricsCharts (gráficas superpuestas) → build+commit+push.
   Ejecutar por subagentes (Opus), luego rebuild AppImage + push, reinstalar one-liner.
   *(Único punto blando del plan: confirmar de dónde se importa `formatStorage`.)*
2. **Fase 7 — la final:** selector global → filtro reactivo; matar el `reload`+proxy-todo del
   que dependen el drill-in (VMs) y las superficies single-node. NO directa: spec ya escrito
   (`2026-06-14-federation-reactive-selector-design.md`); merece base validada en hardware.
   De paso, resolver el guard de error del nodo central de Storage.
3. (Cuando se pueda) gate manual real en los 2 nodos de todas las vistas.

> Nada se pierde entre sesiones: todo está commiteado en `feature/federation` y documentado aquí.
