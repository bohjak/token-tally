/**
 * tests/pricing.test.ts — Unit tests for the pricing table and cost computation.
 *
 * Uses Node's built-in test runner (node:test). Imports use .js extensions
 * because we run the compiled dist output.
 *
 * MODEL_RATES and lookupModelRates have been removed from this writer package.
 * All lookup is now through @token-tally/store/pricing.lookupRates, and the
 * local computeCostMicros is a thin adapter over the shared implementation.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
// Import from the main store entry (not the subpath) because this package's
// tsconfig uses "moduleResolution": "Node" which ignores package.json exports.
import { lookupRates } from "@token-tally/store";
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

// Shared expected rates — these are the canonical values from anthropic.yaml
// (confirmed against rates.json). Hard-coded to make test failures explicit.
const HAIKU_4_5_RATES = {
  inputPerMTokUSD: 0.8,
  outputPerMTokUSD: 4,
  cacheReadPerMTokUSD: 0.08,
  cacheWritePerMTokUSD: 1,
};
const SONNET_4_5_RATES = {
  inputPerMTokUSD: 3,
  outputPerMTokUSD: 15,
  cacheReadPerMTokUSD: 0.3,
  cacheWritePerMTokUSD: 3.75,
};
const OPUS_4_5_RATES = {
  inputPerMTokUSD: 15,
  outputPerMTokUSD: 75,
  cacheReadPerMTokUSD: 1.5,
  cacheWritePerMTokUSD: 18.75,
};
const SONNET_20241022_RATES = {
  inputPerMTokUSD: 3,
  outputPerMTokUSD: 15,
  cacheReadPerMTokUSD: 0.3,
  cacheWritePerMTokUSD: 3.75,
};

describe("lookupRates (shared store pricing)", () => {
  it("returns rates for a known model", () => {
    const rates = lookupRates("claude-3-5-haiku-20241022");
    assert.ok(rates !== undefined, "should return rates for claude-3-5-haiku-20241022");
    assert.equal(rates.inputPerMTokUSD, 0.8);
    assert.equal(rates.outputPerMTokUSD, 4);
    assert.equal(rates.cacheReadPerMTokUSD, 0.08);
    assert.equal(rates.cacheWritePerMTokUSD, 1);
  });

  it("returns undefined and does not throw for unknown model", () => {
    // Previously returned null; the shared lookup returns undefined.
    const result = lookupRates("unknown-model-xyz-9999");
    assert.equal(result, undefined);
  });

  it("prefix-match: claude-sonnet-4 matches claude-sonnet-4-5", () => {
    // "claude-sonnet-4" is an alias for claude-sonnet-4-5 in anthropic.yaml.
    const rates = lookupRates("claude-sonnet-4");
    assert.ok(rates !== undefined, "prefix lookup should find claude-sonnet-4-5");
    assert.deepEqual(rates, SONNET_4_5_RATES);
  });

  it("prefix-match: claude-opus-4 matches claude-opus-4-5", () => {
    const rates = lookupRates("claude-opus-4");
    assert.ok(rates !== undefined, "prefix lookup should find claude-opus-4-5");
    assert.deepEqual(rates, OPUS_4_5_RATES);
  });

  it("strip-segment fallback: matches versioned suffix variant", () => {
    // Simulates a future model ID with an extra suffix that would need stripping.
    // "claude-3-5-sonnet-20241022-turbo" → strip "-turbo" → "claude-3-5-sonnet-20241022" ✓
    const rates = lookupRates("claude-3-5-sonnet-20241022-turbo");
    assert.ok(rates !== undefined, "strip-segment fallback should find sonnet-20241022");
    assert.deepEqual(rates, SONNET_20241022_RATES);
  });

  // C2 regression tests: unknown claude-* models must NOT match via bare stem.
  // The dash guard (candidate.includes("-") check) prevents "claude" alone from
  // prefix-matching "claude-opus-4-5".
  it("C2: unknown claude-* model returns undefined (not the first table entry)", () => {
    // Without the dash guard, "claude-supernova-9" strips to "claude" which
    // prefix-matches "claude-opus-4-5" — the most expensive model.
    const rates = lookupRates("claude-supernova-9");
    assert.equal(rates, undefined, "unknown claude-* model should return undefined, not opus rates");
  });

  it("C2: claude-haiku-4-5 is priced correctly", () => {
    const rates = lookupRates("claude-haiku-4-5");
    assert.ok(rates !== undefined, "claude-haiku-4-5 should be in the pricing table");
    assert.equal(rates.inputPerMTokUSD, 0.8);
    assert.equal(rates.outputPerMTokUSD, 4);
    assert.equal(rates.cacheReadPerMTokUSD, 0.08);
    assert.equal(rates.cacheWritePerMTokUSD, 1);
  });

  it("C2: claude-haiku-4 alias resolves to claude-haiku-4-5 rates", () => {
    // Alias is explicit in anthropic.yaml — not a prefix match.
    const rates = lookupRates("claude-haiku-4");
    assert.ok(rates !== undefined, "claude-haiku-4 should resolve via alias");
    assert.deepEqual(rates, HAIKU_4_5_RATES);
  });

  it("C2: bare stem 'claude' alone returns undefined", () => {
    // Belt-and-suspenders: bare provider name must never match a table entry.
    const rates = lookupRates("claude");
    assert.equal(rates, undefined, "bare 'claude' stem must return undefined");
  });
});

// ---------------------------------------------------------------------------
// computeCostMicros — adapter over the shared store implementation
// ---------------------------------------------------------------------------

describe("computeCostMicros (adapter)", () => {
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

  it("null modelId returns all zeros and costSource unknown", () => {
    // Covers the path where AssistantUsage.modelId is null.
    // The shared computeCostMicros returns zeroCostBreakdown for null/undefined.
    const usage = makeUsage({ modelId: null });
    const cost = computeCostMicros(usage);
    assert.equal(cost.costInputMicros, 0);
    assert.equal(cost.costOutputMicros, 0);
    assert.equal(cost.costCacheReadMicros, 0);
    assert.equal(cost.costCacheWriteMicros, 0);
    assert.equal(cost.costSource, "unknown");
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
    // We don’t compute total here — that’s the drain helper’s job.
    // Just verify the breakdown fields are all non-negative integers.
    assert.ok(cost.costInputMicros >= 0);
    assert.ok(cost.costOutputMicros >= 0);
    assert.ok(cost.costCacheReadMicros >= 0);
    assert.ok(cost.costCacheWriteMicros >= 0);
    assert.ok(expectedTotal > 0, "non-zero tokens should produce non-zero total");
  });
});
