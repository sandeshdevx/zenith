import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { scoreProsody, isPlausibleProsody, type ProsodyFeatures } from "@zenith/adapters";

describe("Prosody Scoring (S3)", () => {
  describe("scoreProsody", () => {
    it("returns 0 for neutral/normal speech", () => {
      const normal: ProsodyFeatures = {
        f0Mean: 150,
        f0Std: 30,
        speechRate: 3.0,
        pauseRatio: 0.3,
        rmsEnergy: 0.05,
      };
      assert.equal(scoreProsody(normal), 0);
    });

    it("returns high score for flat affect", () => {
      const flat: ProsodyFeatures = {
        f0Mean: 120,
        f0Std: 5,
        speechRate: 1.0,
        pauseRatio: 0.7,
        rmsEnergy: 0.01,
      };
      assert.ok(scoreProsody(flat) > 70);
    });

    it("weights: pauseRatio 30%, f0Std 30%, speechRate 20%, rmsEnergy 20%", () => {
      const base: ProsodyFeatures = { f0Mean: 150, f0Std: 30, speechRate: 3.0, pauseRatio: 0.3, rmsEnergy: 0.05 };

      assert.equal(scoreProsody({ ...base, pauseRatio: 0.25 }), 0);
      assert.equal(scoreProsody({ ...base, pauseRatio: 0.65 }), 30);

      assert.equal(scoreProsody({ ...base, f0Std: 40 }), 0);
      assert.equal(scoreProsody({ ...base, f0Std: 8 }), 30);

      assert.equal(scoreProsody({ ...base, speechRate: 3.5 }), 0);
      assert.equal(scoreProsody({ ...base, speechRate: 1.2 }), 20);

      assert.equal(scoreProsody({ ...base, rmsEnergy: 0.08 }), 0);
      assert.equal(scoreProsody({ ...base, rmsEnergy: 0.015 }), 20);
    });

    it("clamps score to 0-100 range", () => {
      const extreme: ProsodyFeatures = {
        f0Mean: 100,
        f0Std: 0,
        speechRate: 0,
        pauseRatio: 1,
        rmsEnergy: 0,
      };
      assert.equal(scoreProsody(extreme), 100);
    });

    it("clamps negative values to 0", () => {
      const extreme: ProsodyFeatures = {
        f0Mean: 200,
        f0Std: 100,
        speechRate: 10,
        pauseRatio: 0,
        rmsEnergy: 1,
      };
      assert.equal(scoreProsody(extreme), 0);
    });
  });

  describe("isPlausibleProsody", () => {
    it("accepts valid features", () => {
      const valid: ProsodyFeatures = {
        f0Mean: 150,
        f0Std: 20,
        speechRate: 2.5,
        pauseRatio: 0.4,
        rmsEnergy: 0.04,
      };
      assert.equal(isPlausibleProsody(valid), true);
    });

    it("rejects f0Mean too low (< 50 Hz)", () => {
      assert.equal(isPlausibleProsody({ f0Mean: 40, f0Std: 20, speechRate: 2, pauseRatio: 0.3, rmsEnergy: 0.05 }), false);
    });

    it("rejects f0Mean too high (> 500 Hz)", () => {
      assert.equal(isPlausibleProsody({ f0Mean: 600, f0Std: 20, speechRate: 2, pauseRatio: 0.3, rmsEnergy: 0.05 }), false);
    });

    it("rejects negative pauseRatio", () => {
      assert.equal(isPlausibleProsody({ f0Mean: 150, f0Std: 20, speechRate: 2, pauseRatio: -0.1, rmsEnergy: 0.05 }), false);
    });

    it("rejects pauseRatio > 1", () => {
      assert.equal(isPlausibleProsody({ f0Mean: 150, f0Std: 20, speechRate: 2, pauseRatio: 1.5, rmsEnergy: 0.05 }), false);
    });

    it("rejects negative rmsEnergy", () => {
      assert.equal(isPlausibleProsody({ f0Mean: 150, f0Std: 20, speechRate: 2, pauseRatio: 0.3, rmsEnergy: -0.01 }), false);
    });

    it("rejects negative speechRate", () => {
      assert.equal(isPlausibleProsody({ f0Mean: 150, f0Std: 20, speechRate: -1, pauseRatio: 0.3, rmsEnergy: 0.05 }), false);
    });

    it("rejects NaN values", () => {
      assert.equal(isPlausibleProsody({ f0Mean: NaN, f0Std: 20, speechRate: 2, pauseRatio: 0.3, rmsEnergy: 0.05 }), false);
      assert.equal(isPlausibleProsody({ f0Mean: 150, f0Std: NaN, speechRate: 2, pauseRatio: 0.3, rmsEnergy: 0.05 }), false);
    });

    it("rejects Infinity values", () => {
      assert.equal(isPlausibleProsody({ f0Mean: Infinity, f0Std: 20, speechRate: 2, pauseRatio: 0.3, rmsEnergy: 0.05 }), false);
    });
  });
});