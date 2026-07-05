/**
 * Crisis Severity Index engine — patent modules:
 *   102 NLP Sentiment Engine        → S1 (keyword sentinel ∨ semantic distress)
 *   103 Implicit Clinical Screening → S2 (PHQ-9/GAD-7 item-embedding matches)
 *   104 Speech Prosody Extractor    → S3 (client-extracted acoustic features)
 *   105 Weighted Fusion Engine      → CSI = w1(t)·S1 + w2(t)·S2 + w3(t)·S3
 *   106 Tiered Response Engine      → Tier 1–4 automated interventions
 *
 * All computation keys off the anonymous session UUID (module 107); the
 * stored outputs are numbers and item ids — never conversation content.
 */
import type { Pool } from "pg";
import {
  cosineSimilarity,
  isPlausibleProsody,
  scoreProsody,
  RISK_TIER_RANK,
  type EmbeddingAdapter,
  type ProsodyFeatures,
  type RiskAdapter,
  type RiskTier,
} from "@zenith/adapters";

// ---------------------------------------------------------------------------
// Clinical item descriptors (patent 201–203). First-person paraphrases of the
// 16 PHQ-9 / GAD-7 items — pre-encoded at startup; never shown to the user.
// ---------------------------------------------------------------------------

export const CLINICAL_ITEMS: Array<{ id: string; text: string }> = [
  { id: "phq9-1", text: "I have little interest or pleasure in doing things I used to enjoy" },
  { id: "phq9-2", text: "I feel down, depressed and hopeless" },
  { id: "phq9-3", text: "I have trouble falling asleep, staying asleep, or I sleep too much" },
  { id: "phq9-4", text: "I feel tired all the time and have very little energy" },
  { id: "phq9-5", text: "I have a poor appetite or I keep overeating" },
  { id: "phq9-6", text: "I feel bad about myself, like I am a failure who has let everyone down" },
  { id: "phq9-7", text: "I have trouble concentrating on things like reading or studying" },
  { id: "phq9-8", text: "I move and speak very slowly, or I am restless and cannot sit still" },
  { id: "phq9-9", text: "I have thoughts that I would be better off dead or of hurting myself" },
  { id: "gad7-1", text: "I feel nervous, anxious and on edge" },
  { id: "gad7-2", text: "I cannot stop worrying or control my worries" },
  { id: "gad7-3", text: "I worry too much about many different things" },
  { id: "gad7-4", text: "I have trouble relaxing" },
  { id: "gad7-5", text: "I am so restless it is hard to sit still" },
  { id: "gad7-6", text: "I get easily annoyed and irritable" },
  { id: "gad7-7", text: "I feel afraid, as if something awful might happen" },
];

/** Distress prototypes for the semantic half of S1 (patent 102). */
const DISTRESS_PROTOTYPES = [
  "I am in unbearable emotional pain and I cannot cope anymore",
  "I feel completely overwhelmed, desperate and unable to go on",
  "I am deeply sad, everything feels dark and pointless",
];

/**
 * Neutral calibration set: cosine scales differ between embedding models
 * (bge-m3 runs ~0.1 hotter than nomic-embed-text, especially cross-lingually).
 * At init we measure each item's similarity ceiling against these neutral
 * sentences and place its operating threshold above that ceiling — never
 * below the patent's claimed bound of 0.55 (claim 5 upper end).
 */
const NEUTRAL_CALIBRATION = [
  "I went to the market today and bought some vegetables",
  "the cricket match yesterday was great, our team won",
  "आज मौसम अच्छा है और मैं बाहर घूमने गया",
  "can you tell me what time the shop opens tomorrow",
];

const MIN_ITEM_THRESHOLD = 0.55; // patent claim 5: range 0.40–0.55, upper end
const ITEM_MARGIN = 0.07; // required lift above the neutral ceiling
const DISTRESS_MARGIN_FLOOR = 0.05;
const DISTRESS_SPAN = 0.22; // floor → floor+span maps to 0 → 100
// Semantic similarity alone (no explicit crisis wording) cannot push S1 into
// the range reserved for stated intent — Tier 4 needs explicit language or
// sustained multi-signal escalation, not one paraphrase-adjacent sentence.
const SEMANTIC_S1_CAP = 80;

