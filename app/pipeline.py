import contextlib
import json
import logging
import os
import re
import subprocess
import sys
import threading
import time
import wave
from pathlib import Path

import httpx
import numpy as np

WHISPER_MODEL = os.getenv("WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")
DIARIZATION_MODEL = "pyannote/speaker-diarization-community-1"
DEEPINFRA_API_URL = "https://api.deepinfra.com/v1/openai/chat/completions"
DEEPINFRA_DEFAULT_MODEL = "meta-llama/Meta-Llama-3.1-70B-Instruct"

log = logging.getLogger("transcripts")
_diar_pipeline = None
_diar_lock = threading.Lock()


def to_audio(src: Path, wav: Path, preview: Path) -> None:
    # Una sola decodificacion: WAV 16 kHz para Whisper y MP3 liviano para el reproductor web
    subprocess.run(
        [
            "ffmpeg", "-y", "-i", str(src),
            "-vn", "-ac", "1", "-ar", "16000", str(wav),
            "-vn", "-ac", "1", "-b:a", "64k", str(preview),
        ],
        check=True,
        capture_output=True,
    )


_SEG_END = re.compile(r"-->\s*(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\]")


class _SegmentTee:
    """Reenvia stdout y extrae el fin de cada segmento que imprime mlx_whisper (verbose=True)."""

    def __init__(self, real, on_end) -> None:
        self.real = real
        self.on_end = on_end
        self.buf = ""

    def write(self, s: str) -> int:
        self.real.write(s)
        self.buf += s
        *lines, self.buf = self.buf.split("\n")
        for line in lines:
            m = _SEG_END.search(line)
            if m:
                h, mnt, sec = m.groups()
                self.on_end(int(h or 0) * 3600 + int(mnt) * 60 + float(sec))
        return len(s)

    def flush(self) -> None:
        self.real.flush()


def transcribe(wav: Path, language: str | None, audio_s: float, on_fraction, initial_prompt: str | None = None) -> list[dict]:
    import mlx_whisper

    tee = _SegmentTee(sys.stdout, lambda end: on_fraction(min(end / audio_s, 1.0)) if audio_s else None)
    with contextlib.redirect_stdout(tee):
        result = mlx_whisper.transcribe(
            str(wav), path_or_hf_repo=WHISPER_MODEL, language=language or None, verbose=True,
            initial_prompt=initial_prompt,
        )
    return [
        {"start": s["start"], "end": s["end"], "text": s["text"].strip()}
        for s in result["segments"]
        if s["text"].strip()
    ]


def _get_diarizer():
    global _diar_pipeline
    with _diar_lock:
        if _diar_pipeline is None:
            import torch
            from pyannote.audio import Pipeline

            log.info("cargando modelo de diarizacion %s", DIARIZATION_MODEL)
            pipe = Pipeline.from_pretrained(DIARIZATION_MODEL, token=os.environ["HF_TOKEN"])
            pipe.to(torch.device(os.getenv("DIARIZATION_DEVICE", "cpu")))
            _diar_pipeline = pipe
        return _diar_pipeline


def diarize(wav: Path, num_speakers: int | None) -> list[tuple[float, float, str]]:
    import torch

    with wave.open(str(wav), "rb") as w:
        audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    waveform = torch.from_numpy(audio.astype(np.float32) / 32768.0)[None]

    out = _get_diarizer()(
        {"waveform": waveform, "sample_rate": 16000}, num_speakers=num_speakers
    )
    annotation = getattr(out, "exclusive_speaker_diarization", None) or getattr(
        out, "speaker_diarization", out
    )
    return [(t.start, t.end, spk) for t, _, spk in annotation.itertracks(yield_label=True)]


def assign_speakers(segments: list[dict], turns: list[tuple[float, float, str]]) -> None:
    for seg in segments:
        overlap: dict[str, float] = {}
        for start, end, spk in turns:
            o = min(seg["end"], end) - max(seg["start"], start)
            if o > 0:
                overlap[spk] = overlap.get(spk, 0.0) + o
        seg["speaker"] = max(overlap, key=overlap.get) if overlap else None


