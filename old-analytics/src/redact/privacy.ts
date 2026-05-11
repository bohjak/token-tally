/**
 * privacy.ts — Per-field privacy mode enforcement.
 *
 * ## Privacy modes
 *
 * `PrivacyMode` controls how a text field is stored:
 *
 *   "none"    — Drop text entirely.  Store only `length` and `sha256`.
 *               Use for: prompts when `storePrompts = "none"`.
 *
 *   "hashed"  — Same as "none" — no text stored.  The SHA-256 lets callers
 *               correlate identical prompts across sessions without seeing
 *               the content.  This is the default for `storePrompts`.
 *               Distinguished from "none" so call sites can assert intent.
 *
 *   "summary" — Store the first `summaryMaxLen` chars (default 200) of the
 *               *redacted* text, plus `length` and `sha256`.
 *               Use for: tool args when `storeToolArgs = "summary"`.
 *
 *   "full"    — Store the full *redacted* text plus `length` and `sha256`.
 *               Use for: prompts when `storePrompts = "full"`.
 *
 * ## "size-only" is NOT a PrivacyMode
 *
 * PLAN.md specifies `storeToolOutputs: "size-only"` which means "record byte
 * count only — not even a hash".  This is handled at the caller level
 * (NdjsonSink, T5) by computing `byteLengthUtf8(content)` and not calling
 * `applyPrivacyMode` at all.  This keeps `PrivacyMode` clean and prevents
 * callers from passing "size-only" to a function designed for text storage.
 * Coordination confirmed with T2 (`sinks/types.ts`) which keeps "size-only"
 * as a distinct `AnalyticsConfig.privacy.storeToolOutputs` literal.
 *
 * ## Ordering guarantee
 *
 * `applyPrivacyMode` ALWAYS redacts before truncating.  This ensures that a
 * secret token straddling the truncation boundary cannot be partially exposed.
 * (Redaction replaces a variable-length match with a fixed-length placeholder,
 * so the truncation point in the redacted text does not correspond to the same
 * position in the original text.)
 *
 * All exports are pure — no I/O, no module-level state.
 */

import { sha256, summarizeText } from "./util.ts";
import { applyRules } from "./engine.ts";
import type { RedactionHits } from "./engine.ts";
import type { RedactRule } from "./rules.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The four privacy modes for text fields.  See module header for semantics.
 */
export type PrivacyMode = "none" | "hashed" | "summary" | "full";

/**
 * The tagged-union result of `applyPrivacyMode`.
 *
 * - `mode: "none"` and `mode: "hashed"`: only `length` and `sha256`.
 *   `sha256` is always the hash of the *original* (pre-redaction) text
 *   for correlation purposes.  This is intentional: hashing the redacted
 *   text would make the hash depend on the rule set version.
 *
 * - `mode: "summary"` and `mode: "full"`: additionally include `text`
 *   (post-redaction, possibly truncated) and `redacted` (hit counts).
 *   `sha256` is still the hash of the original text.
 */
export type StoredText =
  | { mode: "none";    length: number; sha256: string }
  | { mode: "hashed";  length: number; sha256: string }
  | { mode: "summary"; length: number; sha256: string; text: string; redacted: RedactionHits }
  | { mode: "full";    length: number; sha256: string; text: string; redacted: RedactionHits };

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Apply a privacy mode to a text value.
 *
 * Order of operations (guaranteed):
 *   1. Record `length` (original) and `sha256` (original).
 *   2. Redact: run `applyRules(text, rules)` → get post-redaction text + hits.
 *   3. Truncate (only for "summary"): call `summarizeText(redacted, maxLen)`.
 *   4. Build and return the appropriate `StoredText` variant.
 *
 * For `"none"` and `"hashed"` modes no redaction is performed (text is
 * discarded either way, so redacting is wasted CPU).
 *
 * @param text           The raw input text (will not be mutated).
 * @param mode           Target privacy mode.
 * @param rules          Redaction rules to apply for "summary" / "full" modes.
 * @param opts.summaryMaxLen  Maximum char length for the "summary" prefix (default 200).
 */
export function applyPrivacyMode(
  text: string,
  mode: PrivacyMode,
  rules: RedactRule[],
  opts?: { summaryMaxLen?: number },
): StoredText {
  const length = text.length;
  const hash = sha256(text); // always hash the original

  if (mode === "none") {
    return { mode: "none", length, sha256: hash };
  }

  if (mode === "hashed") {
    return { mode: "hashed", length, sha256: hash };
  }

  // For "summary" and "full": redact first, then (optionally) truncate.
  const { text: redactedText, hits } = applyRules(text, rules);

  if (mode === "full") {
    return { mode: "full", length, sha256: hash, text: redactedText, redacted: hits };
  }

  // mode === "summary"
  const maxLen = opts?.summaryMaxLen ?? 200;
  const summary = summarizeText(redactedText, maxLen);
  return { mode: "summary", length, sha256: hash, text: summary, redacted: hits };
}
