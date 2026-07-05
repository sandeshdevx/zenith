# Zenith

**Free, anonymous, open-source AI mental health support — in your language, in your browser, at 2 AM.**

> No name. No stigma. No silence. No cost.

Zenith is an anonymous support platform: an empathetic AI companion (open-source models only), silent crisis detection, and a bridge to real humans — volunteer counsellors over Jitsi and existing helplines — without the user ever creating an account, sharing a phone number, or having a single word stored after the session ends.

## Principles

- **Free for everyone.** No paid APIs, no metered SaaS, no premium tier. The default configuration runs entirely on free and open-source software.
- **Open-source models only.** Mistral/Qwen via Ollama for conversation, Whisper for speech-to-text, Piper/XTTS for speech output, MuRIL/IndicBERT-class models for risk scoring.
- **Multilingual by design.** All UI strings go through i18next with browser-language auto-detection; Whisper handles 90+ spoken languages; community translations welcome via `locales/` PRs.
- **Anonymity as a system property.** UUID sessions, no accounts, no fingerprinting, auto-purge of all conversation data within 10 minutes of inactivity.

## Repository layout

```
apps/api/            Fastify API + WebSocket gateway (running: health/ready)
apps/worker/         Background jobs: risk scoring, purge, retries   (Phase 1+)
apps/web/            Anonymous user PWA (React + Vite + i18next)     (Phase 3+)
apps/dashboard/      Counsellor dashboard                            (Phase 5+)
packages/contracts/  Shared zod schemas: REST DTOs + WS events
packages/adapters/   Model/provider adapters (LLM, STT, TTS, risk…)  (Phase 3+)
services/inference/  Python sidecar: whisper, TTS, risk model        (Phase 4+)
infra/               docker-compose, migrations
```

See [ROADMAP.md](./ROADMAP.md) for the full phased implementation plan.

## Quickstart (Windows, no Docker, no admin rights)

```bash
npm install
cp .env.example .env

# One-time: extract the free PostgreSQL portable binaries to %LOCALAPPDATA%\zenith\pgsql
# (https://www.enterprisedb.com/download-postgresql-binaries), then:
npm run db:init      # initdb + create the zenith database
npm run migrate      # apply infra/migrations/*.sql

npm run dev:api      # API on :3000
npm run dev:worker   # purge loop (run in a second terminal)
# → GET http://localhost:3000/api/v1/health   liveness
# → GET http://localhost:3000/api/v1/ready    per-dependency readiness
```

Day-to-day: `npm run db:start` / `npm run db:stop`.

- **Ollama** (AI Buddy runtime): install from [ollama.com](https://ollama.com) (free, open source), then `ollama pull mistral:7b-instruct-q4_K_M`.
- **Docker instead?** `docker compose -f infra/docker-compose.yml up -d` starts Postgres + Ollama; Docker Desktop is free for personal/open-source use.

`/api/v1/ready` reports each dependency separately, so the API runs fine while you set these up.

## License

TBD before first public release — AGPL-3.0 recommended (keeps hosted forks open); MIT if maximum adoption matters more. Tracked in the roadmap.

## Safety scope

Zenith is not a medical product. It does not diagnose, prescribe, or replace therapy. It connects people to existing, staffed support services while keeping them anonymous.
