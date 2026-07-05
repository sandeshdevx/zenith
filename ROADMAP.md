# Zenith V1 — Implementation Roadmap

**Source:** Zenith PRD v1.0 + TRD v1 (Stability-First Implementation Plan)
**Constraints honored:** free for every user · multilingual · open-source models only · the platform itself ships as open source
**Architecture:** modular monolith — one API server, one worker process, one PostgreSQL database, adapters around every external model/provider.

---

## 0. Ground rules for controlled execution

1. Every phase ends with a **demoable, testable slice** — nothing merges without its exit criteria passing.
2. Every external model or service sits behind an **adapter interface** (TRD §9). Swapping Mistral→Qwen or Coqui→Piper must never touch business logic.
3. **Text mode is the trunk; voice, video, and PSTN are branches.** The platform must be fully useful with text only, so every later phase degrades gracefully back to Phase 3 behavior.
4. Feature flags for: voice input, TTS output, PSTN bridge, PHQ-9 module. Risky integrations ship dark and are enabled per-environment.
5. Postgres is the single source of truth for session state. The API stays stateless (TRD §10). Redis is **deferred until measured need** — use `pg-boss` (Postgres-backed queue) for the worker so V1 has one datastore.
6. **Zero-cost rule:** every dependency in the default configuration must be free to run — free/open-source software only, no paid API keys, no metered SaaS. Anything that costs money to operate (e.g., a SIP trunk) ships feature-flagged off and documented as an optional self-hoster add-on.
7. **i18n from day one:** all user-facing strings in both frontends go through `i18next` (never hardcoded), with browser-language auto-detection (`i18next-browser-languagedetector`). The AI conversation layer receives a language hint (browser locale + Whisper language ID) so replies and TTS come back in the user's language. Translation files live in `locales/` per app so community contributors can add languages via PR.

---

## 1. Open-source / free-stack decisions (locked before Phase 0)

| Concern | Choice | License | Multilingual note |
|---|---|---|---|
| LLM (AI Buddy) | Mistral 7B via **Ollama** (per PRD) | Apache-2.0 | Weak on Indic languages — keep `LlmAdapter` so Qwen 2.5 7B / Gemma 2 9B (better Hindi/Hinglish) are drop-in swaps |
| STT | Browser **WebSpeech API** first, **faster-whisper** (small/medium) fallback service | MIT | Whisper covers 90+ languages incl. Hindi, Tamil, Telugu, Bengali |
| TTS | **Coqui XTTS v2** (per PRD) with **Piper** as fallback adapter | MPL-2.0 / MIT | XTTS: 17 languages; Piper has Indic voices; Coqui-the-company is defunct — plan for the community fork (`idiap/coqui-ai-TTS`) |
| Risk classifier | Keyword Sentinel (rule layer) + fine-tuned **MuRIL / IndicBERT** (not vanilla English BERT) | Apache-2.0 | Vanilla BERT will miss Hinglish crisis language — this is a launch-blocking model choice |
| Video handoff | **Jitsi** (self-hosted `docker-jitsi-meet`, or meet.jit.si to start) | Apache-2.0 | — |
| PSTN bridge | **FreeSWITCH + JsSIP** (per PRD) | MPL / MIT | SIP trunk termination is the one thing that is *not* free to operate — see Risk R1 |
| Backend | Node 20 + TypeScript + **Fastify**, `ws` for WebSockets | MIT | — |
| Frontend | React + TypeScript + **Vite** PWA; separate counsellor dashboard app | MIT | **i18next** + `react-i18next` + browser language detector; all strings in `locales/{lang}.json`, community-translatable (PRD P1) |
| DB / queue | PostgreSQL 16 + **pg-boss** | PostgreSQL/MIT | — |
| Repo license | **AGPL-3.0** recommended (keeps hosted forks open); MIT if maximum adoption matters more | — | Decide before first public commit |

