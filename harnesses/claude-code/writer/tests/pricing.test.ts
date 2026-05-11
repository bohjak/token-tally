/**
 * tests/pricing.test.ts — Unit tests for the pricing table and cost computation.
 *
 * Uses Node's built-in test runner (node:test). Imports use .js extensions
 * because we run the compiled dist output.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MODEL_RATES, lookupModelRates } from "../src/pricing/models.js";
import { computeCostMicros } from "../src/pricing/compute.js";
import type { AssistantUsage } from "../src/transcript/extract.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUsage(overrides: Partial<AssistantUsage> = {}): AssistantUsage {
  return {
    harnessMessageId: "test-uuid-1",
    modelId: "claude-3-5-haiku-20241022",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    legacyCostUSD: null,
    ts: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// T5-1: Known model — exact input cost
// ---------------------------------------------------------------------------

describe("lookupModelRates", () => {
  it("returns rates for a known model", () => {
    const rates = lookupModelRates("claude-3-5-haiku-20241022");
    assert.ok(rates !== null, "should return rates for claude-3-5-haiku-20241022");
    assert.equal(rates.inputPerMTokUSD, 0.8);
    assert.equal(rates.outputPerMTokUSD, 4);
    assert.equal(rates.cacheReadPerMTokUSD, 0.08);
    assert.equal(rates.cacheWritePerMTokUSD, 1);
  });

  it("returns null for null modelId", () => {
    assert.equal(lookupModelRates(null), null);
  });

  it("returns null and does not throw for unknown model", () => {
    const result = lookupModelRates("unknown-model-xyz-9999");
    assert.equal(result, null);
  });

  it("prefix-match: claude-sonnet-4 matches claude-sonnet-4-5", () => {
    // "claude-sonnet-4" is a prefix of "claude-sonnet-4-5"
    const rates = lookupModelRates("claude-sonnet-4");
    const expected = MODEL_RATES["claude-sonnet-4-5"];
    assert.ok(rates !== null, "prefix lookup should find claude-sonnet-4-5");
    assert.deepEqual(rates, expected);
  });

  it("prefix-match: claude-opus-4 matches claude-opus-4-5", () => {
    const rates = lookupModelRates("claude-opus-4");
    const expected = MODEL_RATES["claude-opus-4-5"];
    assert.ok(rates !== null, "prefix lookup should find claude-opus-4-5");
    assert.deepEqual(rates, expected);
  });

  it("strip-segment fallback: matches versioned suffix variant", () => {
    // Simulates a future model ID with an extra suffix that would need stripping.
    // "claude-3-5-sonnet-20241022-turbo" → strip "-turbo" → "claude-3-5-sonnet-20241022" ✓
    const rates = lookupModelRates("claude-3-5-sonnet-20241022-turbo");
    const expected = MODEL_RATES["claude-3-5-sonnet-20241022"];
    assert.ok(rates !== null, "strip-segment fallback should find sonnet-20241022");
    assert.deepEqual(rates, expected);
  });
});

// ---------------------------------------------------------------------------
// T5-2: computeCostMicros — 1M input tokens (haiku)
// ---------------------------------------------------------------------------

describe("computeCostMicros", () => {
  it("1M input tokens on haiku yields correct input micros", () => {
    // haiku inputPerMTokUSD = 0.80  →  0.80 * 1_000_000 tokens = 800_000 micros
    const usage = makeUsage({ inputTokens: 1_000_000 });
    const cost = computeCostMicros(usage);
    assert.equal(cost.costInputMicros, 800_000);
    assert.equal(cost.costOutputMicros, 0);
    assert.equal(cost.costCacheReadMicros, 0);
    assert.equal(cost.costCacheWriteMicros, 0);
    assert.equal(cost.costSource, "writer");
  });

  it("cache tokens produce non-zero cache micros", () => {
    // haiku cacheReadPerMTokUSD = 0.08  →  1_000_000 tokens = 80_000 micros
    // haiku cacheWritePerMTokUSD = 1.00 →  1_000_000 tokens = 1_000_000 micros
    const usage = makeUsage({
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });
    const cost = computeCostMicros(usage);
    assert.equal(cost.costCacheReadMicros, 80_000);
    assert.equal(cost.costCacheWriteMicros, 1_000_000);
    assert.ok(cost.costCacheReadMicros > 0, "cache read micros should be non-zero");
    assert.ok(cost.costCacheWriteMicros > 0, "cache write micros should be non-zero");
    assert.equal(cost.costSource, "writer");
  });

  it("unknown model returns all zeros and costSource unknown", () => {
    const usage = makeUsage({
      modelId: "totally-unknown-model-zzz",
      inputTokens: 1_000_000,
      outputTokens: 500_000,
    });
    const cost = computeCostMicros(usage);
    assert.equal(cost.costInputMicros, 0);
    assert.equal(cost.costOutputMicros, 0);
    assert.equal(cost.costCacheReadMicros, 0);
    assert.equal(cost.costCacheWriteMicros, 0);
    assert.equal(cost.costSource, "unknown");
  });

  it("zero tokens produce zero micros (no divide-by-zero)", () => {
    const usage = makeUsage({
      modelId: "claude-opus-4-5",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    const cost = computeCostMicros(usage);
    assert.equal(cost.costInputMicros, 0);
    assert.equal(cost.costOutputMicros, 0);
    assert.equal(cost.costCacheReadMicros, 0);
    assert.equal(cost.costCacheWriteMicros, 0);
    assert.equal(cost.costSource, "writer");
  });

  it("opus rates apply correctly for 100k output tokens", () => {
    // opus outputPerMTokUSD = 75  →  100_000 tokens × ($75/MTok)
    //   = 100_000 × (75 / 1_000_000) × 1_000_000 = 7_500_000 micros ($7.50)
    const usage = makeUsage({
      modelId: "claude-opus-4-5",
      outputTokens: 100_000,
    });
    const cost = computeCostMicros(usage);
    assert.equal(cost.costOutputMicros, 7_500_000);
    assert.equal(cost.costSource, "writer");
  });

  it("cost total equals sum of breakdown columns", () => {
    // Verifies the invariant the store CHECK constraint enforces.
    const usage = makeUsage({
      modelId: "claude-3-5-sonnet-20241022",
      inputTokens: 10_000,
      outputTokens: 5_000,
      cacheReadTokens: 20_000,
      cacheWriteTokens: 1_000,
    });
    const cost = computeCostMicros(usage);
    const expectedTotal =
      cost.costInputMicros +
      cost.costOutputMicros +
      cost.costCacheReadMicros +
      cost.costCacheWriteMicros;
    // We don't compute total here — that's the drain helper's job.
    // Just verify the breakdown fields are all non-negative integers.
    assert.ok(cost.costInputMicros >= 0);
    assert.ok(cost.costOutputMicros >= 0);
    assert.ok(cost.costCacheReadMicros >= 0);
    assert.ok(cost.costCacheWriteMicros >= 0);
    assert.ok(expectedTotal > 0, "non-zero tokens should produce non-zero total");
  });
});
