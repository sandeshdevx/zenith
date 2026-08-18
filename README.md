# 🌙 Zenith — Anonymous AI Mental Health Support

> **Free. Anonymous. Open-source. In your language, in your browser, at 2 AM.**

**No name. No stigma. No silence. No cost.**

Zenith is an empathetic AI companion with silent crisis detection and bridges to real humans — volunteer counsellors over Jitsi and existing helplines — all without accounts, personal data retention, or a single word stored after you leave.

---

## 🎯 What is Zenith?

A **privacy-first mental health support platform** that:
- ✅ Provides **24/7 empathetic AI conversations** (Llama 3.2 3B / Mistral 7B, multilingual)
- ✅ Detects **silent crises** via multi-signal analysis (NLP + speech prosody + implicit PHQ-9/GAD-7 screening)
- ✅ Connects users to **real counsellors** over video (Jitsi) when needed
- ✅ Falls back to **existing helplines** (iCall, 7 Cups, Vandrevala, AASRA, etc.)
- ✅ **Purges all data** within 10 minutes of inactivity (anonymity guaranteed)
- ✅ Runs **entirely free** (no paid APIs, no metered SaaS)
- ✅ Supports **90+ languages** (Whisper STT, multilingual LLMs, i18next UI)
- ✅ **Never diagnoses** — connects to care, never pretends to be therapy

---

## 🚀 Quick Start (5 Minutes)