def llm_refine(segments: list[dict], language: str | None) -> list[dict]:
    api_key = os.getenv("DEEPINFRA_API_KEY", "")
    if not api_key:
        log.warning("DEEPINFRA_API_KEY no configurada; omitiendo refinamiento LLM")
        return segments

    model = os.getenv("DEEPINFRA_MODEL", DEEPINFRA_DEFAULT_MODEL)
    lang_hint = f" El idioma es {language}." if language else ""
    known_speakers = sorted({s["speaker"] for s in segments if s.get("speaker")})
    has_speakers = bool(known_speakers)

    # Numbered list with speaker label so the LLM has full conversational context
    def seg_line(i: int, s: dict) -> str:
        spk = f"[{s['speaker']}] " if s.get("speaker") else ""
        return f"{i}. {spk}{s['text']}"

    numbered = "\n".join(seg_line(i, s) for i, s in enumerate(segments))

    if has_speakers:
        speaker_instruction = (
            f" Los hablantes posibles son: {', '.join(known_speakers)}."
            " Si detectas por contexto conversacional que un segmento está mal atribuido,"
            " corrígelo devolviendo el speaker correcto."
            ' Devuelve un arreglo JSON de objetos con campos "text" y "speaker"'
            ' (speaker puede ser null si no hay hablante asignado).'
            ' Ejemplo: [{"text": "Hola", "speaker": "SPEAKER_00"}, {"text": "Buenas", "speaker": "SPEAKER_01"}]'
        )
    else:
        speaker_instruction = (
            ' Devuelve únicamente un arreglo JSON con los textos corregidos en el mismo orden.'
            ' Ejemplo: ["texto 1", "texto 2"]'
        )

    system_msg = (
        "Eres un corrector de transcripciones automáticas."
        " Corrige errores de transcripción, puntuación y palabras mal reconocidas."
        " NO refrases ni cambies el significado. NO agregues ni elimines contenido."
        f"{speaker_instruction}"
        " No incluyas ningún texto adicional fuera del JSON."
        f"{lang_hint}"
    )
    user_msg = f"Corrige estos segmentos:\n{numbered}"

    try:
        resp = httpx.post(
            DEEPINFRA_API_URL,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={"model": model, "messages": [{"role": "system", "content": system_msg}, {"role": "user", "content": user_msg}]},
            timeout=180.0,
        )
        resp.raise_for_status()
        content = resp.json()["choices"][0]["message"]["content"].strip()
        if content.startswith("```"):
            content = re.sub(r"^```[^\n]*\n?", "", content)
            content = re.sub(r"\n?```$", "", content)
        parsed = json.loads(content)
        if len(parsed) != len(segments):
            log.warning("LLM devolvió %d items pero hay %d segmentos; omitiendo", len(parsed), len(segments))
            return segments
        result = [dict(s) for s in segments]
        for seg, item in zip(result, parsed):
            if isinstance(item, dict):
                seg["text"] = (item.get("text") or seg["text"]).strip() or seg["text"]
                if has_speakers and item.get("speaker") in known_speakers:
                    seg["speaker"] = item["speaker"]
            elif isinstance(item, str):
                seg["text"] = item.strip() or seg["text"]
        log.info("refinamiento LLM aplicado (%d segmentos)", len(result))
        return result
    except Exception:
        log.exception("error en refinamiento LLM; se usará la transcripción original")
        return segments


def _ts(t: float, sep: str = ",") -> str:
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02}:{m:02}:{s:02}{sep}{ms:03}"


# Deben coincidir con groupTurns() en app/static/app.js
TURN_MAX_GAP = 3.0
TURN_MAX_CHARS = 800


def group_turns(segments: list[dict]) -> list[dict]:
    turns: list[dict] = []
    for seg in segments:
        last = turns[-1] if turns else None
        if (
            last
            and last["speaker"] == seg.get("speaker")
            and seg["start"] - last["end"] <= TURN_MAX_GAP
            and last["chars"] <= TURN_MAX_CHARS
        ):
            last["segments"].append(seg)
            last["end"] = seg["end"]
            last["chars"] += len(seg["text"]) + 1
        else:
            turns.append(
                {"speaker": seg.get("speaker"), "start": seg["start"], "end": seg["end"], "chars": len(seg["text"]), "segments": [seg]}
            )
    return turns


