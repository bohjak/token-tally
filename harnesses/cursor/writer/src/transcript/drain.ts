/**
 * transcript/drain.ts — Best-effort token/model extraction from a Cursor transcript.
 *
 * Called by the stop / sessionEnd handlers to attempt to backfill token counts
 * and model attribution onto the placeholder llm_messages rows written by
 * afterAgentResponse.
 *
 * DESIGN NOTES
 * ─────────────
 * Cursor's transcript format is not publicly documented and is expected to
 * evolve. This module applies a set of heuristics that cover known-plausible
 * shapes (Claude/OpenAI/Google style usage objects). If none match, we return
 * an empty list — the placeholder rows remain at zero tokens and
 * cost_source = 'unknown', which is a valid/acceptable outcome.
 *
 * The `harnessMessageId` in returned records uses the canonical form:
 *   cursor:<conversation_id>:<generation_id>:assistant
 * which matches the placeholder IDs written by afterAgentResponse. The T8
 * stop handler upserts the placeholder rows using this key.
 *
 * IMPORTANT: this module never throws out of the hook path. Every error is
 * caught and logged, and an empty list is returned.
 */

import { readTranscriptEntries } from "./reader.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Normalised token/model data extracted from a single assistant turn.
 * Consumed by T8 (stop/sessionEnd handlers) to upsert placeholder LLM message rows.
 */
export interface BackfillRecord {
  /**
   * Harness message id — matches the placeholder written by afterAgentResponse.
   * Format: `cursor:<conversationId>:<generationId>:assistant` when IDs are
   * known; otherwise a fallback string that won't match any placeholder.
   */
  harnessMessageId: string;

  /** Model identifier as reported by the transcript, if present. */
  modelId?: string;

  /** Provider inferred from the model id (e.g. "anthropic", "openai"). */
  provider?: string;

  /** Input (prompt) tokens. 0 when unknown. */
  inputTokens: number;

