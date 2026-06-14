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
2. **Storage** unificado — fase dedicada (presupuestar ~15 call-sites + semántica de
   schedules/tools por-nodo).
3. **Logs** unificado (merge por tiempo + Nodo).
4. **Health** unificado.
5. **Hardware** apilado por nodo.
6. **Overview combinado** como landing.
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
- Specs/planes en `docs/superpowers/specs|plans/`.

## Punto de arranque exacto para la próxima sesión

1. (Antes — gate manual de la Fase 1) Rebuild AppImage (`AppImage/scripts/build_appimage.sh`)
   + instalar en los 2 nodos y comprobar la pestaña Network: interfaces de ambos con
   columna Nodo, chips de filtro, drill-down de interfaz remota correcto, nodo parado como
   "offline". Si `./AppRun` crashea (cabo suelto previo), capturar el traceback.
2. **Brainstorm de la Fase 2** (Storage unificado) — su propia fase, reutilizando el
   agregador; presupuestar los ~15 call-sites de drill-down + semántica schedules/tools.
3. De ahí, fases 3-6 (Logs/Health/Hardware/Overview) reutilizando el agregador, y la
   fase 7 final (selector global → filtro reactivo).

> Nada se pierde entre sesiones: todo está commiteado en `feature/federation` y documentado aquí.
