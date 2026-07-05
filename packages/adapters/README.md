# @zenith/adapters (placeholder)

Provider adapters — first implementations arrive in Phase 3 (LlmAdapter → Ollama).

Rule (TRD §9): all vendor/model-specific code lives here behind interfaces (`LlmAdapter`, `SttAdapter`, `TtsAdapter`, `RiskAdapter`, `VideoAdapter`, `TelephonyAdapter`). Business logic never imports a vendor SDK directly, so any model can be swapped without touching product code.
