/**
 * hooks/stop.ts — Handler for the Cursor stop event.
 *
 * Fires when the agent loop ends. Responsibilities:
 *   1. Run best-effort token/cost backfill for LLM message placeholders written
 *      during this turn by afterAgentResponse. Drains transcript first, then
 *      falls back to Cursor's private state.vscdb.
 *   2. Close the currently open turn by setting its endedAt timestamp.
 *   3. Clear any stale in-flight tool entries.
 *   4. Persist updated state.
 *
 * Does NOT close the session — that is sessionEnd's job.
 *
 * BACKFILL STRATEGY
 * ─────────────────
 * Cursor hook payloads carry no token counts. To upgrade placeholder rows from
 * cost_source='unknown' to cost_source='writer' (or 'subscription_covered'), we:
 *   a) Read the transcript file from payload.transcript_path (preferred).
 *   b) If that yields nothing, query Cursor's private state.vscdb (experimental).
 *   c) For each record with non-zero tokens, compute costs via the shared
 *      pricing table and upsert the placeholder row.
 *   d) If a subscription is configured, link to the active period and set
 *      cost_source='subscription_covered'.
 *
 * Backfill is idempotent — the writer upserts on (harness_id, harness_message_id).
 * A second `stop` (e.g. from loop_count > 0) will not duplicate rows.
 */

import type { AnalyticsWriter } from "@token-tally/store";
import { computeCostMicros } from "@token-tally/store";
import type { HookPayload } from "./types.js";
import {
  readSessionState,
  writeSessionState,
} from "../state/session-state.js";
import { extractHarnessSessionId } from "../ids/synthesize.js";
import { drainTranscript } from "../transcript/drain.js";
import type { BackfillRecord } from "../transcript/drain.js";
import { drainSqlite } from "../sqlite/drain.js";
import {
  loadCursorSubscriptionConfig,
} from "../subscription/config.js";
import { computeMonthlyPeriod } from "../subscription/periods.js";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle a stop event.
 *
 * A null state means the writer missed sessionStart (e.g. installed mid-
 * session). Log a warning and return — cannot safely close a turn that was
 * never opened.
 */
export async function handle(
  writer: AnalyticsWriter,
  payload: Extract<HookPayload, { hook_event_name: "stop" }>,
): Promise<void> {
  // ── 1. Derive harness session id ─────────────────────────────────────────
  const harnessSessionId = extractHarnessSessionId(payload);
  if (harnessSessionId === undefined) {
    console.warn(
      "[cursor-writer] stop: no conversation_id in payload — ignoring",
    );
    return;
  }

  // ── 2. Load state ─────────────────────────────────────────────────────────
  const state = await readSessionState(harnessSessionId);
  if (state === null) {
    console.warn(
      "[cursor-writer] stop: no state for session",
      harnessSessionId,
      "— skipping (writer may have missed sessionStart)",
    );
    return;
  }

  // ── 3. Best-effort token/cost backfill ────────────────────────────────────
  // Run on every stop. The store upserts are idempotent, so a second stop
  // (e.g. loop_count > 0) updates existing rows without duplicating them.
  // Running on each stop ensures messages from every turn get backfilled, not
  // only the first (M4 fix: drained flag removed).
  const pendingIds = !Array.isArray(state.pendingHarnessMessageIds) ? [] : state.pendingHarnessMessageIds;
  await runBackfill(writer, harnessSessionId, state.centralSessionId, payload, pendingIds);
  state.pendingHarnessMessageIds = [];

  // ── 4. Close current turn ─────────────────────────────────────────────────
  // Both IDs are required — if either is null the turn was never opened.
  if (state.currentTurnId !== null && state.currentHarnessTurnId !== null) {
    const now = Date.now();
    await writer.recordTurn({
      sessionId: state.centralSessionId,
      harnessId: "cursor",
      harnessTurnId: state.currentHarnessTurnId,
      // Pass startedAt: 0 so NULLIF preserves the originally stored start time.
      startedAt: 0,
      endedAt: now,
    });
    state.currentTurnId = null;
    state.currentHarnessTurnId = null;
  }

  // ── 5. Clear stale in-flight tools ───────────────────────────────────────
  // Any tool in preToolUse state that never reached postToolUse/Failure is now
  // stale — the agent has stopped. Drop them.
  state.activeTools = {};

  // ── 6. Persist state ──────────────────────────────────────────────────────
  await writeSessionState(harnessSessionId, state);
}

