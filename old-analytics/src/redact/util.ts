/**
 * util.ts — Shared low-level utilities for the redaction layer.
 *
 * All exports are pure functions with no side effects and no module-level
 * mutable state.  Safe to call from any context including the hot path.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Returns the lowercase hex SHA-256 digest of `text` (UTF-8 encoded).
 *
 * Used to correlate identical prompts across sessions without storing the
 * raw text (when `privacy.storePrompts !== "full"`).
 */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Byte length
// ---------------------------------------------------------------------------

/**
 * Returns the number of UTF-8 bytes needed to encode `text`.
 *
 * Faster than `Buffer.from(text).length` because `Buffer.byteLength` avoids
 * an allocation.  Used by the engine's 1 MiB oversize guard and by hooks
 * computing `input_bytes` / `output_bytes` for tool calls.
 */
export function byteLengthUtf8(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

// ---------------------------------------------------------------------------
// Text summarisation
// ---------------------------------------------------------------------------

const ELLIPSIS = "\u2026"; // …

/**
 * Truncates `text` to at most `maxLen` *code units* (UTF-16 chars), appending
 * `…(+N chars)` when truncated.  Does not split surrogate pairs — the slice
 * boundary is already UTF-16-safe.
 *
 * Callers (e.g. `applyPrivacyMode` in `"summary"` mode) MUST redact the text
 * before calling `summarizeText` so that a secret token straddling position
 * `maxLen` cannot be partially exposed.
 *
 * @param text    Source text (post-redaction).
 * @param maxLen  Maximum code-unit length of the returned prefix (default 200).
 */
export function summarizeText(text: string, maxLen = 200): string {
  if (text.length <= maxLen) return text;
  const remainder = text.length - maxLen;
  return `${text.slice(0, maxLen)}${ELLIPSIS}(+${remainder} chars)`;
}
