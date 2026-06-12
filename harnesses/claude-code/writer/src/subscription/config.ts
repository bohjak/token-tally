/**
 * subscription/config.ts — Claude Code subscription config loader.
 *
 * Delegates to @token-tally/harness-kit's unified config loader.
 * Kept as a thin adapter so hook handler imports stay unchanged.
 */

import { loadSubscriptionConfig } from "@token-tally/harness-kit";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Parsed subscription configuration for the claude-code harness.
 */
export type SubConfig = {
  /** Plan slug, e.g. "claude-pro", "claude-max-5x", "claude-max-20x". */
  plan: string;
  /** Flat monthly fee in USD. */
  fixedCostUSD: number;
  /** Day-of-month the billing period starts (1–31). */
  startDay: number;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load the Claude Code subscription config from config.json.
 *
 * Returns null when the config file is absent, the subscription key is missing,
 * or the file contains malformed JSON (a warning is logged).
 */
export async function loadClaudeCodeSubscriptionConfig(): Promise<SubConfig | null> {
  return loadSubscriptionConfig("claude-code", "[claude-code-writer]");
}
