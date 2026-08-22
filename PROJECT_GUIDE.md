
# Zenith — Project Guide

> Complete reference for architecture, commands, runtime flows, and development workflows.

---

## 1. Architecture Overview

### Monorepo Structure (npm workspaces)

`
zenith/
+-- apps/
¦   +-- api/           # Fastify HTTP + WebSocket server (port 3000)
¦   +-- web/           # User PWA — React + Vite + i18next (port 5173)
¦   +-- dashboard/     # Counsellor dashboard — React + Vite (port 5174)
¦   +-- worker/        # Background jobs — purge loop + risk queue consumer
+-- packages/
¦   +-- contracts/     # Shared Zod schemas (REST + WS DTOs) — single source of truth
¦   +-- adapters/      # Pluggable: LlmAdapter, RiskAdapter, EmbeddingAdapter, Prosody
+-- services/
¦   +-- inference/     # Python FastAPI — faster-whisper STT + edge-tts TTS (port 8090)
+-- infra/
¦   +-- docker-compose.yml      # PostgreSQL + Ollama
¦   +-- migrations/             # 6 SQL migrations (001?006)
¦   +-- scripts/db.ps1          # Windows PostgreSQL manager
¦   +-- install-windows.bat     # One-click Windows setup
+-- start-zenith.bat            # Windows launcher (all services)
+-- package.json                # Root workspace config
+-- tsconfig.base.json          # Shared TypeScript config
+-- PROJECT_GUIDE.md            # This file
`

### Workspace Responsibilities

| Workspace | Purpose | Port | Key Technologies |
|-----------|---------|------|------------------|
| @zenith/api | HTTP REST + WebSocket gateway, session management, AI Buddy pipeline, alert dispatch | 3000 | Fastify, pg-boss, WebSocket, Zod |
| @zenith/web | Anonymous user PWA — chat, voice, crisis escalation | 5173 | React 18, Vite, i18next, Web Speech API |
| @zenith/dashboard | Counsellor workbench — real-time alert queue, Jitsi handoff | 5174 | React 18, Vite, WebSocket |
| @zenith/worker | Purge loop (10-min), risk scoring queue consumer (pg-boss) | — | pg-boss, Ollama embeddings, CSI engine |
| @zenith/contracts | **All DTOs and WebSocket frames** — compile-time guarantees across processes | — | Zod schemas only |
| @zenith/adapters | Pluggable implementations: LLM (Ollama/OpenAI), Risk (KeywordSentinel), Embeddings, Prosody | — | Strategy pattern, no deps on apps |
| inference | Speech-to-text (faster-whisper) + neural TTS (edge-tts) | 8090 | Python, FastAPI, faster-whisper, edge-tts |
---

## 2. Commands Reference

### Database Commands

| Command | Why | What Happens | When |
|---------|-----|--------------|------|
| npm run db:init | **First-time setup** - PostgreSQL isn't installed by default on Windows | Downloads portable PostgreSQL 16 binaries to .postgres/, initializes data directory, creates zenith user/db | **Once** on new machine |
| npm run db:start | Start the database server | Runs pg_ctl start on .postgres/data listening on port 5432 | Every dev session |
| npm run db:stop | Clean shutdown | Runs pg_ctl stop | When done |
| npm run migrate | **Schema synchronization** - applies SQL migrations in order | Runs each migration in infra/migrations/ (001 to 006) against the database. Creates tables: sessions, session_messages, risk_assessments, counsellors, alerts, etc. | After db:start, before first run; after pulling schema changes |

**Migration Flow:**
001_init.sql       -> Core tables (sessions, messages, events, audit)
002_risk.sql       -> risk_assessments (CSI scoring history)
003_counsellors.sql-> counsellors, availability, login_tokens, alerts
004_handoff.sql    -> sessions.handoff_room column
005_csi.sql        -> prosody column, S1/S2/S3/CSI scores, risk_screening
006_temp_tokens.sql-> counsellor_temp_tokens (for any-email magic links)

### AI Model Commands

