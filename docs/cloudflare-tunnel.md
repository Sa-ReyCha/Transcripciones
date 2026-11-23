# Cloudflare Tunnel

Expone la app al público con HTTPS usando un túnel Cloudflare. El túnel corre en Docker; la app Python sigue corriendo nativa en el Mac.

> **Nota para LLM**: este proceso requiere una cuenta de Cloudflare y un dominio gestionado por Cloudflare. Si solo quieres probar con una URL temporal (sin cuenta), ve a la sección **Túnel rápido (prueba)** al final.

---

## Arquitectura

```
Internet → Cloudflare CDN → cloudflared (Docker) → localhost:8000 (Python app)
```

`cloudflared` corre como contenedor Docker y se conecta a la red del host del Mac para alcanzar `host.docker.internal:8000`.

---

## Prerequisitos

- Docker Desktop para Mac corriendo
- Cuenta en <https://cloudflare.com>
- Un dominio añadido a Cloudflare (o un subdominio de un dominio que ya tengas ahí)

---

## 1. Crear el túnel en el dashboard de Cloudflare

1. Ir a **Zero Trust** → **Networks** → **Tunnels** → **Create a tunnel**
2. Elegir **Cloudflared** como conector
3. Darle un nombre (ej. `transcripts-mac`)
4. En la siguiente pantalla, seleccionar **Docker** como entorno
5. Cloudflare muestra un comando como:
   ```
   docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token eyJ...
   ```
6. **Copiar solo el token** (la cadena larga después de `--token`)

---

## 2. Configurar el archivo `.env`

Añadir el token al `.env` del proyecto:

```dotenv
CLOUDFLARE_TUNNEL_TOKEN=eyJ0eXAiOiJKV1QiLCJhbGciOi...
```

---

## 3. Configurar el hostname público

En el mismo flujo del dashboard de Cloudflare, o en **Tunnels → tu túnel → Public Hostnames → Add**:

| Campo | Valor |
|---|---|
| Subdomain | `transcripts` (o el que quieras) |
| Domain | tu dominio en Cloudflare |
| Type | HTTP |
| URL | `host.docker.internal:8000` |

Guardar. Cloudflare asigna el certificado HTTPS automáticamente.

---

## 4. Levantar el túnel con Docker Compose

Con la app Python ya corriendo (`uvicorn` en puerto 8000):

```bash
docker compose up -d cloudflared
```

Ver logs:

```bash
docker compose logs -f cloudflared
```

Estado esperado:

```
INF Connection ... registered connIndex=0 ...
INF Connection ... registered connIndex=1 ...
```

La app ya es accesible en `https://transcripts.tudominio.com`.

---

## 5. Levantar todo de un solo comando

Primero iniciar la app Python (en una terminal aparte o con un script de inicio):

```bash
# Terminal 1 — app Python (nativa, necesita el Mac directamente)
.env_santi/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000

# Terminal 2 — túnel (Docker)
docker compose up -d cloudflared
```

O crear un script `start.sh`:

```bash
#!/bin/bash
set -e
docker compose up -d cloudflared
.env_santi/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
```

```bash
chmod +x start.sh
./start.sh
```

---

## 6. Detener

```bash
# Detener el túnel
docker compose down

# Detener la app: Ctrl+C en la terminal donde corre uvicorn
```

---

## Túnel rápido (prueba, sin cuenta)

Para probar sin cuenta de Cloudflare ni dominio propio:

```bash
docker compose --profile quick-tunnel up cloudflared-quick
```

Cloudflare asigna una URL aleatoria `https://xxxx.trycloudflare.com`. Válida mientras el contenedor esté corriendo; se pierde al reiniciar.

---

## Seguridad recomendada al exponer la app

- Definir `APP_PASSWORD` en `.env` para proteger con HTTP Basic Auth
- En el dashboard de Cloudflare → Zero Trust → Access, añadir una política de acceso para restringir por email o dominio
