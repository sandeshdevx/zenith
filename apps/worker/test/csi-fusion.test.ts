import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { fusionWeights, csiToTier } from "../src/csi.js";
import { RISK_TIER_RANK, SENTINEL_S1, type RiskTier, type CsiWeights } from "@zenith/adapters";

describe("CSI Engine — Fusion Weights & Tier Thresholds", () => {
  describe("fusionWeights", () => {
    it("sums to 1.0 for all turn counts", () => {
      for (let t = 1; t <= 20; t++) {
        const w = fusionWeights(t, true);
        const sum = w.w1 + w.w2 + w.w3;
        assert.ok(Math.abs(sum - 1.0) < 0.0001);
      }
    });

    it("w2 grows with turn count (capped at 0.5)", () => {
      const w1 = fusionWeights(1, true);
      const w5 = fusionWeights(5, true);
      const w15 = fusionWeights(15, true);
      assert.ok(w5.w2 > w1.w2);
      assert.equal(w15.w2, 0.5);
    });

    it("w3 is 0 when no prosody", () => {
      const w = fusionWeights(5, false);
      assert.equal(w.w3, 0);
      assert.ok(Math.abs(w.w1 + w.w2 - 1.0) < 0.0001);
    });

    it("w3 > 0 when prosody available", () => {
      const w = fusionWeights(5, true);
      assert.ok(w.w3 > 0);
    });

    it("early turns: w1 dominates, w2 minimal", () => {
      const w = fusionWeights(1, true);
      assert.ok(w.w1 > 0.5);
      assert.equal(w.w2, 0.1);
      assert.ok(w.w3 > 0.3);
    });

    it("later turns: w2 grows, w1 shrinks", () => {
      const w = fusionWeights(10, true);
      assert.ok(Math.abs(w.w2 - 0.46) < 0.001);
      assert.ok(w.w1 < 0.4);
    });
  });

  describe("csiToTier", () => {
    const testCases: Array<{ csi: number; expected: RiskTier }> = [
      { csi: 0, expected: "green" },
      { csi: 10, expected: "green" },
      { csi: 24, expected: "green" },
      { csi: 25, expected: "yellow" },
      { csi: 30, expected: "yellow" },
      { csi: 49, expected: "yellow" },
      { csi: 50, expected: "orange" },
      { csi: 60, expected: "orange" },
      { csi: 74, expected: "orange" },
      { csi: 75, expected: "red" },
      { csi: 90, expected: "red" },
      { csi: 100, expected: "red" },
    ];

    for (const { csi, expected } of testCases) {
      it(`CSI ${csi} → ${expected}`, () => {
        assert.equal(csiToTier(csi), expected);
      });
    }

    it("tier rank ordering is correct", () => {
      assert.equal(RISK_TIER_RANK.green, 0);
      assert.equal(RISK_TIER_RANK.yellow, 1);
      assert.equal(RISK_TIER_RANK.orange, 2);
      assert.equal(RISK_TIER_RANK.red, 3);
    });

    it("never downgrades (monotonic)", () => {
      const tiers: RiskTier[] = ["green", "yellow", "orange", "red"];
      for (let i = 0; i < tiers.length; i++) {
        for (let j = i + 1; j < tiers.length; j++) {
          assert.ok(RISK_TIER_RANK[tiers[j]] > RISK_TIER_RANK[tiers[i]]);
        }
      }
    });
  });

  describe("Sentinel S1 values", () => {
    it("SENTINEL_S1 values are ordered correctly", () => {
      assert.ok(SENTINEL_S1.red > SENTINEL_S1.orange);
      assert.ok(SENTINEL_S1.orange > SENTINEL_S1.yellow);
      assert.ok(SENTINEL_S1.yellow > SENTINEL_S1.green);
    });
  });
});