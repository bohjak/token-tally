/**
 * hooks/subagent-stop.ts — Handler for the Cursor subagentStop event.
 *
 * Fires when a subagent (Task tool) completes, errors, or is aborted. The
 * parent agent is still active — do NOT close the open parent turn here.
 *
 * Responsibilities:
 *   1. Run best-effort token/cost backfill for any LLM message placeholders
 *      produced by the subagent, using its own transcript at
 *      `payload.agent_transcript_path` (separate from the parent transcript).
 *   2. Log subagent completion status for observability.
 *
 * SUBAGENT TRANSCRIPT vs PARENT TRANSCRIPT
 * ─────────────────────────────────────────
 * Cursor exposes `agent_transcript_path` specifically for subagentStop.
 * This is distinct from the parent `transcript_path` in the base payload.
 * We prefer `agent_transcript_path` here because it contains only the
 * subagent's messages.
 *
 * The SQLite state.vscdb fallback is NOT used for subagents because
 * subagent bubbles would require knowing the subagent's internal composer id,
 * which is not reliably available from the hook payload. Transcript-only
 * backfill is therefore the best we can do here.
 */

import type { AnalyticsWriter } from "@token-tally/store";
import type { HookPayload } from "./types.js";
import {
  readSessionState,
} from "../state/session-state.js";
import { extractHarnessSessionId } from "../ids/synthesize.js";
import { drainTranscript } from "../transcript/drain.js";
import { computeCostMicros } from "@token-tally/store";
import {
  loadCursorSubscriptionConfig,
} from "../subscription/config.js";
import { computeMonthlyPeriod } from "../subscription/periods.js";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle a subagentStop event.
 */
export async function handle(
  writer: AnalyticsWriter,
  payload: Extract<HookPayload, { hook_event_name: "subagentStop" }>,
): Promise<void> {
  const harnessSessionId = extractHarnessSessionId(payload);

  if (harnessSessionId === undefined) {
    console.warn(
      "[cursor-writer] subagentStop: no conversation_id in payload — ignoring",
    );
    return;
  }

  // Log subagent completion for observability. Non-completed statuses are
  // worth knowing about even though we don't take corrective action.
  if (payload.status !== "completed") {
    console.warn(
      "[cursor-writer] subagentStop: subagent ended with status",
      payload.status ?? "unknown",
      "session:", harnessSessionId,
    );
  }

  // Load state to get the ToTally session UUID. If we missed sessionStart,
  // we cannot safely write rows — skip with a warning.
  const state = await readSessionState(harnessSessionId);
  if (state === null) {
    console.warn(
      "[cursor-writer] subagentStop: no state for session",
      harnessSessionId,
      "— skipping backfill (writer may have missed sessionStart)",
    );
    return;
  }

  // ── Subagent transcript backfill ──────────────────────────────────────────
  // agent_transcript_path contains only this subagent's messages.
  const transcriptPath = payload.agent_transcript_path;
  if (typeof transcriptPath !== "string" || transcriptPath === "") {
    // No transcript provided — nothing to backfill.
    return;
  }

  const conversationId = payload.conversation_id ?? harnessSessionId;
  const records = await drainTranscript(transcriptPath, conversationId);

  if (records.length === 0) {
    return;
  }

  // ── Subscription config ───────────────────────────────────────────────────
  const subConfig = await loadCursorSubscriptionConfig();
  let subscriptionId: string | null = null;

  if (subConfig !== null) {
    const { periodStartMs, periodEndMs } = computeMonthlyPeriod(
      new Date(),
      subConfig.startDay,
    );
    const subResult = await writer.recordSubscription({
      harnessId: "cursor",
      planName: subConfig.plan,
      periodStart: periodStartMs,
      periodEnd: periodEndMs,
      fixedCost: subConfig.fixedCostUSD,
      currency: "USD",
    });
    subscriptionId = subResult.id;
  }

  // ── Upsert backfilled records ─────────────────────────────────────────────
  for (const record of records) {
    const cost = computeCostMicros({
      modelId: record.modelId ?? null,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    // Only classify as subscription_covered when pricing actually resolved.
    const costSource =
      subscriptionId !== null && cost.costSource === "writer"
        ? "subscription_covered"
        : cost.costSource;

    await writer.recordLlmMessage({
      sessionId: state.centralSessionId,
      // turnId deliberately omitted: null -> COALESCE keeps existing turn_id
      harnessId: "cursor",
      harnessMessageId: record.harnessMessageId,
      ts: 0, // sentinel: COALESCE(NULLIF(0,0), existing_ts) -> keeps existing
      modelId: record.modelId,
      provider: record.provider,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      costInputMicros: cost.costInputMicros,
      costOutputMicros: cost.costOutputMicros,
      costCacheReadMicros: cost.costCacheReadMicros,
      costCacheWriteMicros: cost.costCacheWriteMicros,
      costSource,
      subscriptionId: costSource === "subscription_covered" ? (subscriptionId ?? undefined) : undefined,
    });
  }
}
