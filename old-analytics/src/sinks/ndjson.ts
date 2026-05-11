/**
 * ndjson.ts — NdjsonSink: per-UTC-day NDJSON append log.
 *
 * ## Purpose
 * Durable, schema-flexible source of truth.  One file per UTC day at:
 *   `<rawLogDir>/events-YYYY-MM-DD.ndjson`
 * Lets us replay events through a future OTLP exporter or rebuild SQLite
 * if the schema changes.
 *
 * ## Privacy pipeline (applied synchronously before each write)
 *
 * 1. **`prompt` events** — strip or preserve `text` based on `storePrompts`:
 *    - `"none"` / `"hashed"`: remove `text`; `text_len` and `text_sha256`
 *      (pre-populated by the hook) are preserved.
 *    - `"full"`: run `applyRules(text, promptRules)` to scrub secrets, then
 *      `walkAndRedact` all other string fields.
 *
 * 2. **`tool_call` / `file_touched` events** — `storeToolArgs` /
 *    `storeToolOutputs` are primarily enforced at the hook level (T10):
 *    hooks compute `input_bytes` / `output_bytes` and omit raw text when
 *    `"size-only"` / `"none"` is configured.  The NdjsonSink applies
 *    `walkAndRedact` on whatever typed fields are present as a safety net.
 *
 * 3. **All other events** — `walkAndRedact` with universal rules.
 *
 * 4. **Accumulated `redacted` hit counter** — merged back onto every event
 *    so downstream tools can see which rules fired.
 *
 * ## Rule contexts
 * `DEFAULT_RULES` includes rules tagged `contexts: ["prompts", "bash-args"]`
 * (currently `env-assignment`).  These are EXCLUDED from `outputRules` used
 * for tool events, where false-positive rates are too high.  They ARE
 * included in `promptRules`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type {
  AnalyticsConfig,
  AnalyticsEvent,
  AnalyticsSink,
  PromptEvent,
} from "./types.ts";
import {
  DEFAULT_RULES,
  applyRules,
  walkAndRedact,
  compileUserPatterns,
  mergeHits,
} from "../redact/index.ts";
import type { RedactRule, RedactionHits } from "../redact/index.ts";

// ---------------------------------------------------------------------------
// Module-level constants
// ---------------------------------------------------------------------------

/**
 * Subset of DEFAULT_RULES that carry no `contexts` restriction — safe to use
 * on all event kinds including raw tool outputs.
 * Rules with `contexts: ["prompts", "bash-args"]` (e.g. `env-assignment`) are
 * excluded here; they are only included in `promptRules`.
 */
const UNIVERSAL_DEFAULT_RULES: RedactRule[] = DEFAULT_RULES.filter(
  (r) => !r.contexts || r.contexts.length === 0,
);

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Expand a leading `~` to the OS home directory.
 * Only handles `~/path` and the bare `~`; does not expand `~username`.
 */
function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * Merge `hits` into `event.redacted`.
 * Returns the event unchanged (same reference) when `hits` is empty;
 * otherwise returns a new object with the merged counter so the original
 * event is not mutated.
 */
function attachHits<T extends { redacted?: RedactionHits }>(
  event: T,
  hits: RedactionHits,
): T {
  if (Object.keys(hits).length === 0) return event;
  return {
    ...event,
    redacted: mergeHits(event.redacted ?? {}, hits),
  };
}

// ---------------------------------------------------------------------------
// NdjsonSink
// ---------------------------------------------------------------------------

export class NdjsonSink implements AnalyticsSink {
  private rawLogDir = "";
  private config!: AnalyticsConfig;

  /**
   * All DEFAULT_RULES + user patterns.  Used for prompt events where
   * high-recall rules like `env-assignment` are appropriate.
   */
  private promptRules: RedactRule[] = [];

  /**
   * UNIVERSAL_DEFAULT_RULES + user patterns.  Used for tool events and
   * all other non-prompt events where false-positive rates for some rules
   * are too high.
   */
  private outputRules: RedactRule[] = [];

  async init(config: AnalyticsConfig): Promise<void> {
    this.config = config;
    this.rawLogDir = expandHome(config.local.rawLogDir);
    fs.mkdirSync(this.rawLogDir, { recursive: true });

    const userRules = compileUserPatterns(config.privacy.redactPatterns);
    this.promptRules = [...DEFAULT_RULES, ...userRules];
    this.outputRules = [...UNIVERSAL_DEFAULT_RULES, ...userRules];
  }

