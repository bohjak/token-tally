/**
 * Transformer for Pi session JSONL events → structured DB row shapes.
 *
 * Key design decisions (per plan rev 2):
 *   - Turn segmentation: new turn at each non-toolResult user message.
 *   - Zero-cost no-responseId messages get isZeroCostSkip=true; the importer
 *     counts them as zero_cost_skipped and does not write them.
 *   - Nonzero no-responseId messages get harnessMessageId = "<filePath>:noid:<eventId>".
 *   - Cost dollars → integer micros per component; total = sum of components
 *     (never an independent rounding of cost.total — floats drift differently).
 *   - costSource = "harness" only when costTotalMicros > 0.
 *   - No Date.now(): all IDs and timestamps come from event data.
 */

import type {
  ContentBlock,
  MessageEvent,
  MessageInner,
  PiSessionEvent,
  ToolCallBlock,
  TransformedMessage,
  TransformedSession,
  TransformedToolCall,
  TransformedTurn,
} from "./types";

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Converts a USD float amount to integer micros.
 * Uses Math.round to eliminate IEEE-754 drift.
 */
export function dollarToMicros(usd: number | undefined | null): number {
  if (usd == null || !isFinite(usd)) return 0;
  return Math.round(usd * 1_000_000);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolves the unix-ms timestamp for an assistant message.
 * Prefers inner message.timestamp (unix ms); falls back to outer ISO string.
 */
function resolveMessageTsMs(event: MessageEvent): number {
  const inner = event.message.timestamp;
  if (typeof inner === "number" && isFinite(inner) && inner > 0) {
    return inner;
  }
  return Date.parse(event.timestamp);
}

/**
 * Returns true when this assistant message should be zero-cost-skipped:
 * no responseId AND zero (or absent) cost.total.
 */
function isZeroCostSkipMsg(inner: MessageInner): boolean {
  if (inner.responseId != null) return false;
  const total = inner.usage?.cost?.total ?? 0;
  return total === 0;
}

// ---------------------------------------------------------------------------
// Main transform
// ---------------------------------------------------------------------------

/**
 * Transforms parsed Pi session events into the DB-row representation.
 *
 * All assistant messages (including zero-cost-skip candidates) are included
 * in the output so the importer can compute exact accounting totals.
 * The `isZeroCostSkip` flag tells the importer not to write those rows.
 */
export function transformSessionEvents(
  filePath: string,
  events: PiSessionEvent[],
): TransformedSession {
  // ── 1. Extract session metadata from the first session event ─────────────
  let piUuid: string | null = null;
  let cwd: string | null = null;
  let sessionStartMs = 0;

  for (const event of events) {
    if (event.type === "session") {
      const se = event as { type: "session"; id: string; timestamp: string; cwd?: string };
      piUuid = se.id ?? null;
      cwd = se.cwd ?? null;
      const ts = Date.parse(se.timestamp);
      if (!isNaN(ts)) sessionStartMs = ts;
      break;
    }
  }
  // Fall back to first event timestamp if no session event.
  if (sessionStartMs === 0 && events.length > 0) {
    const firstTs = (events[0] as { timestamp?: unknown }).timestamp;
    if (typeof firstTs === "string") {
      const ts = Date.parse(firstTs);
      if (!isNaN(ts)) sessionStartMs = ts;
    }
  }

  // ── 2. Pre-pass: build toolResult map for tool-call pairing ──────────────
  // Maps toolCallId → { endedAtMs, isError }
  const toolResultMap = new Map<string, { endedAtMs: number; isError: boolean }>();
  for (const event of events) {
    if (event.type !== "message") continue;
    const me = event as MessageEvent;
    const msg = me.message;
    if (msg.role !== "toolResult" || msg.toolCallId == null) continue;
    const endedAtMs = resolveMessageTsMs(me);
    // isError: check explicit flag or stopReason on the toolResult
    const isError =
      msg.isError === true ||
      msg.stopReason === "error";
    toolResultMap.set(msg.toolCallId, { endedAtMs, isError });
  }

  // ── 3. Turn segmentation + message + tool-call transformation ────────────
  let fallbackProvider: string | null = null;
  let fallbackModel: string | null = null;

  const turns: TransformedTurn[] = [];
  let currentTurn: TransformedTurn | null = null;
  let nextTurnIndex = 0;

  const createTurn = (startMs: number): TransformedTurn => ({
    harnessTurnId: `${filePath}:t${nextTurnIndex}`,
    turnIndex: nextTurnIndex++,
    startedAtMs: startMs,
    endedAtMs: null,
    provider: null,
    modelId: null,
    messages: [],
  });

  for (const event of events) {
    // Track model_change for fallback provider/model.
    if (event.type === "model_change") {
      const mce = event as { type: "model_change"; provider?: string; modelId?: string };
      if (mce.provider != null) fallbackProvider = mce.provider;
      if (mce.modelId != null) fallbackModel = mce.modelId;
      continue;
    }

    if (event.type !== "message") continue;
    const me = event as MessageEvent;
    const msg = me.message;

    // toolResult messages only contribute to toolResultMap (already built).
    if (msg.role === "toolResult") continue;

    // Non-toolResult user message: close current turn and start a new one.
    if (msg.role === "user") {
      if (currentTurn != null) turns.push(currentTurn);
      currentTurn = createTurn(Date.parse(me.timestamp));
      continue;
    }

    // Assistant message.
    if (msg.role === "assistant") {
      // Auto-create turn 0 if we reach an assistant message with no prior user message.
      if (currentTurn == null) {
        currentTurn = createTurn(resolveMessageTsMs(me));
      }

      const tsMs = resolveMessageTsMs(me);
      const provider = msg.provider ?? fallbackProvider;
      const modelId = msg.model ?? fallbackModel;

      // Check skip rule BEFORE building the full record.
      const skipZeroCost = isZeroCostSkipMsg(msg);

      // Build the message record (including the zero-cost-skip marker).
      const cost = msg.usage?.cost;
      const costInputMicros = dollarToMicros(cost?.input);
      const costOutputMicros = dollarToMicros(cost?.output);
      const costCacheReadMicros = dollarToMicros(cost?.cacheRead);
      const costCacheWriteMicros = dollarToMicros(cost?.cacheWrite);
      const costTotalMicros =
        costInputMicros + costOutputMicros + costCacheReadMicros + costCacheWriteMicros;

      const harnessMessageId =
        msg.responseId != null
          ? msg.responseId
          : `${filePath}:noid:${me.id}`;

      // Tool calls: one row per toolCall content block.
      const toolCalls: TransformedToolCall[] = [];
      if (!skipZeroCost && msg.content != null) {
        for (const block of msg.content) {
          if (isToolCallBlock(block)) {
            const tr = toolResultMap.get(block.id);
            toolCalls.push({
              harnessToolCallId: block.id,
              toolName: block.name,
              startedAtMs: tsMs,
              endedAtMs: tr?.endedAtMs ?? null,
              isError: tr?.isError ?? false,
            });
          }
        }
      }

      const transformedMsg: TransformedMessage = {
        harnessMessageId,
        responseId: msg.responseId ?? null,
        tsMs,
        provider: provider ?? null,
        modelId: modelId ?? null,
        inputTokens: msg.usage?.input ?? 0,
        outputTokens: msg.usage?.output ?? 0,
        cacheReadTokens: msg.usage?.cacheRead ?? 0,
        cacheWriteTokens: msg.usage?.cacheWrite ?? 0,
        costInputMicros,
        costOutputMicros,
        costCacheReadMicros,
        costCacheWriteMicros,
        costTotalMicros,
        costSource: costTotalMicros > 0 ? "harness" : "unknown",
        toolCalls,
        isZeroCostSkip: skipZeroCost,
      };

      currentTurn.messages.push(transformedMsg);
      currentTurn.endedAtMs = tsMs;

      // Propagate provider/model from the first assistant message in the turn.
      if (currentTurn.provider == null && provider != null) currentTurn.provider = provider;
      if (currentTurn.modelId == null && modelId != null) currentTurn.modelId = modelId;
    }
  }

  if (currentTurn != null) turns.push(currentTurn);

  return { filePath, piUuid, cwd, sessionStartMs, turns };
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

function isToolCallBlock(block: ContentBlock): block is ToolCallBlock {
  return block.type === "toolCall" && typeof (block as ToolCallBlock).id === "string";
}
