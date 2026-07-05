# Deploying Zenith

Everything in the default deployment is free software. The whole platform is
**one Node process + PostgreSQL + Ollama** — the API serves both built
frontends (`/` = anonymous PWA, `/counsellor` = dashboard) plus the worker
process.

## What a production host needs

| Component | Minimum | Notes |
|---|---|---|
| CPU/RAM | 4 vCPU / 8 GB | Mistral 7B Q4 on CPU fits in ~5 GB; more RAM = snappier |
| Disk | 20 GB | model weights ~4.4 GB + Postgres |
| OS | any Linux, Windows, macOS | Node 20+, PostgreSQL 14+, Ollama |
| Cost | ₹0 software | e.g. Oracle Cloud's always-free Ampere VM (4 OCPU / 24 GB) runs it comfortably; or any machine you already own |

## Steps (bare-metal, any OS)

```bash
git clone https://github.com/sandeshdevx/zenith && cd zenith
npm ci

# 1. PostgreSQL: create a database and user, then
cp .env.example .env    # set DATABASE_URL, SESSION_TOKEN_SECRET (long random!), COOKIE_SECURE=true
npm run migrate

# 2. Ollama (free, open source): install from ollama.com, then
ollama pull mistral:7b-instruct-q4_K_M

# 3. Build the frontends (the API will serve them automatically)
npm run build -w @zenith/web
npm run build -w @zenith/dashboard

# 4. Run both processes (use systemd / pm2 / NSSM to keep them alive)
npm run start -w @zenith/api
npm run start -w @zenith/worker

# 5. Onboard a counsellor
npm run seed:counsellor -w @zenith/api -- someone@yourorg.org Their Name
# magic-link tokens appear in the API log until SMTP is configured
```

Put a TLS reverse proxy in front (Caddy is free and auto-provisions
certificates): proxy `:443 → 127.0.0.1:3000` including WebSocket upgrade.
Set `COOKIE_SECURE=true` behind HTTPS.

## Docker path

`infra/docker-compose.yml` starts Postgres + Ollama. Run the API/worker on
the host, or contribute production Dockerfiles (welcome!).

## Production checklist

- [ ] `SESSION_TOKEN_SECRET` is long and random (never the dev default)
- [ ] `COOKIE_SECURE=true`, TLS terminated in front
- [ ] Purge worker running (verify: `system_audit_logs` gains
      `session_purge` rows; sessions table stays near-empty)
- [ ] `/api/v1/ready` returns 200 (Postgres + Ollama healthy)
- [ ] Backups: if you back up Postgres at all, keep retention short —
      conversation content must not outlive its session in any copy
- [ ] Jitsi: default is the free public meet.jit.si; self-host
      docker-jitsi-meet for full control
- [ ] PSTN bridge stays **off** unless you have a compliant SIP trunk
      (see docs/pstn-bridge.md)
- [ ] Counsellors enrolled with TOTP (POST /api/v1/counsellor/totp/enroll)

## What is intentionally NOT deployed

No analytics, no trackers, no CDN beyond fonts, no third-party APIs with
keys. If a change adds a paid or account-required dependency to the default
path, it breaks the project's promise — flag it in review.