  /** Output (completion) tokens. 0 when unknown. */
  outputTokens: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read the transcript at `transcriptPath` and return BackfillRecords for
 * every assistant turn that carries usable token data.
 *
 * @param transcriptPath        Value of `transcript_path` from the hook payload.
 * @param conversationId        `conversation_id` from the hook payload; used to
 *                              form canonical harness message ids.
 * @param knownHarnessMessageIds  Optional list of placeholder harness_message_id
 *                              values that were written by afterAgentResponse.
 *                              When provided, enables improved ID correlation:
 *                              if a transcript entry's derived ID doesn't match
 *                              any known placeholder but we can extract the
 *                              generation_id component from known IDs, we try
 *                              to match by that component. As a last resort,
 *                              positional correlation maps the i-th unmatched
 *                              transcript record to the i-th unmatched
 *                              placeholder (works for 1:1 cases).
 *                              Residual risk: multi-message mismatches where
 *                              positional order differs cannot be resolved
 *                              without additional harness-provided correlation.
 * @returns                     Array of records (may be empty). Never throws.
 */
export async function drainTranscript(
  transcriptPath: string,
  conversationId: string,
  knownHarnessMessageIds?: string[],
): Promise<BackfillRecord[]> {
  let entries: unknown[];
  try {
    entries = await readTranscriptEntries(transcriptPath);
  } catch (err) {
    // readTranscriptEntries should not throw, but be defensive.
    console.warn("[cursor-writer] transcript drain: unexpected error reading transcript:", err);
    return [];
  }

  // Build a lookup from the generation_id component of known placeholder IDs.
  // Format: "cursor:<conversationId>:<generationId>:assistant"
  // This lets us remap a transcript entry's `id` field to the correct
  // placeholder when the entry uses `id` == generation_id (common case) but
  // the field name differs.
  const knownGenIdToPlaceholderId = new Map<string, string>();
  for (const knownId of knownHarnessMessageIds ?? []) {
    // Split on ":" but only if it's the canonical cursor:cid:gid:assistant form.
    const parts = knownId.split(":");
    if (parts.length === 4 && parts[0] === "cursor" && parts[3] === "assistant") {
      // parts[2] is the generation_id component.
      knownGenIdToPlaceholderId.set(parts[2]!, knownId);
    }
  }

  const records: BackfillRecord[] = [];
  // Track which known placeholder IDs have already been matched, for positional
  // fallback when direct ID correlation fails.
  const matchedKnownIds = new Set<string>();

  for (const entry of entries) {
    try {
      const record = extractRecord(entry, conversationId, knownGenIdToPlaceholderId, matchedKnownIds);
      if (record !== null) {
        records.push(record);
        matchedKnownIds.add(record.harnessMessageId);
      }
    } catch (err) {
      // Single-entry parse failures should not abort the whole drain.
      console.warn("[cursor-writer] transcript drain: error processing entry:", err);
    }
  }

  // ── Positional fallback ───────────────────────────────────────────────────
  // If some transcript records used a derived ID that didn't match any known
  // placeholder, and there are unmatched placeholder IDs left, attempt to
  // correlate by position: the i-th unmatched transcript record maps to the
  // i-th unmatched placeholder ID. This handles the case where a transcript's
  // `id` field is completely independent of the hook payload's `generation_id`
  // (e.g. OpenAI-format wrappers with separate message IDs).
  //
  // Residual risk: when counts differ or ordering is not preserved, this can
  // still mismatch. At minimum, it avoids *both* a zero-token unknown
  // placeholder and a token row surviving for the same logical message in
  // the 1:1 single-message-per-turn case.
  if (knownHarnessMessageIds !== undefined && knownHarnessMessageIds.length > 0) {
    const unmatchedKnown = knownHarnessMessageIds.filter((id) => !matchedKnownIds.has(id));
    const unmatchedRecords = records.filter((r) => !knownHarnessMessageIds.includes(r.harnessMessageId));

    if (unmatchedKnown.length > 0 && unmatchedRecords.length > 0) {
      // Remap unmatched records to known placeholder IDs positionally.
      const remapCount = Math.min(unmatchedKnown.length, unmatchedRecords.length);
      for (let i = 0; i < remapCount; i++) {
        const record = unmatchedRecords[i]!;
        const knownId = unmatchedKnown[i]!;
        record.harnessMessageId = knownId;
      }
      if (unmatchedRecords.length > unmatchedKnown.length) {
        // More transcript records than known placeholders — the extras are new
        // records not written as placeholders (e.g. from sub-turns). Keep them.
        console.warn(
          `[cursor-writer] transcript drain: ${unmatchedRecords.length} unmatched transcript records, ` +
          `${unmatchedKnown.length} unmatched placeholders — some records may not update a placeholder.`,
        );
      }
    }
  }

  return records;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Try to extract a BackfillRecord from one transcript entry.
 * Returns null when the entry is not an assistant turn or has no token data.
 *
 * @param knownGenIdToPlaceholderId  Map from known generation_id values to their
 *                                   full placeholder harnessMessageId. Used to
 *                                   remap a transcript entry's `id` field to the
 *                                   correct placeholder when `id` == generation_id.
 * @param matchedKnownIds            Set of already-matched known IDs; updated by
 *                                   the caller after each successful match.
 */
function extractRecord(
  entry: unknown,
  conversationId: string,
  knownGenIdToPlaceholderId?: Map<string, string>,
  _matchedKnownIds?: Set<string>,
): BackfillRecord | null {
  if (entry === null || typeof entry !== "object") return null;

  const e = entry as Record<string, unknown>;

  // ── Require an assistant/model role ───────────────────────────────────────
  // Support both "role" and "type" conventions used by various API wrappers.
  const isAssistant =
    e["role"] === "assistant" ||
    e["role"] === "model" || // Google Gemini convention
    e["type"] === "assistant";

  if (!isAssistant) return null;

  // ── Derive a generation id to form the harness message id ─────────────────
  // We look for `generation_id` first (Cursor's own field), then `id` (many
  // LLM wrappers use this for message identity), then `uuid` (Claude Code /
  // ToTally-internal JSONL transcripts use this field).
  const generationId =
    typeof e["generation_id"] === "string" && e["generation_id"] !== ""
      ? e["generation_id"]
      : typeof e["id"] === "string" && e["id"] !== ""
        ? e["id"]
        : typeof e["uuid"] === "string" && e["uuid"] !== ""
          ? e["uuid"]
          : null;

  if (generationId === null) {
    // Cannot form a stable harness message id — skip this entry.
    return null;
  }

  // Canonical form matching afterAgentResponse's placeholder id.
  // If the entry used a fallback field (id/uuid instead of generation_id),
  // check if that value appears as the generation_id component in any known
  // placeholder. When it matches, use the known placeholder ID directly so
  // the upsert updates the existing row rather than inserting a sibling.
  let harnessMessageId = `cursor:${conversationId}:${generationId}:assistant`;
  if (knownGenIdToPlaceholderId !== undefined) {
    const knownId = knownGenIdToPlaceholderId.get(generationId);
    if (knownId !== undefined) {
      harnessMessageId = knownId;
    }
  }

  // ── Extract token usage ────────────────────────────────────────────────────
  const usage = extractUsage(e);

  // Skip entries with no token data — they add nothing beyond the placeholder.
  if (usage === null || (usage.inputTokens === 0 && usage.outputTokens === 0)) {
    return null;
  }

  // ── Extract model / provider ──────────────────────────────────────────────
  const modelId = extractModelId(e);

  return {
    harnessMessageId,
    modelId: modelId ?? undefined,
    provider: modelId !== null ? inferProvider(modelId) ?? undefined : undefined,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
}

/**
 * Extract token usage from an entry. Tries multiple schema conventions:
 *   - Anthropic/OpenAI: `{ usage: { input_tokens, output_tokens } }`
 *   - OpenAI legacy:    `{ usage: { prompt_tokens, completion_tokens } }`
 *   - Google Gemini:    `{ usage_metadata: { prompt_token_count, candidates_token_count } }`
 *   - Nested message:   `{ message: { usage: { ... } } }`
 *   - Flat:             `{ input_tokens, output_tokens }` or `{ inputTokens, outputTokens }`
 *
 * Returns null if no usage data is found.
 */
function extractUsage(
  e: Record<string, unknown>,
): { inputTokens: number; outputTokens: number } | null {
  // Anthropic / OpenAI nested usage object
  if (e["usage"] !== null && typeof e["usage"] === "object") {
    const u = e["usage"] as Record<string, unknown>;
    const input = toInt(u["input_tokens"] ?? u["prompt_tokens"]);
    const output = toInt(u["output_tokens"] ?? u["completion_tokens"]);
    if (input > 0 || output > 0) return { inputTokens: input, outputTokens: output };
  }

  // Google Gemini usage_metadata
  if (e["usage_metadata"] !== null && typeof e["usage_metadata"] === "object") {
    const u = e["usage_metadata"] as Record<string, unknown>;
    const input = toInt(u["prompt_token_count"]);
    const output = toInt(u["candidates_token_count"]);
    if (input > 0 || output > 0) return { inputTokens: input, outputTokens: output };
  }

  // Nested { message: { usage: { ... } } } (Claude Code JSONL transcript style)
  if (e["message"] !== null && typeof e["message"] === "object") {
    const inner = extractUsage(e["message"] as Record<string, unknown>);
    if (inner !== null) return inner;
  }

  // Flat token fields directly on the entry
  const flatInput = toInt(
    e["input_tokens"] ?? e["inputTokens"] ?? e["prompt_tokens"],
  );
  const flatOutput = toInt(
    e["output_tokens"] ?? e["outputTokens"] ?? e["completion_tokens"],
  );
  if (flatInput > 0 || flatOutput > 0) {
    return { inputTokens: flatInput, outputTokens: flatOutput };
  }

  return null;
}

/**
 * Extract the model identifier from an entry, trying common field names.
 */
function extractModelId(e: Record<string, unknown>): string | null {
  for (const field of ["model", "model_id", "modelId", "model_name"]) {
    const val = e[field];
    if (typeof val === "string" && val.trim() !== "") return val.trim();
  }

  // Nested message block may carry the model
  if (e["message"] !== null && typeof e["message"] === "object") {
    const msg = e["message"] as Record<string, unknown>;
    for (const field of ["model", "model_id", "modelId"]) {
      const val = msg[field];
      if (typeof val === "string" && val.trim() !== "") return val.trim();
    }
  }

  return null;
}

/**
 * Infer the provider name from a model id prefix.
 * Matches the same heuristic used in after-agent-response.ts.
 */
function inferProvider(modelId: string): string | null {
  if (modelId.startsWith("claude-")) return "anthropic";
  if (
    modelId.startsWith("gpt-") ||
    modelId.startsWith("o1-") ||
    modelId.startsWith("o3-") ||
    modelId.startsWith("o4-")
  )
    return "openai";
  if (modelId.startsWith("gemini-")) return "google";
  if (modelId.startsWith("grok-")) return "xai";
  return null;
}

/**
 * Safely convert an unknown value to a non-negative integer.
 * Returns 0 for anything non-numeric, NaN, infinite, or negative.
 */
function toInt(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.floor(v));
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.max(0, Math.floor(n));
  }
  return 0;
}
