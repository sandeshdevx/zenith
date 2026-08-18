# Graph Report - zenith  (2026-08-18)

## Corpus Check
- 90 files · ~15,000 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 736 nodes · 1146 edges · 44 communities (39 shown, 5 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 8 edges (avg confidence: 0.76)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Community 0
- Community 1
- Community 2
- Community 3
- Community 4
- Community 5
- Community 6
- Community 7
- Community 8
- Community 9
- Community 10
- Community 11
- Community 12
- Community 13
- Community 14
- Community 15
- Community 16
- Community 17
- Community 18
- Community 19
- Community 20
- Community 21
- Community 22
- Community 23
- Community 24
- Community 25
- Community 26
- Community 27
- Community 28
- Community 29
- Community 30
- Community 31
- Community 32
- Community 33
- Community 34
- Community 35
- Community 36
- Community 38
- Community 40
- Community 41

## God Nodes (most connected - your core abstractions)
1. `App()` - 20 edges
2. `buildServer()` - 19 edges
3. `registerCounsellorRoutes()` - 16 edges
4. `🌙 Zenith — Anonymous AI Mental Health Support` - 14 edges
5. `compilerOptions` - 13 edges
6. `compilerOptions` - 13 edges
7. `scripts` - 13 edges
8. `registerSessionRoutes()` - 12 edges
9. `loadConfig()` - 11 edges
10. `CsiEngine` - 10 edges

## Surprising Connections (you probably didn't know these)
- `CsiInputs` --references--> `ProsodyFeatures`  [EXTRACTED]
  apps/worker/src/csi.ts → packages/adapters/src/prosody.ts
- `CsiResult` --references--> `RiskTier`  [EXTRACTED]
  apps/worker/src/csi.ts → packages/adapters/src/risk.ts
- `ScoreOutcome` --references--> `RiskTier`  [EXTRACTED]
  apps/worker/src/risk.ts → packages/adapters/src/risk.ts
- `RealtimeCallbacks` --references--> `WsServerFrame`  [EXTRACTED]
  apps/web/src/session.ts → packages/contracts/src/index.ts
- `FakeEmbedder` --implements--> `EmbeddingAdapter`  [EXTRACTED]
  apps/worker/test/csi.test.ts → packages/adapters/src/embeddings.ts

## Import Cycles
- None detected.

## Communities (44 total, 5 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.07
Nodes (44): App(), ChatMessage, detectTextLanguage(), nextKey(), Phase, Status, ThemeMode, useTheme() (+36 more)

### Community 1 - "Community 1"
Cohesion: 0.09
Nodes (36): b64url(), hmac(), SessionTokenPayload, signSessionToken(), verifySessionToken(), app, creations, pruneRateLimiter() (+28 more)

### Community 2 - "Community 2"
Cohesion: 0.04
Nodes (45): dependencies, fastify, @fastify/cookie, @fastify/static, @fastify/websocket, pg, pg-boss, pino-pretty (+37 more)

### Community 3 - "Community 3"
Cohesion: 0.07
Nodes (35): acceptSession(), CounsellorRealtime, declineSession(), fetchQueue(), requestLink(), setAvailability(), verifyLink(), ActiveCall (+27 more)

### Community 4 - "Community 4"
Cohesion: 0.05
Nodes (38): Border Radius Scale, Brand & Accent, Breakpoints, Buttons, Cards & Containers, Collapsing Strategy, Colors, Components (+30 more)

### Community 5 - "Community 5"
Cohesion: 0.05
Nodes (37): dependencies, i18next, i18next-browser-languagedetector, react, react-dom, react-i18next, @zenith/contracts, devDependencies (+29 more)

### Community 6 - "Community 6"
Cohesion: 0.06
Nodes (35): dependencies, i18next, react, react-dom, react-i18next, @zenith/contracts, devDependencies, tailwindcss (+27 more)

### Community 7 - "Community 7"
Cohesion: 0.12
Nodes (22): boss, csiEngine, env, envSchema, main(), pool, purgeLoop(), purgeExpiredSessions() (+14 more)

### Community 8 - "Community 8"
Cohesion: 0.07
Nodes (27): dependencies, pg, pg-boss, @zenith/adapters, zod, devDependencies, tsx, @types/node (+19 more)

### Community 9 - "Community 9"
Cohesion: 0.08
Nodes (24): concurrently, description, devDependencies, concurrently, engines, node, name, private (+16 more)

### Community 10 - "Community 10"
Cohesion: 0.17
Nodes (16): closePool(), getPool(), boss, buddy, config, ensureDemoCounsellor(), UserMessageHook, registerSttRoute() (+8 more)

### Community 11 - "Community 11"
Cohesion: 0.17
Nodes (14): clamp01(), CLINICAL_ITEMS, CsiEngine, CsiResult, csiToTier(), CsiWeights, DISTRESS_PROTOTYPES, fusionWeights() (+6 more)

### Community 12 - "Community 12"
Cohesion: 0.11
Nodes (18): compilerOptions, forceConsistentCasingInFileNames, isolatedModules, jsx, lib, module, moduleResolution, noEmit (+10 more)

### Community 13 - "Community 13"
Cohesion: 0.11
Nodes (18): compilerOptions, forceConsistentCasingInFileNames, isolatedModules, jsx, lib, module, moduleResolution, noEmit (+10 more)

### Community 14 - "Community 14"
Cohesion: 0.11
Nodes (18): Alternative: Docker for PostgreSQL + Ollama, 🎮 Commands, 📖 Documentation, ✅ Features (Production-Ready), 🎓 Final Year Project — Demo Ready, Install & Run (One Command!), License, Prerequisites (+10 more)

### Community 15 - "Community 15"
Cohesion: 0.14
Nodes (10): envSchema, loadConfig(), loadDotenv(), MIGRATIONS_DIR, config, displayName, [email, ...nameParts], pool (+2 more)

### Community 16 - "Community 16"
Cohesion: 0.23
Nodes (14): generateTotpSecret(), totpUri(), availabilityBodySchema, loginBodySchema, registerCounsellorRoutes(), unauthorized(), verifyBodySchema, acceptAlert() (+6 more)

### Community 17 - "Community 17"
Cohesion: 0.14
Nodes (10): sentinel, LABELLED, sentinel, KeywordSentinelAdapter, Pattern, PATTERNS, RISK_TIER_RANK, RiskAdapter (+2 more)

### Community 18 - "Community 18"
Cohesion: 0.12
Nodes (15): dependencies, zod, devDependencies, typescript, exports, typescript, zod, main (+7 more)

### Community 19 - "Community 19"
Cohesion: 0.13
Nodes (14): devDependencies, @types/node, typescript, exports, @types/node, typescript, main, name (+6 more)

### Community 20 - "Community 20"
Cohesion: 0.15
Nodes (5): BuddyService, adapter, config, LlmAdapter, OllamaLlmAdapter

### Community 21 - "Community 21"
Cohesion: 0.21
Nodes (12): FastAPI, get, post, Request, build_voice_catalogue(), health(), lifespan(), Zenith speech sidecar — faster-whisper STT + edge-tts neural voices. Implements… (+4 more)

### Community 22 - "Community 22"
Cohesion: 0.23
Nodes (7): OllamaEmbeddingAdapter, OllamaEmbeddingConfig, ChatMessage, ChatStreamOptions, OllamaAdapterConfig, OpenAICompatConfig, NOTE: a hosted provider sees conversation text (no identity attached);

### Community 23 - "Community 23"
Cohesion: 0.29
Nodes (9): startAlertDispatcher(), connect(), handle(), broadcastToCounsellors(), AcceptResult, ALERT_TTL_MINUTES, getAlertById(), listActiveAlerts() (+1 more)

### Community 24 - "Community 24"
Cohesion: 0.29
Nodes (6): b64url(), CounsellorTokenPayload, hmac(), signCounsellorToken(), config, seedCounsellorToken()

### Community 25 - "Community 25"
Cohesion: 0.29
Nodes (6): base32Decode(), currentTotp(), totpAt(), verifyTotp(), config, RFC-6238

### Community 26 - "Community 26"
Cohesion: 0.20
Nodes (9): compilerOptions, allowImportingTsExtensions, noEmit, types, extends, include, node, src (+1 more)

### Community 27 - "Community 27"
Cohesion: 0.28
Nodes (3): FakeEmbedder, cosineSimilarity(), EmbeddingAdapter

### Community 28 - "Community 28"
Cohesion: 0.28
Nodes (6): CsiInputs, FeatureRule, isPlausibleProsody(), ProsodyFeatures, RULES, scoreProsody()

### Community 29 - "Community 29"
Cohesion: 0.22
Nodes (8): compilerOptions, noEmit, types, extends, include, node, src, ../../tsconfig.base.json

### Community 30 - "Community 30"
Cohesion: 0.22
Nodes (8): compilerOptions, noEmit, types, extends, include, node, src, ../../tsconfig.base.json

### Community 31 - "Community 31"
Cohesion: 0.29
Nodes (6): verifyCounsellorToken(), Config, counsellorSockets, registerCounsellorGateway(), authenticate(), counsellorClientFrameSchema

### Community 32 - "Community 32"
Cohesion: 0.29
Nodes (6): compilerOptions, noEmit, extends, include, src, ../../tsconfig.base.json

### Community 33 - "Community 33"
Cohesion: 0.47
Nodes (5): checkOllama(), checkPostgres(), registerHealthRoutes(), DependencyStatus, ReadyResponse

### Community 35 - "Community 35"
Cohesion: 0.50
Nodes (3): services/inference — Whisper STT sidecar, Setup, Still planned (contributions welcome)

## Knowledge Gaps
- **307 isolated node(s):** `name`, `version`, `private`, `type`, `dev` (+302 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `WsServerFrame` connect `Community 1` to `Community 0`, `Community 3`, `Community 20`, `Community 15`?**
  _High betweenness centrality (0.015) - this node is a cross-community bridge._
- **Why does `buildServer()` connect `Community 10` to `Community 1`, `Community 33`, `Community 15`, `Community 16`, `Community 20`, `Community 23`, `Community 24`, `Community 25`, `Community 31`?**
  _High betweenness centrality (0.010) - this node is a cross-community bridge._
- **Why does `loadConfig()` connect `Community 15` to `Community 1`, `Community 10`, `Community 20`, `Community 24`, `Community 25`?**
  _High betweenness centrality (0.007) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _307 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.06654567453115548 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.08521870286576169 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.043478260869565216 - nodes in this community are weakly interconnected._