Repo shape (npm workspaces monorepo — npm ships with Node, one less tool to install):

```
zenith/
  apps/web/            # anonymous user PWA
  apps/dashboard/      # counsellor dashboard
  apps/api/            # Fastify API + WebSocket gateway
  apps/worker/         # pg-boss consumers: risk scoring, purge, retries
  services/inference/  # Python FastAPI sidecar: faster-whisper, XTTS, risk model
  packages/contracts/  # shared zod schemas: REST DTOs + WS event types
  packages/adapters/   # LlmAdapter, SttAdapter, TtsAdapter, RiskAdapter, VideoAdapter, TelephonyAdapter
  infra/               # docker-compose (postgres, ollama, inference, jitsi, freeswitch), migrations
```

---

## 2. Backend wiring order (phases = dependency order)

Each phase depends only on the phases above it. Do not reorder.

### Phase 0 — Foundation (no product code)
- Monorepo scaffold, CI (lint, typecheck, test), `docker-compose up` brings Postgres + Ollama.
- `GET /api/v1/health`, `GET /api/v1/ready` (checks DB + Ollama) — TRD requires these "from day one".
- Config module: all env-driven, zero secrets in repo (open-source hygiene).
- Error envelope + request validation middleware (zod from `packages/contracts`).
- **Exit:** CI green, health/ready return real dependency status.

### Phase 1 — Anonymous session core
- Migrations: `sessions`, `session_messages`, `session_events`, `system_audit_logs` (TRD §6 schema + indexes).
- `POST /api/v1/sessions` → UUID + signed anonymous token (httpOnly, SameSite cookie; no fingerprinting, no IP stored on the row).
- `GET /sessions/{id}`, `POST /sessions/{id}/end`.
- Session state machine (see §3) enforced in one module — the only place status transitions happen.
- **Purge job** in worker: delete messages + session rows after 10 min inactivity or explicit end. Build purge *now*, not at the end — it is a P0 trust guarantee and every later feature must survive it.
- Soft rate limit: 3 active sessions / IP / hour, in-memory or Postgres counter (no hard block per PRD edge case).
- **Exit:** integration test proves a session's data is gone ≤10 min after inactivity; token auth on every session route.

### Phase 2 — Realtime channel
- WebSocket gateway on the API (token-authenticated upgrade), event types from `packages/contracts`: `session.created`, `message.received`, `message.sent`, `risk.updated`, `counsellor.alerted`, `counsellor.accepted`, `session.ended`.
- `POST /sessions/{id}/messages` persists then emits; WS is transport, REST is source of truth (reconnect = re-fetch recent context).
- Client reconnect with backoff + resume-by-session-token.
- **Exit:** kill the socket mid-conversation, client recovers with no message loss.

### Phase 3 — AI Buddy, text only (first real product value)
- `LlmAdapter` → Ollama/Mistral. System prompt: empathetic, never diagnoses, never confirms/denies being AI (deflection script from PRD edge case).
- Response streaming over WS (perceived latency matters more than total latency).
- 30-second Ollama health check; on failure surface "connect directly with a human" + helpline options (PRD edge case) — degradation path exists *before* voice or counsellors do.
- `GET /api/v1/support-options` returns static helpline registry (iCall, Vandrevala, AASRA, 7 Cups) — data-driven JSON so the OSS community can add regional helplines.
- **Exit:** full anonymous text conversation, graceful "AI is resting" fallback verified by killing Ollama during a chat.

### Phase 4 — Risk pipeline (parallel, invisible)
- On each user message the API enqueues a `score_message` job — **fire-and-forget, never blocks the reply path** (PRD Flow A step 3: pipelines are parallel).
- Layer 1: Keyword Sentinel — synchronous, in-process, multilingual keyword/regex list (fast floor for recall).
- Layer 2: `RiskAdapter` → inference sidecar running the fine-tuned multilingual classifier. Output: GREEN / YELLOW / ORANGE / RED into `risk_assessments`.
- **2-of-last-3-turns confirmation** before any ORANGE/RED alert becomes eligible (PRD false-positive control).
- Abusive-content flag computed here too (pre-counsellor filter, PRD edge case).
- Emit `risk.updated` internally only — the user-facing socket **never** carries risk events.
- **Exit:** replay a labelled test transcript; tier transitions and confirmation window behave exactly per PRD; user socket traffic captured and shown to contain zero risk signals.

