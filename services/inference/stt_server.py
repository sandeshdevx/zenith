"""
Zenith speech sidecar — faster-whisper STT + edge-tts neural voices.
Implements the server half of patent module 101 (speech input) for browsers
without a native speech engine, and for consistent cross-browser voice mode.

POST /stt        raw audio body (webm/opus, wav, ogg…), optional ?lang=hi
                 → {"text": "...", "language": "hi", "duration": 3.2}
POST /tts        {"text": "...", "lang": "hi"} → audio/mpeg (neural voice)
GET  /health     → {"ok": true, "model": "small"}

Audio is processed in memory and never written to disk (anonymity).
NOTE on /tts: edge-tts synthesizes via Microsoft's free online neural
voices — the buddy's REPLY text (never the user's words, never any
identity) is sent to that service. Set ZENITH_TTS=off to disable and
fall back to the browser's local speechSynthesis.
Run: .venv/Scripts/python stt_server.py   (port 8090, model via WHISPER_MODEL)
"""
import io
import os

import edge_tts
import uvicorn
from fastapi import FastAPI, Query, Request, Response
from fastapi.responses import StreamingResponse
from contextlib import asynccontextmanager
from faster_whisper import WhisperModel

MODEL_NAME = os.environ.get("WHISPER_MODEL", "small")  # 'tiny' for max speed, 'medium' for max accuracy
PORT = int(os.environ.get("STT_PORT", "8090"))
TTS_ENGINE = os.environ.get("ZENITH_TTS", "edge")

# Preferred warm voices (Indian variants for languages spoken in India).
# Everything else resolves dynamically from edge-tts's full catalogue at
# startup — every language Microsoft's neural voices support, ~140 locales.
PREFERRED_VOICES = {
    "en": "en-IN-NeerjaNeural",
    "hi": "hi-IN-SwaraNeural",
    "ta": "ta-IN-PallaviNeural",
    "te": "te-IN-ShrutiNeural",
    "bn": "bn-IN-TanishaaNeural",
    "mr": "mr-IN-AarohiNeural",
    "kn": "kn-IN-SapnaNeural",
    "gu": "gu-IN-DhwaniNeural",
    "ml": "ml-IN-SobhanaNeural",
    "pa": "pa-IN-VaaniNeural",
    "ur": "ur-IN-GulNeural",
}

TTS_VOICES: dict[str, str] = dict(PREFERRED_VOICES)


async def build_voice_catalogue() -> None:
    """Map every language edge-tts knows to one pleasant neural voice.
    Preference: Indian regional variant > female voice > first available."""
    try:
        voices = await edge_tts.list_voices()
    except Exception as err:  # offline at startup — preferred map still works
        print(f"[tts] voice catalogue unavailable ({err}); using preferred map", flush=True)
        return
    by_lang: dict[str, list[dict]] = {}
    for voice in voices:
        lang = voice["Locale"].split("-")[0].lower()
        by_lang.setdefault(lang, []).append(voice)
    for lang, options in by_lang.items():
        if lang in PREFERRED_VOICES:
            continue
        options.sort(
            key=lambda v: (
                0 if v["Locale"].endswith("-IN") else 1,
                0 if v.get("Gender") == "Female" else 1,
                v["ShortName"],
            )
        )
        TTS_VOICES[lang] = options[0]["ShortName"]
    print(f"[tts] voice catalogue ready: {len(TTS_VOICES)} languages", flush=True)

@asynccontextmanager
async def lifespan(app: FastAPI):
    await build_voice_catalogue()
    yield

app = FastAPI(lifespan=lifespan)

# Auto-detect GPU: CUDA gives ~3-5x speedup on GTX 1650 and above.
# Falls back to CPU int8 silently if CUDA is unavailable.
try:
    model = WhisperModel(MODEL_NAME, device="cuda", compute_type="float16")
    print(f"[stt] loaded '{MODEL_NAME}' on GPU (float16, fast)", flush=True)
except Exception:
    model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8")
    print(f"[stt] loaded '{MODEL_NAME}' on CPU (int8)", flush=True)
print("[stt] ready — multilingual, auto-detect, 99 languages", flush=True)
_on_gpu = model.model.device == "cuda"


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_NAME}


@app.post("/stt")
async def stt(request: Request, lang: str | None = Query(default=None)):
    global model, _on_gpu
    audio = await request.body()
    if not audio:
        return {"text": "", "language": lang or "", "duration": 0.0}
    language = lang.split("-")[0] if lang else None

    def _transcribe(audio_bytes: bytes):
        segments, info = model.transcribe(
            io.BytesIO(audio_bytes),
            language=language,
            vad_filter=True,
            beam_size=1,
        )
        return " ".join(s.text.strip() for s in segments).strip(), info

    try:
        text, info = _transcribe(audio)
    except RuntimeError as exc:
        # cuBLAS / CUDA DLL missing (e.g. CUDA 11 system, needs 12) —
        # reload on CPU and retry the same request transparently.
        if _on_gpu and ("cublas" in str(exc).lower() or "cuda" in str(exc).lower()):
            print(f"[stt] GPU runtime error — switching to CPU: {exc}", flush=True)
            model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8")
            _on_gpu = False
            text, info = _transcribe(audio)
        else:
            raise

    return {"text": text, "language": info.language, "duration": info.duration}


@app.get("/tts")
async def tts_get(text: str, lang: str = "en"):
    if TTS_ENGINE != "edge":
        return Response(status_code=404)
    text = text.strip()[:600]
    if not text:
        return Response(status_code=400)
    lang = lang.split("-")[0]
    voice = TTS_VOICES.get(lang, TTS_VOICES["en"])
    
    async def audio_stream():
        communicate = edge_tts.Communicate(text, voice, rate="-4%")
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                yield chunk["data"]
                
    return StreamingResponse(audio_stream(), media_type="audio/mpeg")

@app.post("/tts")
async def tts(payload: dict):
    if TTS_ENGINE != "edge":
        return Response(status_code=404)
    text = (payload.get("text") or "").strip()[:600]
    if not text:
        return Response(status_code=400)
    lang = (payload.get("lang") or "en").split("-")[0]
    voice = TTS_VOICES.get(lang, TTS_VOICES["en"])
    
    async def audio_stream():
        communicate = edge_tts.Communicate(text, voice, rate="-4%")
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                yield chunk["data"]
                
    return StreamingResponse(audio_stream(), media_type="audio/mpeg")


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
