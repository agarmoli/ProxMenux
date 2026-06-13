# ProxMenux Federación — Vista centralizada multi-nodo (agregador central)

- **Fecha:** 2026-06-13
- **Estado:** Diseño aprobado, pendiente de plan de implementación
- **Ámbito:** Personalización de ProxMenux Monitor para unificar la vista de varios nodos de un mismo cluster Proxmox en un único panel.

---

## 1. Contexto y problema

ProxMenux Monitor (el dashboard web en el puerto `8008`, backend Flask en
`AppImage/scripts/flask_server.py`) está diseñado como **una instancia por nodo**:

- Lee los datos ejecutando comandos **locales** (`pvesh`, `psutil`, `smartctl`,
  `sensors`, `dmidecode`, `journalctl`…).
- Aunque internamente llama a `pvesh get /cluster/resources` (que ve todo el
  cluster), **filtra a propósito todo para mostrar solo el nodo local**
  (`if node != local_node: continue`, en `get_proxmox_vms()`).
- No existe ningún concepto de varios nodos, ni selector, ni agregación.

**Objetivo:** tener un único panel que muestre todos los nodos del cluster con
**las mismas features que ProxMenux ofrece hoy** (no rediseñar nada desde cero).

**Topología objetivo:** un único cluster Proxmox con 2 nodos (la arquitectura no
impide extenderlo a más nodos en el futuro).

---

## 2. Decisión de arquitectura

Se evaluaron dos vías:

### Descartada — "Atacar el cluster directamente" (una sola instalación)

Usar la API de Proxmox (que sabe enrutar a otros nodos del cluster) desde una
única instancia. **No reproduce lo que hay hoy**, porque la mayor parte del valor
de ProxMenux se recoge con comandos locales que **no tienen equivalente en la API
de Proxmox para un nodo remoto**:

| Dato | Origen en ProxMenux | ¿API Proxmox para nodo remoto? |
|---|---|---|
| Temperaturas | `psutil`/`sensors` local | ❌ No existe |
| SMART de discos | `smartctl`/`nvme` local | ❌ No existe |
| Tráfico por interfaz | `psutil`/`/sys/class/net` | ❌ No existe |
| Hardware (BIOS/RAM/PCI/IPMI/UPS/GPU/Coral) | `dmidecode`/`lspci`/`ipmitool`/`upsc` | ❌ No existe |
| Health-checks | SQLite local + `psutil` + `dmesg` | ❌ No existe |
| Logs | `journalctl` local | ❌ No existe |

La API de Proxmox solo da lo básico por nodo (CPU, RAM, carga, uptime, lista de
VMs, RRD, tareas) — que es justo lo que la web nativa de Proxmox en `8006` ya
muestra unificado. Por tanto esta vía daría una vista degradada y redundante.

### Elegida — Federación con agregador central (A2)

Cada nodo sigue corriendo ProxMenux completo (recoge **todos** sus datos locales y
los expone en su `:8008/api/...`). **Uno de los nodos actúa además de "central"**:
añade una capa que llama por HTTP a la API de los demás nodos y lo fusiona todo en
una vista única.

Por qué es viable con poco esfuerzo (la base ya lo soporta):

- El frontend ya consume **todo** vía API REST; hay **un único punto**
  (`AppImage/lib/api-config.ts` → `getApiBaseUrl()`/`fetchApi()`) donde se decide a
  qué host se llama.
- La auth ya es por **token Bearer JWT de 365 días**, **sin cookies ni CSRF**, así
  que una instancia puede llamar a otra servidor-a-servidor sin problema.
- Cada instancia firma con su **propio `JWT_SECRET`**, por eso el central debe
  almacenar **el token de cada nodo** (un token no se reutiliza entre nodos).

---

## 3. Decisiones tomadas

| Decisión | Elección |
|---|---|
| Topología | 1 cluster Proxmox, 2 nodos |
| Vía | Federación (no atacar el cluster directamente) |
| Forma de federación | Agregador central en backend (A2) |
| Despliegue | ProxMenux instalado en **ambos** nodos |
| Aprovisionamiento de tokens | **Semi-manual**: generar token en el nodo peer y pegarlo en la pantalla de ajustes del central |
| Alcance v1 | Vista unificada + drill-in al dashboard completo de cualquier nodo + control de VMs (start/stop) en remoto |
| Fuera de v1 | Terminal/consola web de nodos remotos, aprovisionamiento por SSH, multi-cluster |

