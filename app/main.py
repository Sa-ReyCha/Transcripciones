import json
import logging
import os
import queue
import re
import secrets
import shutil
import threading
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("transcripts")


class _HidePolling(logging.Filter):
    # El navegador consulta el estado cada 3 s y tapa los logs utiles
    def filter(self, record: logging.LogRecord) -> bool:
        return "GET /api/jobs/" not in record.getMessage()


logging.getLogger("uvicorn.access").addFilter(_HidePolling())

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile  # noqa: E402
from fastapi.responses import FileResponse  # noqa: E402
from fastapi.security import HTTPBasic, HTTPBasicCredentials  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from pydantic import BaseModel  # noqa: E402

from . import pipeline  # noqa: E402

BASE = Path(__file__).resolve().parent.parent
JOBS_DIR = BASE / "data" / "jobs"
JOBS_DIR.mkdir(parents=True, exist_ok=True)
MAX_BYTES = int(os.getenv("MAX_UPLOAD_MB", "500")) * 1024 * 1024
JOB_RETENTION_DAYS = int(os.getenv("JOB_RETENTION_DAYS", "15"))
ALLOWED_EXT = {".mp3", ".wav", ".m4a", ".mp4", ".mov", ".webm", ".ogg", ".flac", ".aac", ".mkv"}
FORMATS = {"txt": "text/plain", "srt": "application/x-subrip", "json": "application/json"}
ID_RE = re.compile(r"^[0-9a-f]{32}$")
MAX_SEGMENT_CHARS = 5000
MAX_SPEAKER_NAME_CHARS = 40

jobs_q: queue.Queue[str] = queue.Queue()
meta_lock = threading.Lock()
edit_lock = threading.Lock()
security = HTTPBasic(auto_error=False)


def auth(creds: HTTPBasicCredentials | None = Depends(security)) -> None:
    pwd = os.getenv("APP_PASSWORD")
    if not pwd:
        return
    if creds is None or not secrets.compare_digest(creds.password.encode(), pwd.encode()):
        raise HTTPException(401, headers={"WWW-Authenticate": "Basic"})


def read_meta(job_id: str) -> dict:
    if not ID_RE.match(job_id):
        raise HTTPException(404)
    path = JOBS_DIR / job_id / "meta.json"
    if not path.exists():
        raise HTTPException(404)
    return json.loads(path.read_text())


def write_meta(job_id: str, **changes) -> dict:
    with meta_lock:
        path = JOBS_DIR / job_id / "meta.json"
        meta = json.loads(path.read_text()) if path.exists() else {}
        meta.update(changes)
        path.write_text(json.dumps(meta))
        return meta


def worker() -> None:
    while True:
        job_id = jobs_q.get()
        meta = read_meta(job_id)
        log.info("[%s] inicio: %s (idioma=%s, diarizar=%s)", job_id[:8], meta["filename"], meta["language"] or "auto", meta["diarize"])
        try:
            write_meta(job_id, status="processing", stage="starting", progress=None)
            pipeline.run_job(
                JOBS_DIR / job_id,
                meta["language"],
                meta["diarize"],
                meta["num_speakers"],
                lambda stage, fraction=None, **extra: write_meta(job_id, stage=stage, progress=fraction, **extra),
            )
            write_meta(job_id, status="done", stage="done", progress=1.0)
        except Exception as e:  # noqa: BLE001
            log.exception("[%s] fallo", job_id[:8])
            write_meta(job_id, status="error", error=str(e)[:500])


def purge_old_jobs() -> None:
    cutoff = time.time() - JOB_RETENTION_DAYS * 86400
    removed = 0
    for d in JOBS_DIR.iterdir():
        if not d.is_dir():
            continue
        meta_path = d / "meta.json"
        try:
            meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
            created_at = meta.get("created_at") or d.stat().st_mtime
            if created_at < cutoff and meta.get("status") not in ("queued", "processing"):
                shutil.rmtree(d)
                removed += 1
        except Exception:
            log.exception("error al intentar borrar job %s", d.name)
    if removed:
        log.info("limpieza: %d job(s) borrados (más de %d días)", removed, JOB_RETENTION_DAYS)


def cleanup_worker() -> None:
    while True:
        time.sleep(86400)  # cada 24 horas
        purge_old_jobs()


@asynccontextmanager
async def lifespan(_: FastAPI):
    purge_old_jobs()
    for d in sorted(JOBS_DIR.iterdir(), key=lambda p: p.stat().st_mtime):
        meta_path = d / "meta.json"
        if meta_path.exists() and json.loads(meta_path.read_text())["status"] in ("queued", "processing"):
            write_meta(d.name, status="queued")
            jobs_q.put(d.name)
    threading.Thread(target=worker, daemon=True).start()
    threading.Thread(target=cleanup_worker, daemon=True).start()
    yield


app = FastAPI(lifespan=lifespan, dependencies=[Depends(auth)])
# Los montajes quedan fuera de la dependencia global; solo sirven CSS y JS
app.mount("/static", StaticFiles(directory=BASE / "app" / "static"), name="static")


@app.get("/")
def index():
    return FileResponse(BASE / "app" / "static" / "index.html")


