/**
 * pricing/compute.ts — Compute integer micro-dollar costs from token counts.
 *
 * Delegates to @token-tally/store/pricing so the single rates.json table and
 * lookup algorithm are used everywhere. The function signature is preserved so
 * transcript/drain.ts does not need to change.
 *
 * Costs are stored as integer micro-dollars (1 USD = 1_000_000 micros) to
 * avoid IEEE-754 drift in aggregations. The store CHECK constraint enforces:
 *   cost_total_micros = cost_input_micros + cost_output_micros
 *                     + cost_cache_read_micros + cost_cache_write_micros
 * so callers must sum the four breakdown fields when writing to the store.
 */

import type { AssistantUsage } from "../transcript/extract.js";
import {
  computeCostMicros as storeComputeCostMicros,
} from "@token-tally/store";

// Re-export the shared type so drain.ts and other callers can import it from
// this module path without changing their import statements.
export type { CostBreakdown } from "@token-tally/store";

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
export function computeCostMicros(usage: AssistantUsage): ReturnType<typeof storeComputeCostMicros> {
  // The store's computeCostMicros accepts modelId: string | null | undefined,
  // so passing usage.modelId directly (which is string | null) is safe.
  return storeComputeCostMicros({
    modelId: usage.modelId,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
  });
}
