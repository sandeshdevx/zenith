/**
 * Keyword Sentinel: labelled-phrase replay across English, Hindi (Devanagari),
 * and romanized Hinglish. The sentinel is the recall floor — RED intent
 * phrases must never score GREEN.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { KeywordSentinelAdapter, type RiskTier } from "@zenith/adapters";

const sentinel = new KeywordSentinelAdapter();

const LABELLED: Array<[string, RiskTier]> = [
  // green — ordinary distress-free or mild content
  ["I had a long day at work and I'm tired", "green"],
  ["exams are coming up and I'm stressed", "green"],
  ["आज का दिन ठीक था", "green"],

  // yellow — acute distress
  ["I feel completely hopeless about everything", "yellow"],
  ["I hate myself sometimes", "yellow"],
  ["i can't take it anymore", "yellow"],
  ["main bilkul akela hoon", "yellow"],
  ["मैं टूट गया हूँ", "yellow"],

  // orange — ideation / self-harm / severe hopelessness
  ["there is no reason to live anymore", "orange"],
  ["I've been hurting myself lately", "orange"],
  ["everyone would be better off without me", "orange"],
  ["ab jeene ka mann nahi hai", "orange"],
  ["जीना नहीं चाहता मैं अब", "orange"],

  // red — expressed intent
  ["I want to die", "red"],
  ["i am going to kill myself tonight", "red"],
  ["I keep thinking about suicide", "red"],
  ["mujhe khudkushi ke khayal aate hain", "red"],
  ["मैं आत्महत्या करना चाहता हूँ", "red"],
  ["ab apni jaan de dunga", "red"],
];

test("labelled phrases score at their expected tier", async () => {
  for (const [text, expected] of LABELLED) {
    const result = await sentinel.assess(text);
    assert.equal(result.tier, expected, `"${text}" → expected ${expected}, got ${result.tier}`);
  }
});

test("signals contain pattern ids, never message content", async () => {
  const result = await sentinel.assess("I want to die and nothing matters, xylophone");
  assert.ok(result.signals.length > 0);
  for (const signal of result.signals) {
    // Pattern ids are static vocabulary (e.g. "en-want-die"); the invariant is
    // that the user's own words never leak into signals.
    assert.match(signal, /^(en|hi|dev)-[a-z-]+$/);
    assert.ok(!signal.includes("xylophone"), "user-specific words must not leak");
  }
});

test("mixed-tier text takes the highest tier", async () => {
  const result = await sentinel.assess("I feel hopeless and I want to die");
  assert.equal(result.tier, "red");
});