### Phase 5 — Counsellor side
- `counsellors`, `counsellor_availability` tables; magic-link auth + TOTP MFA; RBAC (counsellor / supervisor / admin) — completely separate auth world from anonymous tokens.
- `POST /counsellor/availability`, `GET /counsellor/queue`, `accept` / `decline` endpoints.
- Alert dispatch: confirmed ORANGE/RED → `counsellor.alerted` to all online counsellors with `{session_uuid, risk_tier, last_3_turns}` — **no PII, ever** (enforced by a serializer that whitelists fields, not blacklists).
- Alert lifecycle: active 10 min, auto-close on user disappearance; accept is atomic (`UPDATE ... WHERE assigned IS NULL RETURNING` — two counsellors cannot claim one session).
- **Exit:** two dashboards racing to accept one alert → exactly one wins; alert auto-expiry verified.

### Phase 6 — Escalation & Jitsi handoff
- Counsellor accepts → server generates UUID Jitsi room → link to counsellor → *AI Buddy* delivers the natural in-conversation offer ("there's a person available if you want") — never a system banner (PRD Flow B).
- User accepts → room opens in-tab; declines → conversation continues, alert stays live 10 min.
- RED + no counsellor accept in 90 s → AI Buddy surfaces iCall + 7 Cups inline; 5-min unresponsive RED → single "Are you still there?" prompt.
- User-initiated path: `POST /sessions/{id}/escalate` + always-visible "Talk to a real person" button (the manual escape hatch that covers BERT false negatives).
- **Exit:** scripted end-to-end drill: simulated RED → alert → accept → Jitsi join → session end → purge. Also the no-counsellor timeout path.

### Phase 7 — Voice (input + output)
- Input: WebSpeech API where available; else stream audio chunks to `/inference/stt` (faster-whisper). Mic denied → **silent** fallback to text, no error UI (PRD).
- Output: `TtsAdapter` → XTTS (Piper fallback); sentence-level chunked synthesis so first audio lands inside the 3–5 s budget.
- Language: detect from browser + Whisper's language ID; pass language hint to LLM and TTS so replies come back in the user's language.
- **Exit:** voice round-trip ≤5 s p95 on target hardware; mic-denied path shows zero errors; Hindi and English round-trips both pass.

### Phase 8 — WebRTC→PSTN bridge (highest risk, shipped last, feature-flagged)
- FreeSWITCH container, WSS + JsSIP from browser, SIP trunk to iCall's number; caller ID = platform VoIP number, user number never exists in the system.
- 30 s no-answer timeout → auto-surface Vandrevala + 7 Cups (PRD edge case). No recording, no CDR content, teardown logged as an event only.
- Keep flag **off** in the open-source default config — self-hosters enable it only with their own trunk (see Risk R1).
- **Exit:** browser-to-phone test call connects <30 s; busy/no-answer path verified; grep of FreeSWITCH config confirms recording disabled.

### Phase 9 — Hardening & launch
- i18next UI translations for launch languages; accessibility pass (keyboard, screen reader, low bandwidth); PWA manifest + minimal service worker.
- PHQ-9/GAD-7 conversational module (P1 — cut first if schedule slips).
- Load test: p95 <200 ms at 50 concurrent (JMeter/k6); WS disconnect chaos test; purge-compliance audit query (target: 100%).
- Observability: error rates, queue latency, WS disconnects, purge success (the four TRD-mandated signals) via Prometheus + Grafana (both OSS).
- OSS release checklist: LICENSE, SECURITY.md, threat model doc, `docker-compose up` one-command self-host, no secrets in history, contribution guide, helpline registry documented for regional contributors.

