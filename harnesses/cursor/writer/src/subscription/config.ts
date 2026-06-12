/**
 * subscription/config.ts — Cursor subscription config loader.
 *
 * Delegates to @token-tally/harness-kit's unified config loader.
 * Kept as a thin adapter so hook handler imports stay unchanged.
 */

import { loadSubscriptionConfig, loadCaptureRawFlag as kitLoadCaptureRaw } from "@token-tally/harness-kit";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CursorSubConfig = {
  /** Plan slug, e.g. "cursor-pro". */
  plan: string;
  /** Flat monthly fee in USD. */
  fixedCostUSD: number;
  /** Day-of-month the billing period starts (1–31). */
  startDay: number;
  /**
   * When true, the preCompact handler emits a raw_event with context usage.
   * Off by default.
   */
  captureRaw: boolean;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load the Cursor subscription config from config.json.
 *
 * Returns null when:
 * - The config file does not exist.
 * - The `harnesses.cursor.subscription` key is absent.
 * - The file contains malformed JSON.
 */
export async function loadCursorSubscriptionConfig(): Promise<CursorSubConfig | null> {
  const sub = await loadSubscriptionConfig("cursor", "[cursor-writer]");
  if (sub === null) return null;

  // captureRaw is independent of the subscription plan; load it separately.
  const captureRaw = await kitLoadCaptureRaw("cursor");

  return { ...sub, captureRaw };
}

/**
 * Load only the captureRaw flag for the cursor harness.
 * Returns false when the config is absent or malformed.
 */
export async function loadCaptureRawFlag(): Promise<boolean> {
  return kitLoadCaptureRaw("cursor");
}
