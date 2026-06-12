/**
 * pricing/models.ts — Static Anthropic model pricing table.
 *
 * All rates are USD per one million tokens (MTok) at Anthropic list price.
 * This is deliberately a hard-coded table, not a runtime fetch, so the writer
 * works offline and produces reproducible cost values for a given build.
 *
 * When a model ships a price change, bump INTEGRATION_VERSION in version.ts
 * alongside updating this table so cost provenance traces correctly.
 *
 * Source: https://www.anthropic.com/pricing (as of 2026-05)
 */

export interface ModelRates {
  /** USD per million input tokens at list price. */
  inputPerMTokUSD: number;
  /** USD per million output tokens at list price. */
  outputPerMTokUSD: number;
  /** USD per million cache-read tokens at list price. */
  cacheReadPerMTokUSD: number;
  /** USD per million cache-write (creation) tokens at list price. */
  cacheWritePerMTokUSD: number;
}

// ---------------------------------------------------------------------------
// Pricing table
// ---------------------------------------------------------------------------

/**
 * Keyed by the canonical model ID string that Claude Code reports in the
 * transcript. Keys must be lowercase and match exactly what the harness emits.
 *
 * Order is insertion order — the prefix-match scan below will prefer the
 * first matching entry when multiple keys share a prefix.
 */
export const MODEL_RATES: Record<string, ModelRates> = {
  // Claude 4 family
  "claude-opus-4-5": {
    inputPerMTokUSD: 15,
    outputPerMTokUSD: 75,
    cacheReadPerMTokUSD: 1.5,
    cacheWritePerMTokUSD: 18.75,
  },
  "claude-sonnet-4-5": {
    inputPerMTokUSD: 3,
    outputPerMTokUSD: 15,
    cacheReadPerMTokUSD: 0.3,
    cacheWritePerMTokUSD: 3.75,
  },

  // Claude 4 Haiku
  "claude-haiku-4-5": {
    inputPerMTokUSD: 0.8,
    outputPerMTokUSD: 4,
    cacheReadPerMTokUSD: 0.08,
    cacheWritePerMTokUSD: 1,
  },

  // Claude 3.5 family
  "claude-3-5-sonnet-20241022": {
    inputPerMTokUSD: 3,
    outputPerMTokUSD: 15,
    cacheReadPerMTokUSD: 0.3,
    cacheWritePerMTokUSD: 3.75,
  },
  "claude-3-5-sonnet-20240620": {
    inputPerMTokUSD: 3,
    outputPerMTokUSD: 15,
    cacheReadPerMTokUSD: 0.3,
    cacheWritePerMTokUSD: 3.75,
  },
  "claude-3-5-haiku-20241022": {
    inputPerMTokUSD: 0.8,
    outputPerMTokUSD: 4,
    cacheReadPerMTokUSD: 0.08,
    cacheWritePerMTokUSD: 1,
  },

  // Claude 3 family
  "claude-3-opus-20240229": {
    inputPerMTokUSD: 15,
    outputPerMTokUSD: 75,
    cacheReadPerMTokUSD: 1.5,
    cacheWritePerMTokUSD: 18.75,
  },
  "claude-3-sonnet-20240229": {
    inputPerMTokUSD: 3,
    outputPerMTokUSD: 15,
    cacheReadPerMTokUSD: 0.3,
    cacheWritePerMTokUSD: 3.75,
  },
  "claude-3-haiku-20240307": {
    inputPerMTokUSD: 0.25,
    outputPerMTokUSD: 1.25,
    cacheReadPerMTokUSD: 0.03,
    cacheWritePerMTokUSD: 0.3,
  },
};

// ---------------------------------------------------------------------------
// Lookup with prefix-match fallback
// ---------------------------------------------------------------------------

/** Track model IDs we have already warned about (per-process, not persisted). */
const _warnedIds = new Set<string>();

/**
 * Look up pricing rates for a model ID.
 *
 * Resolution order:
 * 1. Exact match in MODEL_RATES.
 * 2. Prefix match: check if `modelId + "-"` is a prefix of any table key.
 *    This handles partial IDs like "claude-sonnet-4" matching "claude-sonnet-4-5".
 * 3. Repeatedly strip the last dash-segment from the lookup key and repeat
 *    steps 1–2 until the string is exhausted.
 *    This handles future versioned suffixes like "claude-3-5-haiku-20241022-turbo".
 * 4. Returns null and emits a one-time console.warn for the unknown model.
 */
export function lookupModelRates(modelId: string | null): ModelRates | null {
  if (modelId === null) return null;

  const tableKeys = Object.keys(MODEL_RATES);

  // Walk progressively shorter prefixes of the supplied ID.
  let candidate = modelId;
  while (candidate.length > 0) {
    // Step 1: exact match.
    if (Object.prototype.hasOwnProperty.call(MODEL_RATES, candidate)) {
      return MODEL_RATES[candidate]!;
    }

    // Step 2: prefix match — supplied candidate is a prefix of a table key.
    // Guard: only attempt prefix matching when the candidate contains at least
    // one dash, so bare provider stems like "claude" or "gpt" can never match
    // the first table entry and silently assign the wrong rates.
    if (candidate.includes("-")) {
      const prefixHit = tableKeys.find((k) => k.startsWith(candidate + "-"));
      if (prefixHit !== undefined) {
        return MODEL_RATES[prefixHit]!;
      }
    }

    // Step 3: strip the last dash-segment and retry.
    const lastDash = candidate.lastIndexOf("-");
    if (lastDash === -1) break;
    candidate = candidate.slice(0, lastDash);
  }

  // Unknown model — warn once per ID and return null so callers can mark
  // cost_source = "unknown" rather than silently storing zeros.
  if (!_warnedIds.has(modelId)) {
    _warnedIds.add(modelId);
    console.warn(
      `[claude-code-writer] Unknown model ID for pricing: "${modelId}". ` +
        `Reporting cost_source=unknown for messages from this model.`,
    );
  }
  return null;
}
