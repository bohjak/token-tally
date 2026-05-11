/**
 * redact/index.ts — Public entrypoint for the redaction module.
 *
 * Every consumer (hooks, sinks, commands) MUST import from this file only.
 * Do not import directly from `rules.ts`, `engine.ts`, `privacy.ts`, or
 * `sensitive-paths.ts` — the internal module structure may change without
 * notice while this surface stays stable.
 *
 * T2 (`sinks/types.ts`) imports `RedactionHits` and `StoredText` via a
 * type-only import from this file:
 *   import type { RedactionHits, StoredText } from "../redact/index.js";
 */

// ── Types ─────────────────────────────────────────────────────────────────

export type { RedactRule }      from "./rules.ts";
export type { RedactionHits }   from "./engine.ts";
export type { PrivacyMode, StoredText } from "./privacy.ts";

// ── Rules ─────────────────────────────────────────────────────────────────

export { DEFAULT_RULES }        from "./rules.ts";

// ── Engine ────────────────────────────────────────────────────────────────

export {
  applyRules,
  walkAndRedact,
  compileUserPatterns,
  mergeHits,
}                               from "./engine.ts";

// ── Privacy modes ─────────────────────────────────────────────────────────

export { applyPrivacyMode }     from "./privacy.ts";

// ── Sensitive paths ───────────────────────────────────────────────────────

export { DEFAULT_SENSITIVE_PATTERNS, pathIsSensitive } from "./sensitive-paths.ts";

// ── Utilities ─────────────────────────────────────────────────────────────

export { sha256, byteLengthUtf8, summarizeText } from "./util.ts";