@app.post("/api/jobs")
async def create_job(
    file: UploadFile = File(...),
    language: str = Form(""),
    diarize: bool = Form(False),
    num_speakers: int | None = Form(None),
):
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_EXT:
        raise HTTPException(400, f"Formato no soportado: {ext or 'desconocido'}")
    if diarize and not os.getenv("HF_TOKEN"):
        raise HTTPException(400, "Diarizacion no disponible: falta HF_TOKEN en el servidor")
    if language and not re.fullmatch(r"[a-z]{2,3}", language):
        raise HTTPException(400, "Idioma invalido")

    job_id = uuid.uuid4().hex
    job_dir = JOBS_DIR / job_id
    job_dir.mkdir()
    size = 0
    with open(job_dir / f"input{ext}", "wb") as out:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_BYTES:
                out.close()
                shutil.rmtree(job_dir)
                raise HTTPException(413, "Archivo demasiado grande")
            out.write(chunk)

    write_meta(
        job_id,
        id=job_id,
        filename=Path(file.filename).name,
        status="queued",
        stage="queued",
        language=language or None,
        diarize=diarize,
        num_speakers=num_speakers,
        error=None,
        progress=None,
        audio_seconds=None,
        created_at=time.time(),
    )
    jobs_q.put(job_id)
    log.info("[%s] recibido: %s (%.1f MB), en cola: %d", job_id[:8], Path(file.filename).name, size / 1e6, jobs_q.qsize())
    return {"id": job_id}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    meta = read_meta(job_id)
    return {
        **{k: meta[k] for k in ("id", "filename", "status", "stage", "error")},
        **{k: meta.get(k) for k in ("progress", "audio_seconds", "diarize", "created_at")},
    }


def _done_dir(job_id: str) -> Path:
    meta = read_meta(job_id)
    if meta["status"] != "done":
        raise HTTPException(409, "El trabajo aun no termina")
    return JOBS_DIR / job_id


@app.get("/api/jobs/{job_id}/transcript")
def get_transcript(job_id: str):
    job_dir = _done_dir(job_id)
    segments = json.loads((job_dir / "result.json").read_text())
    meta = read_meta(job_id)
    return {
        "id": job_id,
        "filename": meta["filename"],
        "audio_seconds": meta.get("audio_seconds") or (segments[-1]["end"] if segments else 0),
        "edited": (job_dir / "result.original.json").exists(),
        "speaker_names": meta.get("speaker_names") or {},
        "segments": segments,
    }


class TranscriptEdit(BaseModel):
    texts: list[str]


@app.put("/api/jobs/{job_id}/transcript")
def edit_transcript(job_id: str, body: TranscriptEdit):
    job_dir = _done_dir(job_id)
    with edit_lock:
        segments = json.loads((job_dir / "result.json").read_text())
        if len(body.texts) != len(segments):
            raise HTTPException(400, "La cantidad de textos no coincide con los segmentos")
        texts = [" ".join(t.split()) for t in body.texts]
        if any(not t or len(t) > MAX_SEGMENT_CHARS for t in texts):
            raise HTTPException(400, f"Cada frase debe tener entre 1 y {MAX_SEGMENT_CHARS} caracteres")
        backup = job_dir / "result.original.json"
        if not backup.exists():
            shutil.copyfile(job_dir / "result.json", backup)
        for seg, text in zip(segments, texts):
            seg["text"] = text
        pipeline.write_outputs(job_dir, segments, read_meta(job_id).get("speaker_names"))
    log.info("[%s] transcript editado", job_id[:8])
    return {"ok": True}


class SpeakerNames(BaseModel):
    names: dict[str, str]


@app.put("/api/jobs/{job_id}/speakers")
def rename_speakers(job_id: str, body: SpeakerNames):
    job_dir = _done_dir(job_id)
    with edit_lock:
        segments = json.loads((job_dir / "result.json").read_text())
        labels = {s["speaker"] for s in segments if s.get("speaker")}
        names = {}
        for label, name in body.names.items():
            name = " ".join(name.split())
            if label not in labels:
                raise HTTPException(400, f"Hablante desconocido: {label}")
            if len(name) > MAX_SPEAKER_NAME_CHARS:
                raise HTTPException(400, f"El nombre no puede pasar de {MAX_SPEAKER_NAME_CHARS} caracteres")
            if name:
                names[label] = name
        write_meta(job_id, speaker_names=names)
        pipeline.write_outputs(job_dir, segments, names)
    log.info("[%s] hablantes renombrados: %s", job_id[:8], names)
    return {"names": names}


@app.get("/api/jobs/{job_id}/audio")
def get_audio(job_id: str):
    read_meta(job_id)
    job_dir = JOBS_DIR / job_id
    preview = job_dir / "preview.mp3"
    path = preview if preview.exists() else next(job_dir.glob("input.*"), None)
    if path is None:
        raise HTTPException(404)
    return FileResponse(path)


@app.get("/api/jobs/{job_id}/download/{fmt}")
def download(job_id: str, fmt: str):
    meta = read_meta(job_id)
    if fmt not in FORMATS or meta["status"] != "done":
        raise HTTPException(404)
    stem = Path(meta["filename"]).stem
    return FileResponse(
        JOBS_DIR / job_id / f"result.{fmt}", media_type=FORMATS[fmt], filename=f"{stem}.{fmt}"
    )
