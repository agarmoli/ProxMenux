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
6. ✅ **Overview combinado** como landing — la pestaña aterriza en las **tarjetas de todos
   los nodos** (Cluster) cuando hay peers y no hay nodo en foco; clic en una tarjeta entra
   al detalle de ese nodo (drill-in existente); single-node aterriza en el Overview rico de
   siempre; tarjetas enriquecidas con uptime. **Cero backend** (mayormente wiring: la pestaña
   por defecto se decide por `getActiveNode()`). *Hecho — plan en `docs/superpowers/plans/`.
   Review por-tarea OK (4 escenarios trazados) + carrera de tab cerrada. SHIP-READY.*
7. **(Final) Selector global → filtro reactivo** (matar `reload`+proxy-todo).
   **Terminal** y **config por-nodo** mantienen su propio picker dentro de la pestaña.

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
- **Fase 6 ✅:** **Overview** landing cluster-first (aterriza en tarjetas de todos los nodos;
  drill-in al detalle; single-node sin cambios). Review por-tarea OK. SHIP-READY.
- **6 de 7 fases hechas, solo código (frontend); falta el gate manual en nodos.**
- Specs/planes en `docs/superpowers/specs|plans/`.

## Punto de arranque exacto para la próxima sesión

1. (Gate manual de Fases 1-4+) Rebuild AppImage (`AppImage/scripts/build_appimage.sh`, en un
   nodo — necesita `libupsclient`, ausente en WSL) + instalar en los 2 nodos y comprobar
   **Network / Storage / Logs / Health** (+ **Hardware** cuando cierre) — datos de ambos nodos;
   abrir disco/evento/nodo remoto → datos correctos; header de salud = peor del cluster; nodo
   parado "offline"; single-node idéntico a hoy. Si `./AppRun` crashea, capturar traceback.
2. **Fase 7 — la final (la gran pieza arquitectónica):** selector global → filtro reactivo;
   matar el `reload`+proxy-todo del que dependen hoy el drill-in (cluster cards, VMs), el
   `getActiveNode()`-como-default de Overview, y todas las vistas. NO es "directa": merece
   brainstorm + base validada en hardware debajo (toca el cimiento de las 6 fases). De paso,
   resolver el guard de error del nodo central de Storage. Con eso el dashboard queda
   cluster-first de punta a punta.

> Nada se pierde entre sesiones: todo está commiteado en `feature/federation` y documentado aquí.
