"""
Zenith STT sidecar — faster-whisper behind a tiny FastAPI app.
Implements the server half of patent module 101 (speech input) for browsers
without a native speech engine, and for consistent cross-browser voice mode.

POST /stt        raw audio body (webm/opus, wav, ogg…), optional ?lang=hi
                 → {"text": "...", "language": "hi", "duration": 3.2}
GET  /health     → {"ok": true, "model": "small"}

Audio is transcribed in memory and never written to disk (anonymity).
Run: .venv/Scripts/python stt_server.py   (port 8090, model via WHISPER_MODEL)
"""
import io
import os

import uvicorn
from fastapi import FastAPI, Query, Request
from faster_whisper import WhisperModel

MODEL_NAME = os.environ.get("WHISPER_MODEL", "small")
PORT = int(os.environ.get("STT_PORT", "8090"))

app = FastAPI()
print(f"[stt] loading faster-whisper '{MODEL_NAME}' (int8, CPU)…", flush=True)
model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8")
print("[stt] ready", flush=True)


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_NAME}


@app.post("/stt")
async def stt(request: Request, lang: str | None = Query(default=None)):
    audio = await request.body()
    if not audio:
        return {"text": "", "language": lang or "", "duration": 0.0}
    # Whisper language codes are bare ("hi", "ta"); browsers send BCP-47.
    language = lang.split("-")[0] if lang else None
    segments, info = model.transcribe(
        io.BytesIO(audio),
        language=language,
        vad_filter=True,
        beam_size=1,  # greedy: ~2x faster on CPU, fine for short utterances
    )
    text = " ".join(segment.text.strip() for segment in segments).strip()
    return {"text": text, "language": info.language, "duration": info.duration}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
