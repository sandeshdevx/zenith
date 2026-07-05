/**
 * Speech Prosody Extractor — scoring side (patent modules 104, 301–304).
 * Acoustic features are extracted client-side from the microphone stream
 * (privacy: raw audio never leaves the browser; only these numeric features
 * travel with the message). This module is the Feature Scoring Module (303):
 * weighted rule-based evaluation against distress thresholds → S3 (0–100).
 */

export interface ProsodyFeatures {
  /** fundamental frequency mean over voiced frames, Hz */
  f0Mean: number;
  /** fundamental frequency standard deviation, Hz — low = monotone */
  f0Std: number;
  /** syllabic/energy onsets per second — low = slowed speech */
  speechRate: number;
  /** silent frames / total frames, 0..1 — high = frequent pausing */
  pauseRatio: number;
  /** mean root-mean-square energy of voiced frames, 0..1 — low = flat voice */
  rmsEnergy: number;
}

interface FeatureRule {
  weight: number;
  score: (f: ProsodyFeatures) => number; // 0..100
}

/** Linear ramp: value at `from` → 0, value at `to` → 100 (direction-aware). */
function ramp(value: number, from: number, to: number): number {
  const t = (value - from) / (to - from);
  return Math.max(0, Math.min(100, t * 100));
}

// Distress-leaning acoustic markers (flat affect / psychomotor slowing):
// monotone pitch, slowed speech, frequent pauses, low vocal energy.
const RULES: FeatureRule[] = [
  { weight: 0.3, score: (f) => ramp(f.pauseRatio, 0.25, 0.65) },
  { weight: 0.3, score: (f) => ramp(f.f0Std, 40, 8) }, // lower variation → higher score
  { weight: 0.2, score: (f) => ramp(f.speechRate, 3.5, 1.2) }, // slower → higher
  { weight: 0.2, score: (f) => ramp(f.rmsEnergy, 0.08, 0.015) }, // quieter → higher
];

export function scoreProsody(features: ProsodyFeatures): number {
  let total = 0;
  for (const rule of RULES) total += rule.weight * rule.score(features);
  return Math.round(Math.max(0, Math.min(100, total)));
}

export function isPlausibleProsody(f: ProsodyFeatures): boolean {
  return (
    Number.isFinite(f.f0Mean) &&
    f.f0Mean >= 50 &&
    f.f0Mean <= 500 &&
    f.pauseRatio >= 0 &&
    f.pauseRatio <= 1 &&
    f.rmsEnergy >= 0 &&
    f.speechRate >= 0
  );
}