---

## 3. State management plan

### Server — session state machine (single module, only writer of `sessions.status`)

```
CREATED → ACTIVE → (ESCALATION_PENDING → HANDOFF_ACTIVE) → ENDED → PURGED
                ↘ ENDED (user exit / 10-min inactivity) → PURGED
```

- Transitions validated centrally; illegal transitions throw and land in `session_events`.
- `risk_tier` is an attribute updated by the worker, **not** a state — a RED session is still ACTIVE.
- API instances hold no session state in memory (stateless, load-balancer ready). WS connections map to sessions via the token; on instance death the client reconnects anywhere.
- Worker owns: risk scoring, purge, alert expiry, handoff reconciliation (abandoned escalations swept back).

### Frontend — anonymous PWA
- Deliberately minimal: Zustand (or React context) holding `{sessionToken(cookie-managed), connectionState, messages[], mode: text|voice, escalationOffer?}`.
- **No localStorage/IndexedDB for conversation content** — memory only; tab close = gone (anonymity property, TRD §4).
- WS connection as an explicit client state machine: `connecting → open → degraded(REST polling) → reconnecting`, with honest offline messaging.
- Escalation offer arrives as a normal AI-buddy chat message with an attached action — the store has no "crisis" concept, so no UI can accidentally leak detection.

