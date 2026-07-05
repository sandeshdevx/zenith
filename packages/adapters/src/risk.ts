/**
 * Risk classification boundary.
 * Layer 1 (this file): Keyword Sentinel — a fast, multilingual rule floor that
 * guarantees baseline recall. Layer 2 (future): a fine-tuned multilingual
 * classifier (MuRIL/IndicBERT) behind this same interface; the worker takes
 * the highest tier across adapters, so adding the model is purely additive.
 *
 * Assessment signals carry pattern IDs only, never matched text — scoring
 * output must stay free of conversation content.
 */

export type RiskTier = "green" | "yellow" | "orange" | "red";

export const RISK_TIER_RANK: Record<RiskTier, number> = {
  green: 0,
  yellow: 1,
  orange: 2,
  red: 3,
};

export interface RiskAssessment {
  tier: RiskTier;
  /** 0..1 — rule adapters emit coarse confidence per tier. */
  score: number;
  /** Pattern/feature identifiers only. Never content. */
  signals: string[];
}

export interface RiskAdapter {
  readonly name: string;
  assess(text: string): Promise<RiskAssessment>;
}

interface Pattern {
  id: string;
  tier: RiskTier;
  re: RegExp;
}

// English + Hindi (Devanagari) + romanized Hindi/Hinglish.
// RED = expressed intent to die; ORANGE = ideation/self-harm/hopelessness-severe;
// YELLOW = acute distress. The always-visible human option covers what rules miss.
const PATTERNS: Pattern[] = [
  // ---- RED: intent ----
  { id: "en-kill-self", tier: "red", re: /\b(kill(ing)?\s+myself|end(ing)?\s+my\s+life|take\s+my\s+(own\s+)?life)\b/i },
  { id: "en-suicide", tier: "red", re: /\bsuicid(e|al)\b/i },
  { id: "en-want-die", tier: "red", re: /\b(want(s)?\s+to\s+die|wish\s+i\s+(was|were)\s+dead|better\s+off\s+dead|going\s+to\s+end\s+it(\s+all)?)\b/i },
  { id: "hi-khudkushi", tier: "red", re: /\b(khudkushi|aatm?ahatya)\b/i },
  { id: "hi-marna", tier: "red", re: /\bmar(na|ne)\s+(chaht[ai]|hai\s+mujhe)\b/i },
  { id: "hi-jaan", tier: "red", re: /\b(apni\s+)?jaan\s+(de\s+d|le\s+l|khatam)\w*/i },
  { id: "dev-aatmahatya", tier: "red", re: /(आत्महत्या|खुदकुशी)/ },
  { id: "dev-marna", tier: "red", re: /मरना\s*चाहत[ाी]/ },
  { id: "dev-jaan", tier: "red", re: /(अपनी\s*)?जान\s*(दे|ले|खत्म)/ },

  // ---- ORANGE: ideation / self-harm / severe hopelessness ----
  { id: "en-no-reason", tier: "orange", re: /\b(no\s+reason\s+to\s+live|nothing\s+to\s+live\s+for|can'?t\s+go\s+on|giv(e|ing)\s+up\s+on\s+life)\b/i },
  { id: "en-self-harm", tier: "orange", re: /\b(self[\s-]?harm|harm(ing)?\s+myself|hurt(ing)?\s+myself|cut(ting)?\s+myself)\b/i },
  { id: "en-burden", tier: "orange", re: /\b(better\s+(off\s+)?without\s+me|burden\s+(to|on)\s+every(one|body)|disappear\s+forever)\b/i },
  { id: "hi-jeena-nahi", tier: "orange", re: /\bjee?na\s+nahi\s+chaht[ai]\b/i },
  { id: "hi-jeene-mann", tier: "orange", re: /\bjee?ne\s+ka\s+mann?\s+nahi\b/i },
  { id: "hi-sab-khatam", tier: "orange", re: /\bsab\s+(kuch\s+)?khatam\b/i },
  { id: "dev-jeena-nahi", tier: "orange", re: /जीना\s*नहीं\s*चाहत[ाी]/ },
  { id: "dev-jeene-mann", tier: "orange", re: /जीने\s*का\s*मन\s*नहीं/ },

  // ---- YELLOW: acute distress ----
  { id: "en-hopeless", tier: "yellow", re: /\b(hopeless|worthless|hate\s+myself|can'?t\s+take\s+(it|this)\s+any\s*more|empty\s+inside|no\s+one\s+cares)\b/i },
  { id: "en-panic", tier: "yellow", re: /\b(panic\s+attack|breaking\s+down|falling\s+apart)\b/i },
  { id: "hi-akela", tier: "yellow", re: /\b(bilkul\s+)?akel[ai]\s+(hoon|hun|feel)\b/i },
  { id: "hi-himmat", tier: "yellow", re: /\bhimm?at\s+nahi\b/i },
  { id: "dev-akela", tier: "yellow", re: /अकेल[ाी]\s*(हूँ|हूं|महसूस)/ },
  { id: "dev-toot", tier: "yellow", re: /टूट\s*(गया|गई|चुक[ाी])/ },
];

const TIER_SCORE: Record<RiskTier, number> = { green: 0, yellow: 0.4, orange: 0.7, red: 0.9 };

export class KeywordSentinelAdapter implements RiskAdapter {
  readonly name = "keyword-sentinel";

  assess(text: string): Promise<RiskAssessment> {
    const normalized = text.normalize("NFC");
    let tier: RiskTier = "green";
    const signals: string[] = [];
    for (const pattern of PATTERNS) {
      if (pattern.re.test(normalized)) {
        signals.push(pattern.id);
        if (RISK_TIER_RANK[pattern.tier] > RISK_TIER_RANK[tier]) tier = pattern.tier;
      }
    }
    return Promise.resolve({ tier, score: TIER_SCORE[tier], signals });
  }
}
