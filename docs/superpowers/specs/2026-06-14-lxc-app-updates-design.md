# LXC App Update Detection — versión instalada vs última en GitHub

- **Fecha:** 2026-06-14
- **Estado:** Diseño aprobado, pendiente de plan de implementación
- **Ámbito:** ProxMenux Monitor. Para cada LXC, saber qué aplicación corre dentro, su versión instalada, y compararla con la última publicada en GitHub para avisar de actualizaciones.
- **Rama de trabajo prevista:** nueva rama a partir de `feature/federation` (es aditivo; no toca la federación).

---

## 1. Contexto y problema

ProxMenux ya detecta actualizaciones de **paquetes de SO** dentro de cada LXC
(`apt list --upgradable` / `apk list -u` vía `pct exec`, en `managed_installs.py`,
mostrado como badge en `virtual-machines.tsx`). Pero eso es a nivel de paquetes del
sistema, **no de la aplicación** que corre en el contenedor (Jellyfin, *arr,
Nextcloud…). El objetivo es: por cada LXC, conocer la **app**, su **versión
instalada**, y la **última versión en GitHub**, para indicar si hay update.

---

## 2. Decisiones tomadas (durante el brainstorming)

| Decisión | Elección |
|---|---|
| Cómo se identifica la app de cada CT | **Asignación manual por CT** (no autodetección) |
| Qué aporta el usuario al asignar | **Elegir de una lista curada + opción custom** (la lista trae repo y método de versión pre-rellenados) |
| Dónde vive el catálogo | **Empaquetado** en el AppImage (JSON), editable; catálogo remoto queda como fase futura |
| Versión instalada | Se **lee** dentro del CT (fichero/binario preferente; comando si hace falta), no se teclea a mano |
| Alcance v1 | Solo **detectar/avisar**; no aplicar updates; sin autodetección |

---

## 3. Arquitectura

Reutiliza la infraestructura existente y añade un módulo aislado:

- **Ejecución dentro del CT:** patrón `pct exec <vmid> -- sh -c "<cmd>"` ya usado en
  `managed_installs.py` (`_run_pct_pkg_listing`).
- **Consulta a GitHub:** patrón `urllib.request` con `User-Agent` + caché en memoria
  ya usado (`_fetch_gasket_latest_tag`, self-update de ProxMenux). Se reutiliza
  `urllib` (no `requests`) por consistencia con el resto del version-check.
- **Comparación de versiones:** helper `_version_tuple()` existente.
- **Surface:** se adjunta el resultado a cada LXC dentro de `/api/vms`, junto al
  `update_check` actual. La UI lo pinta en el badge/modal de `virtual-machines.tsx`.
- **Módulo nuevo:** `AppImage/scripts/lxc_app_updates.py` (catálogo, asignaciones,
  lectura de versión, fetch de GitHub, comparación). No se engorda `flask_server.py`
  ni `managed_installs.py` salvo el cableado mínimo.

**Federación:** el chequeo corre **por nodo** (como el escaneo apt/apk). Como el
resultado viaja en `/api/vms`, el nodo central lo **agrega automáticamente** vía el
proxy de federación. No requiere trabajo adicional.

---

## 4. El catálogo (empaquetado)

Fichero: `AppImage/json/lxc_app_catalog.json`. Se copia al runtime en el build (una
línea `cp` en `build_appimage.sh`). Estructura por app:

```json
{
  "version": 1,
  "apps": [
    {
      "id": "jellyfin",
      "name": "Jellyfin",
      "repo": "jellyfin/jellyfin",
      "github_source": "releases",
      "tag_regex": "v?(\\d+\\.\\d+\\.\\d+)",
      "installed": {
        "method": "command",
        "value": "jellyfin --version 2>/dev/null || cat /usr/lib/jellyfin/version.txt",
        "regex": "(\\d+\\.\\d+\\.\\d+)"
      }
    }
  ]
}
```

Campos:
- `github_source`: `releases` (usa `/releases/latest`, ignora pre-releases) o `tags`
  (usa `/tags?per_page=…`, primer tag que casa `tag_regex`).
- `tag_regex`: extrae la versión comparable del tag/release name.
- `installed.method`: `file` (lee y casa `regex`) o `command` (ejecuta y casa `regex`).
- `installed.regex`: extrae la versión comparable de la salida.

Set inicial (~15-20, solo apps que versionan en GitHub): Jellyfin,
Radarr/Sonarr/Prowlarr/Bazarr, qBittorrent, Nextcloud, AdGuard Home, Pi-hole,
Home Assistant Core, Vaultwarden, Paperless-ngx, Immich, Tautulli, Uptime Kuma,
Grafana, Gotify. Se prioriza lectura por **fichero/binario** (sin API keys). El set
exacto se afina en el plan. (Apps propietarias/sin releases en GitHub —p.ej. Plex—
quedan para *custom* o fuera.)

---

## 5. Asignación por CT

- **Almacenamiento:** se reutiliza el registro existente `managed_installs.json`,
  añadiendo por entrada LXC un campo `app_assignment`:
  ```json
  { "app_id": "jellyfin" }                       // app del catálogo
  // o custom:
  { "app_id": "custom", "repo": "owner/repo", "github_source": "releases",
    "tag_regex": "...", "installed": { "method": "command", "value": "...", "regex": "..." } }
  ```
