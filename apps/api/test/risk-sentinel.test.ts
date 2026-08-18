import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { KeywordSentinelAdapter, RISK_TIER_RANK } from "@zenith/adapters";

const sentinel = new KeywordSentinelAdapter();

describe("KeywordSentinelAdapter", () => {
  describe("RED tier — stated intent to die", () => {
    const redCases = [
      "I want to kill myself",
      "I'm going to end my life",
      "I want to die",
      "I wish I was dead",
      "I'm going to kill myself tonight",
      "I want to commit suicide",
      "I'm suicidal",
      "I'll take my own life",
      "better off dead",
      "going to end it all",
    ];

    for (const text of redCases) {
      it(`detects RED: "${text}"`, async () => {
        const result = await sentinel.assess(text);
        assert.equal(result.tier, "red");
        assert.equal(RISK_TIER_RANK[result.tier], 3);
        assert.ok(result.signals.length > 0);
      });
    }
  });

  describe("ORANGE tier — ideation / self-harm / severe hopelessness", () => {
    const orangeCases = [
      "I have no reason to live",
      "nothing to live for",
      "can't go on",
      "giving up on life",
      "I want to hurt myself",
      "self harm thoughts",
      "cutting myself",
      "better off without me",
      "burden to everyone",
      "disappear forever",
      "jeena nahi chahta",
      "jeene ka mann nahi",
      "sab kuch khatam",
    ];

    for (const text of orangeCases) {
      it(`detects ORANGE: "${text}"`, async () => {
        const result = await sentinel.assess(text);
        assert.equal(result.tier, "orange");
        assert.equal(RISK_TIER_RANK[result.tier], 2);
        assert.ok(result.signals.length > 0);
      });
    }
  });

  describe("YELLOW tier — acute distress", () => {
    const yellowCases = [
      "I feel hopeless",
      "I feel worthless",
      "I hate myself",
      "can't take it anymore",
      "empty inside",
      "no one cares",
      "panic attack",
      "breaking down",
      "falling apart",
      "bilkul akela hoon",
      "himmat nahi hai",
      "akela feel kar raha hoon",
    ];

    for (const text of yellowCases) {
      it(`detects YELLOW: "${text}"`, async () => {
        const result = await sentinel.assess(text);
        assert.equal(result.tier, "yellow");
        assert.equal(RISK_TIER_RANK[result.tier], 1);
        assert.ok(result.signals.length > 0);
      });
    }
  });

  describe("GREEN tier — no crisis signals", () => {
    const greenCases = [
      "I'm having a good day",
      "Just wanted to chat",
      "How are you?",
      "The weather is nice",
      "I ate lunch",
      "Going for a walk",
      "Feeling okay today",
    ];

    for (const text of greenCases) {
      it(`detects GREEN: "${text}"`, async () => {
        const result = await sentinel.assess(text);
        assert.equal(result.tier, "green");
        assert.equal(RISK_TIER_RANK[result.tier], 0);
        assert.equal(result.signals.length, 0);
      });
    }
  });

  describe("Multilingual support", () => {
    it("detects Hindi Devanagari RED patterns", async () => {
      const result = await sentinel.assess("मैं आत्महत्या करना चाहता हूँ");
      assert.equal(result.tier, "red");
    });

    it("detects Hindi romanized RED patterns", async () => {
      const result = await sentinel.assess("main khudkushi karna chahta hoon");
      assert.equal(result.tier, "red");
    });

    it("detects mixed Hinglish", async () => {
      const result = await sentinel.assess("mujhe marna hai, I want to die");
      assert.equal(result.tier, "red");
    });
  });

  describe("Scoring", () => {
    it("returns score matching tier", async () => {
      const red = await sentinel.assess("I want to kill myself");
      assert.equal(red.score, 0.9);

      const orange = await sentinel.assess("I have no reason to live");
      assert.equal(orange.score, 0.7);

      const yellow = await sentinel.assess("I feel hopeless");
      assert.equal(yellow.score, 0.4);

      const green = await sentinel.assess("Hello there");
      assert.equal(green.score, 0);
    });

    it("returns pattern IDs in signals (never user content)", async () => {
      const result = await sentinel.assess("I want to kill myself and end my life");
      for (const signal of result.signals) {
        // Signals are pattern IDs like "en-kill-self", "en-want-die" - not the actual matched text
        assert.match(signal, /^[a-z-]+$/);
        // They should not contain the user's actual words beyond the pattern ID structure
        assert.ok(!signal.includes("myself"));
        assert.ok(!signal.includes("life"));
        assert.ok(!signal.includes("want"));
        assert.ok(!signal.includes("and"));
      }
    });
  });

  describe("Edge cases", () => {
    it("handles empty string", async () => {
      const result = await sentinel.assess("");
      assert.equal(result.tier, "green");
    });

    it("handles very long text", async () => {
      const longText = "hello ".repeat(1000);
      const result = await sentinel.assess(longText);
      assert.equal(result.tier, "green");
    });

    it("handles unicode gracefully", async () => {
      const result = await sentinel.assess("😀😃😄😁😊");
      assert.equal(result.tier, "green");
    });

    it("picks highest tier when multiple patterns match", async () => {
      const result = await sentinel.assess("I feel hopeless and want to kill myself");
      assert.equal(result.tier, "red");
    });
  });
});