---

## 4. Arquitectura

```
                  ┌──────────────── NODO CENTRAL (p. ej. nodo A) ─────────────────┐
  Navegador ──────│  ProxMenux Monitor (existente)  +  Capa Federación (nueva)    │
  (1 login,       │   · sirve sus propios datos en local                          │
   1 token)       │   · /api/proxy/<nodo>/...   → reenvía a la API del peer        │
                  │   · /api/federation/...     → fusiona datos de todos los nodos │
                  │   · federation.json (peers + token de cada uno, chmod 600)     │
                  └───────────────┬───────────────────────────────────────────────┘
                                  │ HTTP + Bearer token (server-to-server)
                                  ▼
                  ┌──────── NODO B (ProxMenux normal, SIN cambios) ────────┐
                  │  expone /api/... con sus datos locales (temps, SMART…)  │
                  └────────────────────────────────────────────────────────┘
```

- Ambos nodos corren ProxMenux igual que hoy.
- El navegador **solo habla con el central**; los tokens de los peers viven en el
  servidor central, nunca en el navegador.
- **Backward-compatible total:** si un nodo no tiene `federation.json`, se comporta
  exactamente como ahora. La federación es puramente aditiva.
- El nodo "central" no es especial a nivel de instalación; es simplemente aquel
  donde configuras la lista de peers.

---

## 5. Componentes backend

Módulos **nuevos** (no se modifica el monolito de `flask_server.py` más allá de
registrar el blueprint, para no engordar un fichero ya de ~10k líneas):

- **`federation_config.py`** — leer/guardar/validar `federation.json`. Estructura
  por peer: `{ "name", "host", "port", "token", "enabled" }`. Ruta:
  `/usr/local/share/proxmenux/federation.json`, permisos `0600`, root.
- **`peer_client.py`** — cliente HTTP (`requests`) hacia cada peer:
  - Cabecera `Authorization: Bearer <token>`.
  - **TLS verificado contra la CA del cluster Proxmox**
    (`/etc/pve/pve-root-ca.pem`), que firma los certificados de todos los nodos y
    está disponible en el nodo central (`requests(..., verify="/etc/pve/pve-root-ca.pem")`).
    Conectando por el hostname/FQDN del nodo (que coincide con el CN del cert) no
    hace falta desactivar la verificación. Solo como último recurso documentado, y
    nunca por defecto, se podría permitir `verify=False`.
  - Timeouts cortos; manejo de errores: timeout/conexión → nodo marcado `offline`;
    `401` → token inválido/caducado. Nunca propaga una excepción que rompa la app.
- **`flask_federation_routes.py`** — blueprint registrado en la app existente:
  - `GET /api/federation/nodes` → lista de nodos + estado (online/offline).
  - `GET /api/federation/overview` → fan-out **concurrente** (thread pool) a cada
    nodo (`/api/system`, `/api/health/status`, `/api/vms`) y devuelve un resumen
    por nodo (CPU, RAM, temp, salud, nº de alertas, nº de VMs).
  - `GET /api/federation/vms` → lista unificada de VMs/LXC de todos los nodos, cada
    una etiquetada con su nodo de origen.
  - `ANY /api/proxy/<node>/<path:endpoint>` → reenvía la petición al peer indicado
    con su token y devuelve la respuesta tal cual. Es lo que permite **reutilizar
    todas las páginas actuales** apuntándolas a un nodo remoto.
  - `GET/POST/DELETE /api/federation/peers` → gestionar la lista de peers desde la
    pantalla de ajustes (incluye un "probar conexión").
- Todas las rutas anteriores van detrás de `@require_auth`.
- El nombre del propio nodo central se obtiene reutilizando
  `get_proxmox_node_name()`; las peticiones al "self" se sirven en local (sin
  proxy).

---

## 6. Componentes frontend

- **Selector de nodo** en la cabecera: contexto React `activeNode` (por defecto el
  central) alimentado por `GET /api/federation/nodes`.