// Sentinel tier → representative S1 contribution (0–100).
const SENTINEL_S1: Record<RiskTier, number> = { green: 5, yellow: 40, orange: 65, red: 92 };

export interface CsiWeights {
  w1: number;
  w2: number;
  w3: number;
}

/**
 * Weighted Fusion Engine (105), claim 4: w1+w2+w3 = 1.0, varying with turn
 * count t. Early turns lean on sentiment + prosody; the implicit screening
 * weight grows as item evidence accumulates. Without voice, w3 mass folds
 * into w1.
 */
export function fusionWeights(turnCount: number, hasProsody: boolean): CsiWeights {
  const w2 = Math.min(0.5, 0.1 + 0.04 * Math.max(0, turnCount - 1));
  const rest = 1 - w2;
  if (hasProsody) {
    return { w1: rest * 0.6, w2, w3: rest * 0.4 };
  }
  return { w1: rest, w2, w3: 0 };
}

/** Tiered Response Engine thresholds (claim 6). */
export function csiToTier(csi: number): RiskTier {
  if (csi >= 75) return "red"; // Tier 4
  if (csi >= 50) return "orange"; // Tier 3
  if (csi >= 25) return "yellow"; // Tier 2
  return "green"; // Tier 1
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface CsiInputs {
  sessionId: string;
  messageId: string;
  content: string;
  prosody: ProsodyFeatures | null;
  /** user turn count including this message */
  turnCount: number;
}

export interface CsiResult {
  s1: number;
  s2: number;
  s3: number | null;
  csi: number;
  tier: RiskTier;
  weights: CsiWeights;
  signals: string[];
}

export class CsiEngine {
  private itemVectors: Map<string, number[]> | null = null;
  private itemThresholds: Map<string, number> = new Map();
  private distressVectors: number[][] = [];
  private distressFloor = 0.4;
  private embedderReady = false;

  constructor(
    private readonly sentinel: RiskAdapter,
    private readonly embedder: EmbeddingAdapter,
  ) {}

  /**
   * Pre-encode clinical items + distress prototypes (patent: at init) and
   * self-calibrate thresholds against the neutral sentence set, so any
   * embedding model (nomic, bge-m3, …) lands at an equivalent operating point.
   */
  async initialize(): Promise<boolean> {
    try {
      if (!(await this.embedder.healthCheck())) return false;
      const texts = [
        ...CLINICAL_ITEMS.map((i) => i.text),
        ...DISTRESS_PROTOTYPES,
        ...NEUTRAL_CALIBRATION,
      ];
      const vectors = await this.embedder.embed(texts);
      this.itemVectors = new Map(
        CLINICAL_ITEMS.map((item, i) => [item.id, vectors[i] ?? []]),
      );
      this.distressVectors = vectors.slice(
        CLINICAL_ITEMS.length,
        CLINICAL_ITEMS.length + DISTRESS_PROTOTYPES.length,
      );
      const neutralVectors = vectors.slice(CLINICAL_ITEMS.length + DISTRESS_PROTOTYPES.length);

      // Per-item threshold: above this item's neutral ceiling, never below
      // the claimed 0.55 bound.
      this.itemThresholds = new Map(
        CLINICAL_ITEMS.map((item) => {
          const vector = this.itemVectors!.get(item.id) ?? [];
          const neutralCeiling = Math.max(
            0,
            ...neutralVectors.map((n) => cosineSimilarity(vector, n)),
          );
          return [item.id, Math.max(MIN_ITEM_THRESHOLD, neutralCeiling + ITEM_MARGIN)];
        }),
      );

      const distressNeutralCeiling = Math.max(
        0,
        ...this.distressVectors.flatMap((d) =>
          neutralVectors.map((n) => cosineSimilarity(d, n)),
        ),
      );
      this.distressFloor = Math.max(0.35, distressNeutralCeiling + DISTRESS_MARGIN_FLOOR);

      this.embedderReady = true;
      return true;
    } catch {
      this.embedderReady = false;
      return false;
    }
  }

  isSemanticReady(): boolean {
    return this.embedderReady;
  }

  async assess(pool: Pool, input: CsiInputs): Promise<CsiResult> {
    const signals: string[] = [];

    // --- S1: NLP Sentiment Engine (102) -----------------------------------
    const sentinelResult = await this.sentinel.assess(input.content);
    signals.push(...sentinelResult.signals);
    let s1 = SENTINEL_S1[sentinelResult.tier];

    let turnVector: number[] | null = null;
    if (this.embedderReady) {
      try {
        const [vector] = await this.embedder.embed([input.content]);
        turnVector = vector ?? null;
      } catch {
        this.embedderReady = false; // re-established on next initialize()
      }
    }
    if (turnVector) {
      let best = 0;
      for (const proto of this.distressVectors) {
        best = Math.max(best, cosineSimilarity(turnVector, proto));
      }
      const semantic = Math.min(
        SEMANTIC_S1_CAP,
        clamp01((best - this.distressFloor) / DISTRESS_SPAN) * 100,
      );
      if (semantic > s1) {
        s1 = semantic;
        signals.push("semantic-distress");
      }
    }

    // --- S2: Implicit Clinical Screening Mapper (103, 201–203) ------------
    let s2 = 0;
    if (turnVector && this.itemVectors) {
      for (const item of CLINICAL_ITEMS) {
        const sim = cosineSimilarity(turnVector, this.itemVectors.get(item.id) ?? []);
        const threshold = this.itemThresholds.get(item.id) ?? MIN_ITEM_THRESHOLD;
        if (sim >= threshold) {
          const itemScore = clamp01((sim - threshold) / (0.95 - threshold)) * 100;
          // Item Score Accumulator (203): keep the best match per item.
          await pool.query(
            `INSERT INTO risk_screening (session_id, item_id, score)
             VALUES ($1, $2, $3)
             ON CONFLICT (session_id, item_id)
             DO UPDATE SET score = GREATEST(risk_screening.score, $3), updated_at = now()`,
            [input.sessionId, item.id, itemScore],
          );
          signals.push(`screen:${item.id}`);
        }
      }
      s2 = await this.compositeScreeningScore(pool, input.sessionId);
    }

    // --- S3: Speech Prosody Extractor (104, 301–304) ----------------------
    let s3: number | null = null;
    if (input.prosody && isPlausibleProsody(input.prosody)) {
      s3 = scoreProsody(input.prosody);
      signals.push("prosody");
    }

    // --- Fusion (105) ------------------------------------------------------
    const weights = fusionWeights(input.turnCount, s3 !== null);
    const csi = Math.round(
      weights.w1 * s1 + weights.w2 * s2 + weights.w3 * (s3 ?? 0),
    );
    const tier = csiToTier(csi);

    // Safety floor: an explicit RED sentinel hit (stated intent) is never
    // diluted below Tier 3 by fusion averaging.
    const floored =
      sentinelResult.tier === "red" && RISK_TIER_RANK[tier] < RISK_TIER_RANK.orange
        ? { csi: Math.max(csi, 60), tier: "orange" as RiskTier }
        : { csi, tier };

    return { s1: Math.round(s1), s2: Math.round(s2), s3, ...floored, weights, signals };
  }

  /** Composite S2 = PHQ-9 normalised × 0.6 + GAD-7 normalised × 0.4 (Fig. 2). */
  private async compositeScreeningScore(pool: Pool, sessionId: string): Promise<number> {
    const { rows } = await pool.query(
      "SELECT item_id, score FROM risk_screening WHERE session_id = $1",
      [sessionId],
    );
    let phq = 0;
    let gad = 0;
    for (const row of rows as Array<{ item_id: string; score: number }>) {
      if (row.item_id.startsWith("phq9")) phq += row.score;
      else gad += row.score;
    }
    const phqNorm = (phq / (9 * 100)) * 100;
    const gadNorm = (gad / (7 * 100)) * 100;
    return phqNorm * 0.6 + gadNorm * 0.4;
  }
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