  /**
   * Serialize `event` to one JSON line (with trailing `\n`) and append it
   * to today's NDJSON file.
   *
   * The output filename is computed on every call so day rollover is
   * handled transparently without a background timer.
   *
   * Never throws — any error is caught and logged via `console.warn`.
   */
  write(event: AnalyticsEvent): void {
    try {
      const sanitized = this.sanitize(event);
      const line = JSON.stringify(sanitized) + "\n";
      fs.appendFileSync(this.todayFilePath(), line, "utf8");
    } catch (err) {
      console.warn("[analytics:NdjsonSink] write error:", err);
    }
  }

  /** No-op: `fs.appendFileSync` writes are already durable. */
  async flush(): Promise<void> {}

  /** No-op: no persistent file handle to release. */
  async close(): Promise<void> {}

  // ──────────────────────────────────────────────────────────────────────────
  // Private
  // ──────────────────────────────────────────────────────────────────────────

  /** Returns the absolute path for today's UTC-dated NDJSON file. */
  private todayFilePath(): string {
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(now.getUTCDate()).padStart(2, "0");
    return path.join(this.rawLogDir, `events-${yyyy}-${mm}-${dd}.ndjson`);
  }

  /** Dispatch to the appropriate privacy-aware sanitizer by event kind. */
  private sanitize(event: AnalyticsEvent): unknown {
    switch (event.kind) {
      case "prompt":
        return this.sanitizePrompt(event);

      case "tool_call":
      case "file_touched":
        // Tool events: universal rules only (exclude high-recall env-assignment).
        return this.walkRedactEvent(event, this.outputRules);

      default:
        // All other events (session, turn, llm_message, git, etc.):
        // apply universal rules as a safety net.
        return this.walkRedactEvent(event, this.outputRules);
    }
  }

  /**
   * `walkAndRedact` all string fields of an event and attach accumulated hits.
   * Preserves and merges any pre-existing `redacted` counter on the event.
   */
  private walkRedactEvent(event: AnalyticsEvent, rules: RedactRule[]): unknown {
    const { value, hits } = walkAndRedact(event, rules);
    return attachHits(value as { redacted?: RedactionHits }, hits);
  }

  /**
   * Privacy-aware serialization for `prompt` events.
   *
   * The hook (T7) pre-populates `text_len` and `text_sha256` from the
   * original text before emitting the event.  Those fields are always
   * preserved regardless of privacy mode.  `sha256` is the hash of the
   * original text (not the redacted version) — this is intentional so
   * identical prompts can be correlated across sessions even without
   * storing the text.
   *
   * `storePrompts`:
   *   - `"none"` | `"hashed"`: drop `text`; walkAndRedact remaining fields.
   *   - `"full"`:              redact `text` with promptRules; walkAndRedact
   *                            all other string fields with promptRules.
   */
  private sanitizePrompt(event: PromptEvent): unknown {
    const mode = this.config.privacy.storePrompts;

    if (mode !== "full") {
      // Drop `text` (and any pre-existing `redacted` counter that referenced
      // it), then walkAndRedact the remaining fields.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { text: _text, redacted: _prev, ...rest } = event;
      const { value, hits } = walkAndRedact(rest, this.promptRules);
      return attachHits(value as { redacted?: RedactionHits }, hits);
    }

    // "full" mode ────────────────────────────────────────────────────────────
    // Step 1: redact the `text` field using prompt-context rules (includes
    //         high-recall env-assignment).
    let allHits: RedactionHits = event.redacted ?? {};
    let sanitizedText: string | undefined;

    if (event.text !== undefined) {
      const { text: redactedText, hits } = applyRules(event.text, this.promptRules);
      sanitizedText = redactedText;
      allHits = mergeHits(allHits, hits);
    }

    // Step 2: walkAndRedact all remaining string fields (source, command,
    //         slash_kind, etc.) with the same promptRules set.
    //         We extract `text` so it isn't double-processed.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { text: _t, redacted: _r, ...rest } = event;
    const { value: redactedRest, hits: restHits } = walkAndRedact(rest, this.promptRules);
    allHits = mergeHits(allHits, restHits);

    // Step 3: reconstruct the event with the redacted `text` re-attached.
    const result: Record<string, unknown> = { ...(redactedRest as object) };
    if (sanitizedText !== undefined) {
      result["text"] = sanitizedText;
    }

    return attachHits(result as { redacted?: RedactionHits }, allHits);
  }
}