### Counsellor dashboard
- TanStack Query for REST (queue, availability) + WS events as cache invalidators/patches; REST re-fetch on reconnect is the reconciliation path.
- Availability heartbeat every 30 s → `counsellor_availability.last_seen_at`; server treats stale heartbeat as offline (crashed dashboards can't strand alerts).

---

## 4. Data flow mapping

**Flow 1 — message round trip (Flow A):**
`user (voice) → [WebSpeech | Whisper sidecar] → text → POST /messages → persist (session_messages) →`
- **path A (reply):** LlmAdapter/Ollama → stream over WS → TtsAdapter → audio to user
- **path B (risk, parallel, non-blocking):** pg-boss job → Sentinel + classifier → `risk_assessments` → tier update
Neither path waits for the other (PRD requirement).

**Flow 2 — silent escalation (Flow B):**
`risk_assessments (2-of-3 ORANGE/RED) → alert row + counsellor.alerted WS fan-out (uuid, tier, last 3 turns only) → counsellor accept (atomic claim) → Jitsi room UUID → counsellor gets link; user gets AI-framed offer → accept: HANDOFF_ACTIVE | decline: alert stays 10 min → RED 90 s unclaimed: inline helplines`

**Flow 3 — user-initiated bridge (Flow C):**
`"Talk to a real person" → GET /support-options → {volunteer/Jitsi | iCall/PSTN | 7 Cups tab} → PSTN: JsSIP over WSS → FreeSWITCH → SIP trunk → iCall; 30 s timeout → fallback numbers. No recording, no user number anywhere.`

**Flow 4 — purge (trust guarantee):**
`worker cron (1 min) → sessions where last_active_at > 10 min OR status=ENDED → delete session_messages, risk_assessments detail, session row → write count-only purge event → dashboard metric: purge compliance = 100%`

**PII boundary rule:** data crossing to the counsellor plane passes one whitelist serializer (`session_uuid`, `risk_tier`, `last_3_turns`). Nothing else can cross, by construction. IPs live only in the rate limiter's short-lived counters, never on session rows.

---

## 5. Risk areas (ranked)

| # | Risk | Why it matters | Mitigation |
|---|---|---|---|
| R1 | **PSTN bridge cost & legality.** SIP-trunk termination is never free, and in India VoIP→PSTN termination is regulated (unlicensed bridging to Indian numbers can be unlawful) | "Free for everyone" and the flagship Flow C collide with telecom reality | Ship Phase 8 feature-flagged **off** by default; launch with Jitsi + inline helpline numbers (`tel:` links on mobile give 90% of the value at zero cost/risk); obtain a compliant trunk before enabling publicly |
| R2 | **Multilingual crisis detection quality.** Vanilla BERT + English keywords will miss Hinglish/Indic crisis language; labelled Indic crisis datasets barely exist | False negatives = the worst product failure; PRD targets ≥85% precision / ≥80% recall | Use MuRIL/IndicBERT, build a labelled eval set *before* Phase 4, keep Keyword Sentinel multilingual as recall floor, and lean on the always-visible manual escalation button as the designed backstop |
| R3 | **Inference latency vs. zero budget.** Mistral 7B + Whisper + XTTS on CPU will blow the 3–5 s voice budget; GPUs aren't free | Core UX promise ("feels human within 3–5 s") | Quantized models (Q4 GGUF), token streaming + sentence-chunked TTS, WebSpeech (client-side, free) as primary STT; publish minimum self-host specs; text mode always instant |
| R4 | **"Never identifies as AI."** Ethical exposure and conflicts with emerging AI-disclosure norms (e.g., EU AI Act transparency) for a mental-health context | Reputational/legal risk for an OSS project seeking trust | Keep the in-conversation warm deflection, but disclose AI involvement plainly on the landing page/about — honesty at the product level, gentleness at the conversation level. Flag for an explicit product decision |
| R5 | **Purge vs. everything else.** Backups, logs, and queue payloads can silently violate "nothing stored" | The anonymity guarantee is the product | Purge job from Phase 1; message content never in log lines or job payloads (jobs carry IDs, read DB); short backup retention documented; purge-compliance metric on the dashboard |
| R6 | **Counsellor cold start.** V1 has no volunteer signup portal (Future) — the pool may be empty at 2 AM | ORANGE/RED fallback rate target <20% | Treat helpline-inline fallback as first-class, seed counsellors manually pre-launch; instrument fallback rate from day one |
| R7 | **Coqui abandonment.** Coqui shut down; XTTS license (CPML) is non-commercial | TTS could rot; license friction for an OSS repo | `TtsAdapter` + Piper (MIT) as the packaged default for self-hosters; XTTS optional |
| R8 | **Atomic alert claiming & WS fan-out bugs** | Two counsellors joining one crisis, or none | Single-row atomic claim SQL; race-condition test in CI (Phase 5 exit criterion) |
| R9 | **Anonymous abuse** (rate-limit evasion, prompt abuse, offensive content to volunteers) | Volunteer burnout, load | Soft IP limits, abusive-content flag before alert dispatch, counsellor decline-without-penalty (all per PRD) |

---

## 6. Dependency order (build graph)

```
Phase 0  Foundation ──► Phase 1 Session core ──► Phase 2 Realtime WS
                                                        │
                                          ┌─────────────┼──────────────┐
                                          ▼             ▼              │
                                   Phase 3 AI text   Phase 4 Risk ─────┤   (3 ∥ 4 — independent)
                                          │             │              │
                                          │             ▼              │
                                          │      Phase 5 Counsellor ◄──┘
                                          │             │
                                          └──────► Phase 6 Escalation + Jitsi
                                                        │
                                    Phase 7 Voice ◄─────┤   (7 needs 3 only — can run ∥ 5/6)
                                                        ▼
                                              Phase 8 PSTN (flagged)
                                                        ▼
                                              Phase 9 Hardening + OSS launch
```

Parallelization for a solo dev with controlled execution: strictly serial 0→1→2→3, then interleave 4/7 behind flags while 5/6 land, PSTN last, always able to ship the trunk (text-only product) at any point after Phase 3.

**Long-lead items to start early regardless of phase:** labelled multilingual crisis eval dataset (R2), SIP trunk / legal review (R1), volunteer counsellor recruitment (R6).
