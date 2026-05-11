/**
 * pricing/compute.ts — Compute integer micro-dollar costs from token counts.
 *
 * Costs are stored as integer micro-dollars (1 USD = 1_000_000 micros) to
 * avoid IEEE-754 drift in aggregations. The store CHECK constraint enforces:
 *   cost_total_micros = cost_input_micros + cost_output_micros
 *                     + cost_cache_read_micros + cost_cache_write_micros
 * so callers must sum the four breakdown fields when writing to the store.
 */

import type { AssistantUsage } from "../transcript/extract.js";
import { lookupModelRates } from "./models.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CostBreakdown {
  costInputMicros: number;
  costOutputMicros: number;
  costCacheReadMicros: number;
  costCacheWriteMicros: number;
  /**
   * `"writer"` when rates were found and applied.
   * `"unknown"` when the model is not in the pricing table — all cost fields
   * are 0 and must not be summed into headline totals without a caveat.
   */
  costSource: "writer" | "unknown";
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

/**
 * Convert a token count to integer micro-dollars given a rate in USD/MTok.
 *
 * Formula: round(tokens × (rateUSD / 1_000_000) × 1_000_000)
 *        = round(tokens × rateUSD)
 */
function tokensToMicros(tokens: number, ratePerMTokUSD: number): number {
  return Math.round(tokens * ratePerMTokUSD);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the list-price cost breakdown for a single LLM usage record.
 *
 * Returns `costSource: "unknown"` with all zeros when the model is not in the
 * pricing table. This signals to callers that the row should be stored with
 * `cost_source = 'unknown'` so readers can exclude it from headline totals.
 *
 * The `legacyCostUSD` field on `usage` is intentionally ignored here — the
 * drain helper handles the legacy cost path separately before calling this
 * function (it only calls `computeCostMicros` for the non-legacy path).
 */
export function computeCostMicros(usage: AssistantUsage): CostBreakdown {
  const rates = lookupModelRates(usage.modelId);

  if (rates === null) {
    return {
      costInputMicros: 0,
      costOutputMicros: 0,
      costCacheReadMicros: 0,
      costCacheWriteMicros: 0,
      costSource: "unknown",
    };
  }

  return {
    costInputMicros: tokensToMicros(usage.inputTokens, rates.inputPerMTokUSD),
    costOutputMicros: tokensToMicros(usage.outputTokens, rates.outputPerMTokUSD),
    costCacheReadMicros: tokensToMicros(
      usage.cacheReadTokens,
      rates.cacheReadPerMTokUSD,
    ),
    costCacheWriteMicros: tokensToMicros(
      usage.cacheWriteTokens,
      rates.cacheWritePerMTokUSD,
    ),
    costSource: "writer",
  };
}
