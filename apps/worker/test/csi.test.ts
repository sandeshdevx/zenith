/**
 * CSI engine unit tests — patent claims 3–6:
 *  - fusion weights: w1+w2+w3 = 1.0, w2 grows with turn count (claim 4)
 *  - tier thresholds at 25/50/75 (claim 6)
 *  - prosody feature scoring direction (claim 3)
 *  - implicit screening accumulation via a deterministic fake embedder
 *    (claim 5) — requires PostgreSQL, skips otherwise
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  KeywordSentinelAdapter,
  scoreProsody,
  type EmbeddingAdapter,
} from "@zenith/adapters";
import { CsiEngine, CLINICAL_ITEMS, csiToTier, fusionWeights } from "../src/csi.js";

// --------------------------- pure-math tests --------------------------------

test("fusion weights always sum to 1 and w2 grows with turn count", () => {
  for (const t of [1, 2, 5, 10, 30]) {
    for (const hasProsody of [true, false]) {
      const w = fusionWeights(t, hasProsody);
      assert.ok(Math.abs(w.w1 + w.w2 + w.w3 - 1) < 1e-9, `sum=1 at t=${t}`);
      if (!hasProsody) assert.equal(w.w3, 0);
    }
  }
  assert.ok(fusionWeights(10, true).w2 > fusionWeights(1, true).w2, "w2 increases with t");
  assert.ok(fusionWeights(100, true).w2 <= 0.5, "w2 capped");
});

test("tier thresholds match claim 6 exactly", () => {
  assert.equal(csiToTier(0), "green");
  assert.equal(csiToTier(24), "green");
  assert.equal(csiToTier(25), "yellow");
  assert.equal(csiToTier(49), "yellow");
  assert.equal(csiToTier(50), "orange");
  assert.equal(csiToTier(74), "orange");
  assert.equal(csiToTier(75), "red");
  assert.equal(csiToTier(100), "red");
});

test("prosody scoring: flat slow quiet speech scores higher than lively speech", () => {
  const distressed = scoreProsody({
    f0Mean: 140,
    f0Std: 6, // monotone
    speechRate: 1.0, // slowed
    pauseRatio: 0.6, // frequent pauses
    rmsEnergy: 0.012, // quiet
  });
  const lively = scoreProsody({
    f0Mean: 180,
    f0Std: 45,
    speechRate: 4.0,
    pauseRatio: 0.15,
    rmsEnergy: 0.09,
  });
  assert.ok(distressed > 70, `distressed=${distressed}`);
  assert.ok(lively < 15, `lively=${lively}`);
});

// ----------------------- screening accumulation -----------------------------

/**
 * Deterministic fake embedder: each clinical item gets an orthogonal basis
 * vector; turn text containing a trigger keyword maps onto that item's
 * vector (cosine = 1). Everything else lands on an unused axis (cosine = 0).
 */
const TRIGGERS: Record<string, string> = {
  "phq9-2": "hopeless",
  "phq9-3": "sleep",
  "gad7-2": "worrying",
};

class FakeEmbedder implements EmbeddingAdapter {
  readonly name = "fake";
  private dim = CLINICAL_ITEMS.length + 4;

  private basis(index: number): number[] {
    const v = new Array(this.dim).fill(0);
    v[index] = 1;
    return v;
  }

  healthCheck(): Promise<boolean> {
    return Promise.resolve(true);
  }

  embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(
      texts.map((text) => {
        const itemIndex = CLINICAL_ITEMS.findIndex((item) => item.text === text);
        if (itemIndex >= 0) return this.basis(itemIndex);
        for (const [itemId, trigger] of Object.entries(TRIGGERS)) {
          if (text.toLowerCase().includes(trigger)) {
            return this.basis(CLINICAL_ITEMS.findIndex((i) => i.id === itemId));
          }
        }
        return this.basis(this.dim - 1); // orthogonal to everything
      }),
    );
  }
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://zenith:zenith@localhost:5432/zenith",
  connectionTimeoutMillis: 2000,
  max: 3,
});
pool.on("error", () => {});
let dbAvailable = false;

before(async () => {
  try {
    await pool.query("SELECT 1 FROM risk_screening LIMIT 1");
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  await pool.end().catch(() => {});
});

test("implicit screening accumulates item matches into S2 across turns", async (t) => {
  if (!dbAvailable) return t.skip("database unavailable");
  const engine = new CsiEngine(new KeywordSentinelAdapter(), new FakeEmbedder());
  assert.equal(await engine.initialize(), true);

  const sessionId = randomUUID();
  await pool.query("INSERT INTO sessions (id, status, mode) VALUES ($1, 'active', 'text')", [sessionId]);
  const addMsg = async (content: string) => {
    const { rows } = await pool.query(
      "INSERT INTO session_messages (session_id, sender, content) VALUES ($1, 'user', $2) RETURNING id",
      [sessionId, content],
    );
    return String(rows[0].id);
  };

  // Turn 1: matches phq9-3 (sleep) — one item accumulated.
  const m1 = await addMsg("I have not been able to sleep lately");
  const r1 = await engine.assess(pool, {
    sessionId,
    messageId: m1,
    content: "I have not been able to sleep lately",
    prosody: null,
    turnCount: 1,
  });
  assert.ok(r1.s2 > 0, "first item match produces S2 > 0");
  assert.ok(r1.signals.includes("screen:phq9-3"));

  // Turn 2: matches phq9-2 (hopeless) — accumulation grows S2.
  const m2 = await addMsg("everything feels hopeless honestly");
  const r2 = await engine.assess(pool, {
    sessionId,
    messageId: m2,
    content: "everything feels hopeless honestly",
    prosody: null,
    turnCount: 2,
  });
  assert.ok(r2.s2 > r1.s2, `S2 accumulates: ${r2.s2} > ${r1.s2}`);

  // Accumulator rows are item ids + numbers only, never content.
  const rows = await pool.query(
    "SELECT item_id FROM risk_screening WHERE session_id = $1 ORDER BY item_id",
    [sessionId],
  );
  assert.deepEqual(
    rows.rows.map((r) => r.item_id),
    ["phq9-2", "phq9-3"],
  );

  await pool.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
});

test("prosody raises CSI for the same words", async (t) => {
  if (!dbAvailable) return t.skip("database unavailable");
  const engine = new CsiEngine(new KeywordSentinelAdapter(), new FakeEmbedder());
  await engine.initialize();

  const sessionId = randomUUID();
  await pool.query("INSERT INTO sessions (id, status, mode) VALUES ($1, 'active', 'voice')", [sessionId]);
  const { rows } = await pool.query(
    "INSERT INTO session_messages (session_id, sender, content) VALUES ($1, 'user', 'everything feels hopeless') RETURNING id",
    [sessionId],
  );
  const base = {
    sessionId,
    messageId: String(rows[0].id),
    content: "everything feels hopeless",
    turnCount: 1,
  };

  const withoutVoice = await engine.assess(pool, { ...base, prosody: null });
  const withDistressedVoice = await engine.assess(pool, {
    ...base,
    prosody: { f0Mean: 140, f0Std: 6, speechRate: 1.0, pauseRatio: 0.6, rmsEnergy: 0.012 },
  });
  assert.ok(
    withDistressedVoice.csi > withoutVoice.csi,
    `voice signal raises CSI: ${withDistressedVoice.csi} > ${withoutVoice.csi}`,
  );
  assert.equal(withDistressedVoice.s3 !== null, true);

  await pool.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
});
