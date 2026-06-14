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

1. **Agregador genérico** `/api/federation/aggregate` (+ tests pytest). Pieza base.
2. **Selector → filtro global "Todos"** (default Todos) + contexto/estado que leen las vistas.
3. **Overview combinado** como landing.
4. **Storage** unificado (columna Nodo).
5. **Network** unificado (columna Nodo).
6. **Logs** unificado (merge por tiempo + Nodo).
7. **Health** unificado.
8. **Hardware** apilado por nodo; **Terminal** y **config por-nodo** con su propio picker.

Cada fase = brainstorm corto → spec → plan → implementar → rebuild → instalar.

## Estado actual (lo ya hecho en `feature/federation`)

- Federación multi-nodo (proxy, selector, vista Cluster, auto http/https, TLS por peer).
- Detección de updates de apps LXC (catálogo + custom, `pct exec` + GitHub).
- VMs & LXC "Todos los nodos" con gestión in-place (`fetchAtNode`); consola remota
  deshabilitada; filtro por nodo.
- Specs/planes en `docs/superpowers/specs|plans/`.

## Punto de arranque exacto para la próxima sesión

1. (Antes) Validar que el build actual arranca/funciona en los 2 nodos (reinstalar con
   reinicio limpio; si crashea, capturar `./AppRun` traceback — único pendiente abierto).
2. **Brainstorm de la Fase 1** (agregador genérico) + confirmar el modelo selector-como-filtro.
3. De ahí, fases 3-8 en orden, reutilizando el agregador.

> Nada se pierde entre sesiones: todo está commiteado en `feature/federation` y documentado aquí.
