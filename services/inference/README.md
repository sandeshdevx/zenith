# services/inference (self-host upgrade path)

The zero-cost default voice stack is browser-native (WebSpeech recognition +
speechSynthesis output) and needs nothing from the server. This sidecar is
the optional upgrade for self-hosters who want consistent, private,
server-side speech and a trained risk model:

- **STT:** [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (MIT) —
  90+ languages, runs on CPU; endpoint `POST /stt` with audio chunks.
- **TTS:** [Piper](https://github.com/rhasspy/piper) (MIT) — fast local
  voices incl. Indic languages; endpoint `POST /tts`.
- **Risk model:** fine-tuned MuRIL/IndicBERT classifier behind the same
  `RiskAdapter` shape as the keyword sentinel (see `packages/adapters`).

Planned shape: a small Python FastAPI app, wired through `SttAdapter` /
`TtsAdapter` / `RiskAdapter` so the API and worker never know which engine
is running. Contributions welcome — especially labelled multilingual crisis
evaluation data (see ROADMAP risk R2).
