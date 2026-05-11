/**
 * transcript/types.ts — Defensive shape definitions for Claude Code JSONL transcripts.
 *
 * Claude Code's transcript schema is not a stable public contract. Every field
 * is optional or `unknown` to survive schema evolution without hard failures.
 */

export interface TranscriptUsage {
  input_tokens?: number;
  output_tokens?: number;
  /** Tokens written to the prompt cache (cache_write in ToTally terms). */
  cache_creation_input_tokens?: number;
  /** Tokens served from the prompt cache (cache_read in ToTally terms). */
  cache_read_input_tokens?: number;
}

export interface TranscriptEntry {
  /** Entry type — e.g. "assistant", "user", "system". */
  type?: string;
  /** Alternative convention for some CC versions: "assistant", "user". */
  role?: string;
  /** Stable entry UUID — used as the harness_message_id idempotency key. */
  uuid?: string;
  /** ISO 8601 string or Unix seconds/ms. */
  timestamp?: string | number;
  /** Legacy cost field present in older Claude Code versions. */
  costUSD?: number;
  message?: {
    model?: string;
    usage?: TranscriptUsage;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}