| Command | Why | What Happens |
|---------|-----|--------------|
| ollama pull llama3.2:3b | **LLM for AI Buddy** - generates empathetic responses | Downloads 3B parameter Llama 3.2 model (~2GB) to Ollama's model store |
| ollama pull nomic-embed-text | **Embeddings for CSI semantic scoring** | Downloads embedding model for PHQ-9/GAD-7 similarity matching |

**When:** Once per machine (models persist in Ollama's store)

### Development Commands

| Command | What It Starts | Ports |
|---------|----------------|-------|
| npm run dev:api | API server only | 3000 |
| npm run dev:worker | Background worker only | - |
| npm run dev:web | Web PWA (Vite dev server) | 5173 |
| npm run dev:dashboard | Dashboard (Vite dev server) | 5174 |
| npm run dev:all | **All 4 concurrently** (best for dev) | 3000, 5173, 5174 |

**What dev:all does internally:**
concurrently -n API,WORKER,WEB,DASH 
  "npm run dev:api" 
  "npm run dev:worker" 
  "npm run dev:web" 
  "npm run dev:dashboard"

### Production Build

| Command | Why | What Happens |
|---------|-----|--------------|
| npm run build | **Single-process deployment** | 1. TypeScript typechecks all workspaces 2. Vite builds web -> apps/web/dist 3. Vite builds dashboard -> apps/dashboard/dist 4. API serves both via registerStaticSites() |

**After build:**
http://localhost:3000/           -> Serves apps/web/dist (user PWA)
http://localhost:3000/counsellor/ -> Serves apps/dashboard/dist (counsellor dashboard)
http://localhost:3000/api/...    -> API endpoints

### Testing & Quality

| Command | Purpose |
|---------|---------|
| npm test | Run all unit tests (106 tests across risk, CSI, session, worker) |
| npm run typecheck | TypeScript strict check across all workspaces |
| npm run build | Also runs typecheck as part of build |

### Windows One-Click

# Run as Administrator
infra\install-windows.bat   # Installs Ollama, PostgreSQL, Python deps, npm deps, runs migrate
start-zenith.bat            # Launches everything
---

## 3. Runtime Connection Flows

### 3.1 User Session Flow (Chat)

User opens http://localhost:5173
       |
       v
1. POST /api/v1/sessions -> Creates session (UUID), returns sessionToken
       |
       v
2. WebSocket /api/v1/ws?token=... -> Authenticates, joins session room
       |
       v
3. User sends message (text or voice)
       |
       v
4. API: persistMessage() -> session_messages table
       |
       +---> Broadcasts to user's other tabs (message.received)
       |
       +---> onUserMessage hook -> AI Buddy generates reply (streamed via message.delta)
                |
                v
5. Worker (pg-boss): score_message job picked up
                |
                v
6. CsiEngine.assess(message) -> S1(keywords) + S2(embeddings) + S3(prosody) = CSI score
                |
                v
7. If tier >= ORANGE: INSERT INTO alerts + pg_notify('zenith_alert_new')
                |
                v
8. AlertDispatcher -> WebSocket broadcast to ALL counsellors (counsellor.alerted)
                |
                v
9. Dashboard receives frame -> Renders alert card with tier, countdown, last 3 turns

### 3.2 Voice Flow (STT/TTS)

User clicks mic or ~ (hands-free)
       |
       v
Browser: MediaRecorder -> webm/opus OR Web Speech API
       |
       v
POST /api/v1/stt -> Forwards to Python sidecar (localhost:8090)
       |
       v
Python: faster-whisper -> {"text": "...", "language": "hi", "duration": 3.2}
       |
       v
API: Receives text + prosody features -> Treats as normal message
       |
       v
... (same as chat flow above)
       |
       v
AI Buddy reply -> POST /api/v1/tts -> Python edge-tts -> neural voice audio/mpeg
       |
       v
Browser plays audio

**Prosody Features (extracted client-side, raw audio never leaves browser):**

const prosody = {
  f0Mean: ...,      // pitch
  f0Std: ...,       // pitch variation
  speechRate: ...,  // syllables/sec
  pauseRatio: ...,  // silence vs speech
  rmsEnergy: ...    // volume
};

These feed into **S3 (prosody signal)** in apps/worker/src/csi.ts.

### 3.3 Counsellor Dashboard Flow

Counsellor opens http://localhost:5174
       |
       v
WebSocket /api/v1/counsellor/ws -> Connects (no auth)
       |
       v
fetchQueue() -> GET /api/v1/counsellor/queue -> Returns active alerts
       |
       v
Receives real-time: counsellor.alerted / counsellor.accepted / alert.expired
       |
       v
Clicks Accept & Connect -> POST /api/v1/counsellor/sessions/:id/accept
       |
       v
API: acceptAlert() -> Atomic UPDATE alerts SET status='accepted', counsellor_id=...
       |
       v
Creates Jitsi room -> offerHandoffToUser() -> Sends buddy-framed message to user
       |
       v
User receives handoff.offer -> iframe opens Jitsi video call

---

## 4. Build vs Dev: Key Differences

| Aspect | dev:all (Development) | build + dev:api (Production-like) |
|--------|------------------------|----------------------------------------|
| Web PWA | Vite dev server (port 5173), HMR, React Fast Refresh | Static files from apps/web/dist served by API |
| Dashboard | Vite dev server (port 5174), HMR | Static files from apps/dashboard/dist served by API |
| API | tsx watch (auto-reload on TypeScript changes) | Same, but serves static assets |
| Worker | tsx watch | Same |
| Hot Reload | Yes (React + TypeScript) | No (Only API/Worker reload) |
| Use Case | Daily development | Testing production build, demos |

### Dashboard Asset Path Fix (Critical)

The dashboard must be built with base: "/counsellor/" in vite.config.ts:

`	ypescript
// apps/dashboard/vite.config.ts
export default defineConfig({
  plugins: [tailwindcss(), react()],
  base: "/counsellor/",  // REQUIRED for assets to load at /counsellor/assets/*
  server: { ... }
});
`

Without this, the dashboard HTML loads but JS/CSS 404 at /assets/* instead of /counsellor/assets/*.

---

## 5. Design Decisions

| Decision | Reason |
|----------|--------|
| Monorepo (npm workspaces) | Shared types (@zenith/contracts), atomic commits, single npm install |
| Shared contracts (Zod) | API <-> Web <-> Dashboard <-> Worker can never drift - compile-time guarantees |
| Pluggable adapters | Swap LLM (Ollama <-> OpenAI-compat), risk engine, embeddings without changing business logic |
| pg-boss queue | Reliable job processing using PostgreSQL as queue (no Redis needed) |
| WebSocket first-frame auth | Browsers can't set headers on WS upgrade -> token in first frame |
| 10-min auto-purge | Privacy guarantee - cascade deletes remove all session data |
| Prosody only (no audio) | Raw audio never leaves browser - only 5 numeric features transmitted |
| Magic link + TOTP | No passwords, no SMTP needed in dev (token in logs), MFA for production |
| Demo counsellor auto-seed | Evaluators can test dashboard immediately without manual setup |
| Crisis tiers never downgrade | Green -> Yellow -> Orange -> Red (monotonic escalation) |
| Whitelist serializer for alerts | Only session UUID, tier, timestamps, last 3 turns cross to counsellor plane - zero PII |

---

## 6. Quick Reference Card

### First-Time Setup
npm run db:init          # Download PostgreSQL
npm run db:start         # Start PostgreSQL
npm run migrate          # Create tables
ollama pull llama3.2:3b  # AI model
ollama pull nomic-embed-text  # Embeddings

### Daily Development
npm run dev:all          # Start everything (4 terminals in one)

### Testing
npm test                 # All unit tests (106 tests)
npm run typecheck        # TypeScript strict check

### Production Build
npm run build            # Build web + dashboard
npm run dev:api          # Single process serves all

### Windows One-Click
infra\install-windows.bat  # Run as Admin (full setup)
start-zenith.bat           # Launch everything

---

## 7. Common Issues & Fixes

| Problem | Cause | Fix |
|---------|-------|-----|
| EADDRINUSE: 3000 | Old API process still running | taskkill /PID <pid> /F then restart |
| Dashboard blank/white | Assets at wrong path (/assets vs /counsellor/assets) | Ensure base: "/counsellor/" in vite.config.ts |
| Database unavailable in tests | PostgreSQL not running | npm run db:start |
| Ollama connection refused | Ollama not running | ollama serve in separate terminal |
| WebSocket auth timeout | Token expired or wrong | Check SESSION_TOKEN_SECRET matches in .env |
| loginWithTotp not found (dashboard build) | Old import after auth removal | Rebuild dashboard: npm run build -w @zenith/dashboard |
| API serves old web build | Cached dist folder | Rebuild web: npm run build -w @zenith/web |
| No active alerts but crisis typed | Worker not running or Ollama down | Check npm run dev:worker running, ollama serve running |

---

## 8. Key Files to Know

### Configuration
- apps/api/src/config.ts - All env vars with Zod validation
- apps/api/src/staticSites.ts - Serves web + dashboard in production
- apps/dashboard/vite.config.ts - base: "/counsellor/" critical

### Core Logic
- apps/api/src/services/buddy.ts - AI Buddy pipeline (streaming, fallback)
- apps/worker/src/csi.ts - Crisis Signal Integration engine (S1+S2+S3 fusion)
- apps/worker/src/risk.ts - Queue consumer, alert raising, red fallback
- apps/api/src/services/alerts.ts - Alert lifecycle, whitelist serializer
- apps/api/src/realtime/gateway.ts - User WebSocket gateway
- apps/api/src/realtime/counsellorGateway.ts - Counsellor WebSocket plane
- apps/api/src/realtime/alertDispatcher.ts - pg_notify -> WS broadcast

### Database
- infra/migrations/001_init.sql through 006_temp_tokens.sql
- apps/api/src/db/pool.ts - pg.Pool singleton
- apps/api/src/db/migrate.ts - Migration runner

### Contracts (Shared Types)
- packages/contracts/src/index.ts - **All DTOs, WS frames, enums**

---

## 9. Environment Variables (.env)

# Required
SESSION_TOKEN_SECRET=your-64-char-random-string  # Generate: openssl rand -base64 48

# Database (matches docker-compose.yml defaults)
DATABASE_URL=postgres://zenith:zenith@localhost:5432/zenith

# Ollama (local LLM)
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2:3b

# Optional: OpenAI-compatible API (Groq, vLLM, etc.)
# LLM_PROVIDER=openai-compat
# LLM_API_BASE_URL=https://api.groq.com/openai/v1
# LLM_API_KEY=sk-...
# LLM_API_MODEL=llama-3.1-8b-instant

# Jitsi (for video handoff)
JITSI_BASE_URL=https://meet.jit.si

# STT/TTS sidecar
STT_URL=http://127.0.0.1:8090

# Production HTTPS
COOKIE_SECURE=false  # Set "true" behind HTTPS

Generate secure secret:
# PowerShell
[Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Maximum 256 }))

# Or Node
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"

---

## 10. Testing Crisis Detection

1. Start all services: npm run dev:all
2. Open user PWA: http://localhost:5173 -> "Begin Conversation"
3. Type crisis phrases:
   - "I want to kill myself" -> RED alert (immediate)
   - "I can't go on anymore" -> ORANGE/RED
   - "I'm feeling hopeless" -> YELLOW/ORANGE
4. Open dashboard: http://localhost:5174 -> Alert appears with:
   - Tier badge (RED/ORANGE)
   - Countdown timer (10 min TTL)
   - Last 3 conversation turns (whitelist only)
   - "Accept & Connect" / "Decline" buttons
5. Click "Accept & Connect" -> Jitsi room opens in new tab

---

## 11. Privacy & Security Guarantees

| Guarantee | Implementation |
|-----------|----------------|
| Zero data retention | All conversation auto-purged <=10 min (cascading deletes) |
| No tracking | No fingerprinting, no IP logging, no analytics |
| Encrypted tokens | HMAC-SHA256, httpOnly, SameSite=Strict cookies |
| No PII to counsellor | Only UUID, risk tier, last 3 turns (whitelist serializer) |
| Raw audio never leaves browser | Prosody features only (f0, speech rate, pause ratio, RMS) |
| No diagnosis | Connects to care, never pretends to be therapy |

---

## 12. License

**AGPL-3.0** - See LICENSE file.

> Keeps hosted forks open; ensures source availability for network services.

---

*Last updated: 2026-08-20*
