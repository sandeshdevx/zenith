# Crisis Severity Index — implementation map

This document maps every module of the *Digital Mental Health Support System*
patent specification (New Horizon College of Engineering, May 2026) to its
implementation in this repository. It exists as working evidence that the
platform practises the claimed system.

## Module map (claims 1–3)

| Patent module | Name | Implementation |
|---|---|---|
| **100** | Digital Mental Health Support System | this repository |
| **101** | Speech Input & Preprocessing | `apps/web/src/voice.ts` (recognition) + `apps/web/src/prosody.ts` (mic acquisition, silence gating, frame conditioning — on-device) |
| **102** | NLP Sentiment Engine → **S1** | `apps/worker/src/csi.ts` (`assess`): multilingual keyword sentinel (`packages/adapters/src/risk.ts`) ∨ semantic distress-prototype similarity via nomic-embed-text |
| **103** | Implicit Clinical Screening Mapper → **S2** | `apps/worker/src/csi.ts` — see 201–203 below |
| **104** | Speech Prosody Extractor → **S3** | features: `apps/web/src/prosody.ts` (client); scoring: `packages/adapters/src/prosody.ts` |
| **105** | Weighted Fusion Engine → **CSI** | `fusionWeights()` + `assess()` in `apps/worker/src/csi.ts` |
| **106** | Tiered Response Engine | `csiToTier()` + `applyTieredResponse()` in `apps/worker/src/risk.ts` |
| **107** | Anonymous Session Management | `apps/api/src/auth/sessionToken.ts`, `apps/api/src/routes/sessions.ts`, purge worker (`apps/worker/src/purge.ts`) |
| **201** | Sentence Embedding Input | `OllamaEmbeddingAdapter.embed()` (`packages/adapters/src/embeddings.ts`) — use `EMBED_MODEL=bge-m3` (100+ languages) so screening works cross-lingually against the English item descriptors; nomic-embed-text is English-only |
| **202** | Semantic Similarity Computation | `cosineSimilarity()` against 16 pre-encoded PHQ-9/GAD-7 item vectors; threshold **0.55** (claimed range 0.40–0.55) |
| **203** | Item Score Accumulator | `risk_screening` table (best score per item per session) + `compositeScreeningScore()`: S2 = PHQ-9ₙ×0.6 + GAD-7ₙ×0.4 |
| **301** | Acoustic Feature Input | `AnalyserNode` frame capture in `apps/web/src/prosody.ts` |
| **302** | Prosody Feature Extraction | F0 mean/std (autocorrelation), speech rate (energy onsets/s), pause ratio, RMS energy |
| **303** | Feature Scoring Module | weighted rules vs distress thresholds (`scoreProsody`) |
| **304** | Prosody Score Output | S3 ∈ [0,100], attached to the message (numbers only — raw audio never leaves the device) |

## Fusion (claim 4)

`CSI = w1(t)·S1 + w2(t)·S2 + w3(t)·S3`, with `w2(t) = min(0.5, 0.10 + 0.04·(t−1))`
growing with turn count *t* (implicit screening is accumulation-dependent), the
remainder split 60/40 between S1 and S3 when voice is present, all of it to S1
in text mode. Invariant `w1+w2+w3 = 1.0` is unit-tested.

## Tiers (claim 6)

| Tier | CSI | Response | Where |
|---|---|---|---|
| 1 | 0–24 | conversation continues unmodified | — |
| 2 | 25–49 | passive resource reference woven into the buddy's own reply; no hint of assessment | prompt injection in `apps/api/src/services/buddy.ts` |
| 3 | 50–74 | silent background alert (session token + tier/CSI only) to online counsellors | `raiseAlert` → pg_notify → counsellor WebSocket |
| 4 | 75–100 | anonymous encrypted video room auto-created; link to counsellors with the alert; buddy-framed prompt to the user simultaneously | `openHandoffRoom` in `apps/worker/src/risk.ts` |

Safety additions beyond the claims: Tier 3/4 dispatch requires 2 of the last 3
assessments high (false-positive control), tiers never downgrade, an explicit
RED keyword hit is floored at Tier 3 regardless of fusion dilution, and an
unclaimed Tier 4 alert falls back to inline helpline numbers after 90 seconds.

## Anonymity (claim 7)

Sessions are HMAC-signed UUID tokens; no name/email/phone/fingerprint columns
exist anywhere in the schema; IPs live only in an in-memory rate counter;
alert payloads are whitelist-serialized; all conversation-adjacent rows
(messages, assessments, screening accumulators, events) cascade-delete when
the session is purged — within 10 minutes of inactivity or immediately on exit.

## Verified behaviour (automated tests + live runs)

- Implicit detection with **zero crisis keywords** ("can't sleep… nothing is
  enjoyable… constant worry") escalates to Tier 3 across three turns while
  the keyword layer alone stays green — the patent's core scenario.
- Prosody: identical words with flat/slow/quiet voice features score a higher
  CSI than text alone.
- Weight invariants, tier thresholds, accumulation monotonicity, purge no-op,
  and Tier 4 room+prompt creation are covered in `apps/worker/test/`.
