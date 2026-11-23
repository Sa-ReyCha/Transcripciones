# Setup en Mac nuevo

Guía para instalar y correr la app de transcripciones en un Mac con Apple Silicon (M1/M2/M3/M4).

> **Nota para LLM**: ejecuta cada bloque en orden, verifica el estado esperado antes de continuar y detente si un paso falla.

---

## Requisitos del sistema

- macOS 13 Ventura o superior
- Apple Silicon (M1/M2/M3/M4) — obligatorio para mlx-whisper
- Homebrew instalado (`/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/homebrew/install/HEAD/install.sh)"`)
- Docker Desktop para Mac instalado y corriendo (necesario para el túnel Cloudflare)

---

## 1. Dependencias del sistema

```bash
brew install python@3.12 ffmpeg
```

Verificar:

```bash
python3.12 --version   # debe decir 3.12.x
ffmpeg -version        # debe mostrar versión
```

---

## 2. Clonar / copiar el proyecto

Si tienes el repo en Git:

```bash
git clone <URL_DEL_REPO> ~/transcripts
cd ~/transcripts
```

Si lo copiaste directamente, solo `cd` a la carpeta del proyecto.

---

## 3. Entorno virtual e instalación de dependencias

```bash
python3.12 -m venv .env_santi
.env_santi/bin/pip install --upgrade pip
.env_santi/bin/pip install -r requirements.txt
```

Estado esperado: todos los paquetes instalan sin errores. La primera ejecución puede tardar ~2 minutos.

---

## 4. Archivo de configuración `.env`

Copia la plantilla:

```bash
cp .env.example .env
```

Edita `.env` con los valores correctos:

```dotenv
# Requerido para separación de hablantes (diarización)
HF_TOKEN=hf_xxxxxxxxxxxxxxxxxxxx

# Requerido para refinamiento LLM
DEEPINFRA_API_KEY=xxxxxxxxxxxxxxxxxxxx

# Opcional: protege la web con contraseña
APP_PASSWORD=una_clave_segura

# Deja los demás en sus valores por defecto la primera vez
WHISPER_MODEL=mlx-community/whisper-large-v3-turbo
DIARIZATION_DEVICE=cpu
MAX_UPLOAD_MB=500
DEEPINFRA_MODEL=meta-llama/Meta-Llama-3.1-70B-Instruct
```

### Cómo obtener el HF_TOKEN

1. Crear cuenta en <https://huggingface.co>
2. Ir a Settings → Access Tokens → New token (rol: Read)
3. Copiar el token (empieza con `hf_`)
4. Aceptar las condiciones del modelo en <https://huggingface.co/pyannote/speaker-diarization-community-1>

### Cómo obtener DEEPINFRA_API_KEY

1. Crear cuenta en <https://deepinfra.com>
2. Ir a API Keys → Create API Key
3. Copiar la clave

---

## 5. Correr la aplicación

```bash
.env_santi/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Estado esperado en los logs:

```
INFO:     Started server process [...]
INFO:     Uvicorn running on http://0.0.0.0:8000
```

Abrir <http://localhost:8000> en el navegador. La primera transcripción descarga el modelo Whisper (~1.6 GB a la caché de Hugging Face).

---

## 6. Cloudflare Tunnel (acceso público con HTTPS)

Ver [cloudflare-tunnel.md](./cloudflare-tunnel.md).

---

## Solución de problemas

| Síntoma | Causa probable | Solución |
|---|---|---|
| `mlx_whisper` no instala | Python no es 3.12 o no es Apple Silicon | Verificar `python3.12 --version` y `uname -m` (debe decir `arm64`) |
| `ffmpeg: command not found` | ffmpeg no instalado | `brew install ffmpeg` |
| HTTP 400 "falta HF_TOKEN" | HF_TOKEN vacío | Poner el token en `.env` y reiniciar |
| HTTP 400 "falta DEEPINFRA_API_KEY" | Clave de DeepInfra vacía | Poner la clave en `.env` y reiniciar |
| La barra de progreso queda en 0% | El modelo Whisper se está descargando | Esperar, puede tardar varios minutos la primera vez |
| `diarize=true` es lento | pyannote en CPU | Cambiar `DIARIZATION_DEVICE=mps` en `.env` (solo si el modelo lo soporta) |