def _label(speaker: str | None, names: dict[str, str]) -> str:
    return f"{names.get(speaker) or speaker}: " if speaker else ""


def to_txt(segments: list[dict], names: dict[str, str]) -> str:
    lines = []
    for turn in group_turns(segments):
        text = " ".join(s["text"] for s in turn["segments"])
        lines.append(f"[{_ts(turn['start'], '.')[:8]}] {_label(turn['speaker'], names)}{text}")
    return "\n".join(lines) + "\n"


def to_srt(segments: list[dict], names: dict[str, str]) -> str:
    blocks = []
    for i, seg in enumerate(segments, 1):
        label = _label(seg.get("speaker"), names)
        blocks.append(f"{i}\n{_ts(seg['start'])} --> {_ts(seg['end'])}\n{label}{seg['text']}\n")
    return "\n".join(blocks)


def write_outputs(job_dir: Path, segments: list[dict], names: dict[str, str] | None = None) -> None:
    names = names or {}
    rows = []
    for seg in segments:
        row = {k: v for k, v in seg.items() if k != "speaker_name"}
        if names.get(row.get("speaker")):
            row["speaker_name"] = names[row["speaker"]]
        rows.append(row)
    (job_dir / "result.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2))
    (job_dir / "result.txt").write_text(to_txt(segments, names))
    (job_dir / "result.srt").write_text(to_srt(segments, names))


def run_job(job_dir: Path, language: str | None, do_diarize: bool, num_speakers: int | None, progress) -> None:
    job = job_dir.name[:8]
    src = next(job_dir.glob("input.*"))
    wav = job_dir / "audio.wav"
    t_job = time.monotonic()

    def step(stage: str) -> None:
        log.info("[%s] etapa: %s", job, stage)
        progress(stage)

    step("converting")
    to_audio(src, wav, job_dir / "preview.mp3")
    with wave.open(str(wav), "rb") as w:
        audio_s = w.getnframes() / w.getframerate()
    log.info("[%s] audio de %.1f s (%.1f MB originales)", job, audio_s, src.stat().st_size / 1e6)
    progress("converting", audio_seconds=audio_s)

    step("transcribing")
    t = time.monotonic()
    last_pct = -1

    def on_fraction(f: float) -> None:
        nonlocal last_pct
        if int(f * 100) != last_pct:
            last_pct = int(f * 100)
            progress("transcribing", f)

    # Pass 1 — covers 0–50 % of progress
    segments = transcribe(wav, language, audio_s, lambda f: on_fraction(f * 0.5))
    log.info("[%s] transcripcion paso 1: %d segmentos en %.1f s", job, len(segments), time.monotonic() - t)

    # Pass 2 — use pass-1 text as initial_prompt; covers 50–100 % of progress
    initial_prompt = " ".join(s["text"] for s in segments)
    t2 = time.monotonic()
    segments = transcribe(wav, language, audio_s, lambda f: on_fraction(0.5 + f * 0.5), initial_prompt=initial_prompt)
    log.info("[%s] transcripcion paso 2: %d segmentos en %.1f s", job, len(segments), time.monotonic() - t2)

    if do_diarize:
        step("diarizing")
        t = time.monotonic()
        turns = diarize(wav, num_speakers)
        assign_speakers(segments, turns)
        log.info(
            "[%s] diarizacion lista: %d hablantes en %.1f s",
            job, len({s for _, _, s in turns}), time.monotonic() - t,
        )

    write_outputs(job_dir, segments)
    wav.unlink(missing_ok=True)

    step("refining")
    t = time.monotonic()
    raw_segments = [dict(s) for s in segments]
    refined = llm_refine(segments, language)
    if refined is not segments:
        (job_dir / "result.original.json").write_text(json.dumps(raw_segments, ensure_ascii=False, indent=2))
        write_outputs(job_dir, refined)
    log.info("[%s] refinamiento en %.1f s", job, time.monotonic() - t)

    log.info("[%s] terminado en %.1f s", job, time.monotonic() - t_job)