- **Cambio mínimo en `AppImage/lib/api-config.ts`** (único punto de decisión de
  URL): cuando `activeNode` ≠ central, `fetchApi`/`getApiUrl` anteponen
  `/api/proxy/<activeNode>` al endpoint. Con esto **todas las páginas existentes**
  (storage, network, hardware, VMs…) funcionan para cualquier nodo sin tocarlas.
- **Nueva pestaña "Cluster"** — vista única:
  - Una tarjeta por nodo (CPU, RAM, temperatura, salud, nº de alertas).
  - Lista de VMs/LXC de todos los nodos juntos, con su nodo de origen.
  - Pinchar un nodo → fija `activeNode` y lleva a su dashboard completo (vía proxy).
- **Nueva pantalla de ajustes "Federación"** — añadir/quitar nodos (`name`,
  `host`, `port`, `token`) y botón "probar conexión".
- **Terminal en v1:** el botón de terminal/consola se oculta o deshabilita cuando
  `activeNode` ≠ central (la terminal sigue disponible entrando directamente al
  nodo). El WebSocket (`getWebSocketUrl()`) no se proxia en v1.

---

## 7. Flujos de datos

**Carga de la vista única:**

1. Navegador (en el central) → `GET /api/federation/overview`.
2. El central hace fan-out concurrente: local (funciones internas) + cada peer
   (`/api/system`, `/api/health/status`, `/api/vms`).
3. Fusiona → `[{ node, online, cpu, mem, temp, vmCount, alerts }, ...]`.
4. La UI renderiza una tarjeta por nodo.

**Drill-in a un nodo remoto:**

1. El usuario pincha el nodo B → `activeNode = B`.
2. Todas las llamadas del dashboard pasan a `/api/proxy/B/api/...`.
3. El central reenvía a `https://B:8008/api/...` con el token de B.
4. Los componentes existentes renderizan sin cambios.

**Control de VM en remoto:** el `POST /api/vms/<id>/control` existente viaja por el
proxy y se ejecuta en el nodo destino.

---

## 8. Manejo de errores / resiliencia

- Peer caído o inaccesible → en la vista única aparece como `offline` (tarjeta
  atenuada); el resto del panel sigue funcionando. El proxy devuelve un estado
  controlado (p. ej. `502` + `{ "offline": true }`) para que la UI muestre un
  estado amable.
- Token inválido/caducado → `401` del peer → la UI invita a volver a pegar el token
  en ajustes.
- Fan-out con timeout corto y concurrente para que un nodo lento no bloquee la
  vista del resto.
- TLS: se verifica contra la CA del cluster Proxmox (`/etc/pve/pve-root-ca.pem`)
  conectando por el hostname del nodo; no se desactiva la verificación.

---

## 9. Seguridad

- Los tokens de los peers solo viven en `federation.json` (root, `chmod 600`) en el
  central; **nunca** llegan al navegador.
- El navegador se autentica únicamente contra el central, con la auth existente de
  ProxMenux.
- Las rutas de proxy y federación van detrás de `@require_auth`.
- Los tokens no se escriben en logs.

---

## 10. Empaquetado / instalación

- Los módulos nuevos se incluyen en el build del AppImage. El blueprint se
  autoregistra.
- Sin `federation.json` → comportamiento idéntico al actual (nodo único). Por tanto
  el nodo peer no requiere ningún cambio respecto a hoy.
- La designación de "central" es simplemente el nodo en cuya UI configuras los
  peers.

---

## 11. Pruebas

- **Unitarias:** `federation_config` (cargar/guardar/validar), `peer_client` (mock:
  éxito / timeout / `401` / offline), lógica de fusión de `overview` y `vms`.
- **Integración:** el proxy reenvía con el token correcto; los endpoints agregados
  fusionan 2 nodos simulados; nodo offline manejado sin romper.
- **Manual:** validación en el cluster real de 2 nodos.

---

## 12. Fuera de alcance (v1)

- Terminal/consola web de nodos remotos (sigue funcionando entrando directo al
  nodo).
- Aprovisionamiento automático de tokens por SSH (vamos con pegado manual).
- Multi-cluster (varios clusters separados). La arquitectura no lo impide, pero no
  es objetivo de esta versión.