// ---------------------------------------------------------------------------
// Backfill implementation (shared between stop and subagentStop)
// ---------------------------------------------------------------------------

/**
 * Attempt to backfill token counts and cost onto placeholder llm_message rows.
 *
 * Preferred source: transcript at `transcriptPath` (hook-provided, documented).
 * Fallback source:  Cursor's state.vscdb (private, best-effort).
 *
 * For each record with usable token data, upserts the placeholder row with:
 *   - Real token counts and model/provider.
 *   - Cost breakdown computed via the shared pricing table.
 *   - cost_source = 'writer' (or 'subscription_covered' when configured).
 *
 * Rows with no token data or unknown model pricing remain at cost_source='unknown'.
 *
 * @param writer           Open AnalyticsWriter.
 * @param harnessSessionId The Cursor conversation_id used as harness session id.
 * @param centralSessionId ToTally sessions.id UUID for the current session.
 * @param payload          The stop/subagentStop hook payload.
 */
export async function runBackfill(
  writer: AnalyticsWriter,
  harnessSessionId: string,
  centralSessionId: string,
  payload: {
    transcript_path?: string | null;
    conversation_id?: string;
  },
  pendingHarnessMessageIds?: string[],
): Promise<void> {
  const conversationId = payload.conversation_id ?? harnessSessionId;

  // ── a. Transcript drain (preferred) ──────────────────────────────────────
  let records: BackfillRecord[] = [];
  let sessionModelFromSqlite: string | null = null;

  if (typeof payload.transcript_path === "string" && payload.transcript_path !== "") {
    records = await drainTranscript(payload.transcript_path, conversationId, pendingHarnessMessageIds);
  }

  // ── b. SQLite fallback ────────────────────────────────────────────────────
  // Use SQLite only when transcript produced no records. This preserves the
  // transcript as the authoritative source when both are available.
  if (records.length === 0) {
    const sqliteResult = await drainSqlite(conversationId);
    records = sqliteResult.records;
    sessionModelFromSqlite = sqliteResult.sessionModel;
  }

  if (records.length === 0) {
    // Nothing to backfill — placeholder rows remain at unknown cost.
    return;
  }

  // ── c. Subscription config ────────────────────────────────────────────────
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

  // ── d. Upsert each backfilled record ──────────────────────────────────────
  for (const record of records) {
    // Apply session-level model fallback from SQLite when the record lacks one.
    const modelId = record.modelId ?? sessionModelFromSqlite ?? undefined;

    // Compute cost breakdown from the shared pricing table.
    const cost = computeCostMicros({
      modelId: modelId ?? null,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      // Cursor does not expose cache tokens in any drain source.
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    // Determine cost_source:
    //   - 'subscription_covered' only when BOTH a subscription is configured AND
    //     pricing resolved to 'writer'. Marking unknown-priced rows as
    //     'subscription_covered' makes $0 appear "free" to readers.
    //   - 'writer' when pricing resolved without a subscription.
    //   - 'unknown' when the model is not in the pricing table.
    const costSource =
      subscriptionId !== null && cost.costSource === "writer"
        ? "subscription_covered"
        : cost.costSource;

    // Pass ts: 0 (sentinel) and omit turnId so the store COALESCE guards
    // preserve the placeholder's original timestamp and turn linkage.
    await writer.recordLlmMessage({
      sessionId: centralSessionId,
      // turnId deliberately omitted: null -> COALESCE keeps existing turn_id
      harnessId: "cursor",
      harnessMessageId: record.harnessMessageId,
      ts: 0, // sentinel: COALESCE(NULLIF(0,0), existing_ts) -> keeps existing
      modelId,
      provider: record.provider,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      costInputMicros: cost.costInputMicros,
      costOutputMicros: cost.costOutputMicros,
      costCacheReadMicros: cost.costCacheReadMicros,
      costCacheWriteMicros: cost.costCacheWriteMicros,
      costSource,
      // Only set subscriptionId when actually subscription_covered.
      subscriptionId: costSource === "subscription_covered" ? (subscriptionId ?? undefined) : undefined,
    });
  }
}
