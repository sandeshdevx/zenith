# services/inference — Whisper STT sidecar

Server-side speech recognition via
[faster-whisper](https://github.com/SYSTRAN/faster-whisper) (MIT): 90+
languages on CPU, so voice input works in **every** browser (Firefox and
others without a native speech engine record audio with MediaRecorder and
POST it here through the API's authenticated `/api/v1/stt` proxy). Audio is
processed in memory and never written to disk.

## Setup

```bash
cd services/inference
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt   # (bin/pip on Linux)
.venv/Scripts/python stt_server.py              # port 8090; WHISPER_MODEL=small default
```

First start downloads the model (~460 MB for `small`). `base` is 3x faster
and lighter with reduced accuracy; `medium` is better but slow on CPU.

## Still planned (contributions welcome)

- **TTS:** [Piper](https://github.com/rhasspy/piper) (MIT) — server voices
  incl. Indic languages; the browser's speechSynthesis is the current default.
- **Risk model:** fine-tuned MuRIL/IndicBERT classifier behind the same
  `RiskAdapter` shape as the keyword sentinel — blocked on labelled
  multilingual crisis evaluation data (ROADMAP risk R2).