- **UI:** en el modal del LXC (donde ya está la pestaña *updates*), un selector
  **"Application"**: desplegable con el catálogo + entrada **"Custom…"**. Al elegir una
  app del catálogo se rellena todo automáticamente; *Custom* muestra los campos
  (repo, source, comando/fichero, regex). Botón para quitar la asignación.

---

## 6. Lógica de chequeo (`lxc_app_updates.py`)

Funciones principales (unidades pequeñas y testeables):
- `load_catalog()` → lee y cachea el JSON del catálogo.
- `get_assignment(vmid)` / `set_assignment(vmid, data)` / `clear_assignment(vmid)` →
  CRUD sobre `managed_installs.json`.
- `read_installed_version(vmid, spec)` → resuelve `installed.method`:
  - `command`: `pct exec <vmid> -- sh -c "<value>"`, casa `regex`.
  - `file`: `pct exec <vmid> -- cat "<value>"`, casa `regex`.
  - Requiere CT arrancado; timeout corto; devuelve versión o `None`.
- `fetch_latest(repo, source, tag_regex)` → GitHub vía `urllib`:
  - `releases`: `GET /repos/{repo}/releases/latest`.
  - `tags`: `GET /repos/{repo}/tags?per_page=20`, primer tag que casa.
  - Caché en memoria con TTL (p.ej. 6-12 h) por repo; `User-Agent` y, si hay PAT,
    cabecera `Authorization: Bearer <PAT>`.
- `compare(installed, latest)` → si ambos son semver → comparación por tupla
  (`update_available` = latest > installed); si no, igualdad de string
  (`update_available` = distintos, marcado `non_semver`).
- `check_lxc_app(vmid)` → orquesta lo anterior y devuelve:
  ```json
  { "app_id": "jellyfin", "name": "Jellyfin",
    "installed": "1.2.0", "latest": "1.3.0",
    "update_available": true, "repo": "jellyfin/jellyfin",
    "last_check": "…", "error": null, "non_semver": false }
  ```

El resultado se cachea por CT y se adjunta a cada LXC en `get_proxmox_vms()` como
campo `app_update`. El refresco sigue el mismo patrón perezoso que el escaneo de
paquetes (no en cada request; con TTL).

---

## 7. API + UI

**Endpoints nuevos** (blueprint o rutas en el área de LXC, detrás de `@require_auth`):
- `GET /api/lxc-app-catalog` → lista del catálogo para el desplegable.
- `GET /api/vms/<int:vmid>/app` → asignación actual.
- `POST /api/vms/<int:vmid>/app` → fijar asignación (catálogo o custom).
- `DELETE /api/vms/<int:vmid>/app` → quitar asignación.
- `POST /api/vms/<int:vmid>/app/check` → forzar re-chequeo (ignora caché).

**Cambios de datos:**
- `/api/vms`: cada LXC gana `app_update` (la estructura de §6) cuando tiene
  asignación; ausente si no.

**UI (`virtual-machines.tsx`):**
- Chip en la fila/badge: **"Jellyfin 1.2.0 → 1.3.0 ⬆"** (o "al día" / "—").
- Sección en el modal del LXC: app asignada, versión instalada, última, enlace al
  repo, botón "Comprobar ahora", y el formulario de asignación (lista + custom).

---

## 8. Manejo de errores (estados claros, nunca rompe la vista)

| Situación | Estado mostrado |
|---|---|
| CT parado | `error: "container stopped"` → "versión instalada desconocida" |
| Comando/fichero ausente o sin match de regex | `installed: null` → "no se pudo leer la versión" |
| Repo inexistente / 404 | `error: "repo not found"` |
| GitHub rate-limited (403 + ratelimit) | `error: "rate limited"` → sugiere PAT |
| Versión no semver | `non_semver: true` → muestra ambas, "comparación no estricta" |
| `pct`/red no disponible | `error` con detalle; el resto de la vista sigue |

---

## 9. Seguridad

- **PAT de GitHub (opcional):** se guarda en la config existente de ProxMenux
  (fichero con permisos `0600`, root), nunca se devuelve al frontend; solo se indica
  si está configurado. Sube el límite de 60/h a 5000/h.
- **Comandos custom:** los introduce el administrador autenticado; se ejecutan vía
  `pct exec <vmid> -- sh -c "<cmd>"`. `vmid` se valida como entero. Es ejecución
  deliberada de comandos por el operador (mismo modelo que el resto de ProxMenux,
  que ya corre como root); no es entrada no confiable de terceros.
- Endpoints detrás de `@require_auth` (y mutaciones con el scope que aplique en el
  build de federación).

---

## 10. Pruebas

- **Unitarias:** parseo del catálogo; `read_installed_version` con salidas simuladas
  (match/no-match, fichero vs comando); `compare` (semver mayor/igual/menor y
  no-semver); `fetch_latest` con GitHub mockeado (releases, tags, 404, rate-limit);
  CRUD de asignación sobre un registro temporal.
- **Integración:** `check_lxc_app` de extremo a extremo con `pct` y `urllib`
  mockeados; presencia de `app_update` en el payload de `/api/vms`.
- **Manual:** en un CT real con una app del catálogo y otra custom.

---

## 11. Fuera de alcance (v1)

- Autodetección de la app (se hace asignación manual).
- **Aplicar** actualizaciones (solo detectar/avisar).
- Catálogo remoto/auto-actualizable (fase B futura).
- Apps que requieren API key para leer su versión (se prefieren métodos por
  fichero/binario; lo demás se cubre con *custom*).
