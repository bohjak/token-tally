/**
 * transcript/extract.ts — Extract assistant usage data from a raw transcript entry.
 *
 * Returns null for any entry that is not an assistant message or lacks the
 * uuid required for idempotent store writes.
 */

export interface AssistantUsage {
  /** Transcript entry UUID — used as harness_message_id idempotency key. */
  harnessMessageId: string;
  /** Model identifier, e.g. "claude-opus-4-5". Null when absent. */
  modelId: string | null;
  /** Input (prompt) tokens. */
  inputTokens: number;
  /** Output (completion) tokens. */
  outputTokens: number;
  /** Cache read tokens (cache_read_input_tokens). */
  cacheReadTokens: number;
  /** Cache write tokens (cache_creation_input_tokens). */
  cacheWriteTokens: number;
  /**
   * Legacy costUSD field from older Claude Code versions.
   * Present only when the entry carries a pre-computed dollar cost.
   * Null otherwise — callers should fall back to pricing table computation.
   */
  legacyCostUSD: number | null;
  /** Unix milliseconds; falls back to Date.now() when the entry has no timestamp. */
  ts: number;
}

/**
 * Extract assistant LLM usage from a raw transcript entry.
 *
 * Returns null when:
 * - entry is not an object
 * - entry is neither type=assistant nor role=assistant
 * - entry has no uuid (can't form an idempotent message ID)
 */
export function extractAssistantUsage(entry: unknown): AssistantUsage | null {
  if (entry === null || typeof entry !== "object") return null;

  const e = entry as Record<string, unknown>;

  // Claude Code uses both conventions across versions.
  const isAssistant = e["type"] === "assistant" || e["role"] === "assistant";
  if (!isAssistant) return null;

  // uuid is required for idempotent upserts.
  const uuid = e["uuid"];
  if (!uuid || typeof uuid !== "string" || uuid.trim() === "") return null;

  // Parse timestamp: ISO string, Unix seconds, or Unix ms.
  let ts = Date.now();
  const rawTs = e["timestamp"];
  if (rawTs !== undefined && rawTs !== null) {
    const parsed = new Date(rawTs as string | number).getTime();
    if (!Number.isNaN(parsed)) {
      ts = parsed;
    }
  }

  // Navigate the message block defensively.
  const msg =
    e["message"] !== null && typeof e["message"] === "object"
      ? (e["message"] as Record<string, unknown>)
      : null;

  const modelId =
    msg !== null && typeof msg["model"] === "string" && msg["model"].trim() !== ""
      ? msg["model"]
      : null;

  const usage =
    msg !== null && msg["usage"] !== null && typeof msg["usage"] === "object"
      ? (msg["usage"] as Record<string, unknown>)
      : null;

  const toInt = (v: unknown): number => {
    if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.floor(v));
    return 0;
  };

  const inputTokens = toInt(usage?.["input_tokens"]);
  const outputTokens = toInt(usage?.["output_tokens"]);
  const cacheReadTokens = toInt(usage?.["cache_read_input_tokens"]);
  const cacheWriteTokens = toInt(usage?.["cache_creation_input_tokens"]);

  // Legacy costUSD field.
  const legacyCostUSD =
    typeof e["costUSD"] === "number" && Number.isFinite(e["costUSD"])
      ? e["costUSD"]
      : null;

  return {
    harnessMessageId: uuid,
    modelId,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    legacyCostUSD,
    ts,
  };
}