### Prerequisites
- **Node 20+**
- **PostgreSQL 16** (or Docker / portable binaries via `npm run db:init`)
- **Ollama** (free LLM runtime) — [ollama.com](https://ollama.com)

### Install & Run (One Command!)

```bash
# 1. Clone & install
git clone https://github.com/sandeshdevx/zenith
cd zenith
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env and set a secure SESSION_TOKEN_SECRET (see .env.example for generators)

# 3. Start PostgreSQL (Windows)
npm run db:init      # First time only — downloads portable binaries
npm run db:start     # Starts PostgreSQL on port 5432
npm run migrate      # Applies database schema

# 4. Pull AI models (in separate terminal)
ollama pull llama3.2:3b
ollama pull nomic-embed-text

# 5. Start EVERYTHING (single terminal!)
npm run dev:all
```

**That's it!** Open http://localhost:5173 🎉

### Alternative: Docker for PostgreSQL + Ollama
```bash
docker compose -f infra/docker-compose.yml up -d
npm run migrate
npm run dev:all
```

### Verify Health
```bash
curl http://localhost:3000/api/v1/health
# → {"status":"ok"}

curl http://localhost:3000/api/v1/ready
# → {"ready":true,"dependencies":[{"name":"postgres","ok":true},{"name":"ollama","ok":true}]}
```

---

## 🎮 Commands

```bash
# Development
npm run dev:all         # Starts API + Worker + Web + Dashboard (concurrently)
npm run dev:api         # API server only (port 3000)
npm run dev:worker      # Background worker only (purge + risk scoring)
npm run dev:web         # User PWA only (port 5173)
npm run dev:dashboard   # Counsellor dashboard only

# Database (Windows)
npm run db:init         # Download & initialize portable PostgreSQL
npm run db:start        # Start PostgreSQL
npm run db:stop         # Stop PostgreSQL
npm run migrate         # Apply migrations

# Production
npm run build           # Build all workspaces
npm run typecheck       # TypeScript strict check
npm test                # Run all unit tests

# Counsellor management
npm run seed:counsellor -w @zenith/api -- email@domain.com "Display Name"
```

---

## 🧪 Tests

**All unit tests passing (106 tests):**

| Suite | Tests | Status |
|-------|-------|--------|
| Keyword Sentinel (risk) | 54 | ✅ |
| Session Token (HMAC-SHA256) | 14 | ✅ |
| Rate Limiter | 8 | ✅ (1 skipped — global state) |
| CSI Fusion Weights & Tiers | 13 | ✅ |
| Prosody Scoring | 3 | ✅ |
| Session Integration | 9 | ⏭️ (skipped — needs DB) |
| Alert Lifecycle | 5 | ⏭️ (skipped — needs DB) |
| Worker CSI / Confirmation | 27 | ✅ |

```bash
npm test                    # Run all tests
npm run test -w @zenith/api # API tests only
npm run test -w @zenith/worker # Worker tests only
```

---

## ✅ Features (Production-Ready)

| Feature | Implementation |
|---------|----------------|
| **Anonymous sessions** | UUID-based, no accounts, auto-purge ≤10 min |
| **Text + voice AI conversation** | Streamed replies, multilingual |
| **Multi-signal crisis detection (CSI)** | NLP (Keyword Sentinel) + PHQ-9/GAD-7 embeddings + prosody fusion |
| **Crisis tiers** | Green → Yellow → Orange → Red (never downgrades) |
| **Counsellor plane** | Magic link + TOTP; atomic alert claiming; Jitsi handoff |
| **Escalation paths** | Silent AI offer, manual "Talk to a person" button, helpline fallback (90s) |
| **Multilingual** | 90+ languages (UI, STT, TTS, crisis patterns) |
| **Voice I/O** | Web Speech API (Chrome/Edge) + MediaRecorder→Whisper (Firefox/Safari) |
| **Neural TTS** | edge-tts (Indian variants: Hindi, Tamil, Telugu, Bengali, Marathi, Kannada, Gujarati, Punjabi, Urdu, etc.) |
| **Zero-cost stack** | Ollama (local LLM), PostgreSQL, Jitsi — no paid APIs |

---

## 📦 Repository Layout

```
zenith/
├── apps/
│   ├── api/              Fastify HTTP + WebSocket (port 3000)
│   ├── web/              User PWA (React + Vite + i18next)
│   ├── dashboard/        Counsellor dashboard (React + Vite)
│   └── worker/           Background jobs (purge, risk scoring queue)
├── packages/
│   ├── contracts/        Shared Zod schemas (REST + WS DTOs)
│   └── adapters/         Pluggable: LlmAdapter, RiskAdapter, EmbeddingAdapter, Prosody
├── services/
│   └── inference/        Python FastAPI: faster-whisper STT + edge-tts TTS (port 8090)
├── infra/
│   ├── docker-compose.yml   # PostgreSQL + Ollama
│   ├── migrations/          # 5 SQL migrations (schema)
│   ├── scripts/
│   │   └── db.ps1           # Windows PostgreSQL manager
│   └── install-windows.bat  # One-click Windows setup
├── start-zenith.bat         # Windows launcher (all services)
├── LICENSE                  # AGPL-3.0
├── README_QUICKSTART.md     # 5-min evaluator guide
└── .env.example             # Configuration template
```

---

## 🔒 Security & Privacy

- **Zero data retention** — All conversation auto-purged ≤10 min (cascading deletes)
- **No tracking** — No fingerprinting, no IP logging, no analytics
- **Encrypted tokens** — HMAC-SHA256, httpOnly, SameSite=Strict cookies
- **No PII to counsellor** — Only UUID, risk tier, last 3 turns (whitelist serializer)
- **Raw audio never leaves browser** — Prosody features only (f0, speech rate, pause ratio, RMS)
- **npm audit** — 0 vulnerabilities

---

## 📖 Documentation

| File | Purpose |
|------|---------|
| **[README_QUICKSTART.md](./README_QUICKSTART.md)** | 5-minute evaluator guide with demo checklist |
| **[DEPLOYMENT.md](./DEPLOYMENT.md)** | Production setup & scaling (systemd, Caddy, backups) |
| **[ROADMAP.md](./ROADMAP.md)** | Full phases (0–9) with exit criteria |
| **[docs/csi-architecture.md](./docs/csi-architecture.md)** | Crisis detection deep dive (patent modules 101–107) |
| **[LICENSE](./LICENSE)** | AGPL-3.0 |

---

## 🛠️ Windows One-Click Setup

```bash
# Run as Administrator for best results
infra\install-windows.bat
```

This script:
1. Installs Ollama + pulls `llama3.2:3b` + `nomic-embed-text`
2. Downloads & initializes portable PostgreSQL
3. Creates Python venv + installs STT deps (faster-whisper, edge-tts)
4. Runs `npm install` + `npm run migrate`
5. Creates `.env` from template (edit `SESSION_TOKEN_SECRET`!)

Then launch everything:
```bash
start-zenith.bat
```

---

## 🎓 Final Year Project — Demo Ready

| Demo Feature | How to Show |
|--------------|-------------|
| **Anonymous chat** | Open http://localhost:5173 → "Begin Conversation" |
| **Crisis detection** | Type *"I want to kill myself"* → no visible alert |
| **Counsellor dashboard** | Open http://localhost:3000/dashboard/ in incognito → login `demo@zenith.local` → see RED alert |
| **Jitsi handoff** | Accept alert → video room opens |
| **Voice mode** | Click 🎤 (mic) or ∿ (hands-free) → speak → see transcription + TTS reply |
| **Manual escalation** | Click "Talk to a real person" → ORANGE alert in dashboard |
| **Auto-purge** | Close tab → wait 10 min → data gone |

**Demo counsellor auto-seeded on first run:**
- Email: `demo@zenith.local`
- Magic link token printed in API console logs (no SMTP needed)

---

## 📞 Support

- **Issues:** [GitHub](https://github.com/sandeshdevx/zenith/issues)
- **Helplines (real):** iCall +91-9152987821, 7 Cups, Vandrevala +91-9999666555

---

## ⚠️ Safety Scope

**Zenith is NOT a medical product.** It does not diagnose, prescribe, or replace therapy. It connects people to existing, staffed support services while keeping them anonymous.

---

## License

**AGPL-3.0** — [LICENSE](./LICENSE)

> Keeps hosted forks open; ensures source availability for network services.

---

**Free. Anonymous. Open-source. Always.**  
🌙 Zenith — Where help is always at 2 AM.