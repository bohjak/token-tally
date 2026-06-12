/**
 * transcript/drain.ts — Incremental transcript drain helper.
 *
 * Reads new assistant entries from the transcript JSONL since the last recorded
 * offset, computes costs, and records them to the ToTally store. Called by
 * PostToolUse, Stop, SubagentStop, and SessionEnd handlers to keep
 * llm_messages rows current as the session progresses.
 *
 * The caller is responsible for persisting the returned (updated) SessionState
 * back to disk via writeSessionState — drain.ts deliberately does not do this
 * itself so that callers can batch the state write with their own mutations.
 */

import type { AnalyticsWriter } from "@token-tally/store";
import { readTranscriptFrom } from "./reader.js";
import { extractAssistantUsage } from "./extract.js";
import { computeCostMicros } from "../pricing/compute.js";
import type { SessionState } from "../state/session-state.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Drain new transcript entries into the store.
 *
 * Reads assistant entries from `transcriptPath` starting at
 * `state.transcriptOffset`, records each as an `llm_messages` row, then
 * returns the updated state with the new offset. Does NOT write the state
 * file — callers must call `writeSessionState` themselves.
 *
 * @param writer         Open AnalyticsWriter (caller owns open/close).
 * @param state          Current session state — read-only, not mutated in place.
 * @param transcriptPath Absolute path to the Claude Code JSONL transcript.
 * @returns              Updated copy of `state` with `transcriptOffset`,
 *                       `lastModelId`, and `lastProvider` refreshed.
 */
export async function drainTranscript(
  writer: AnalyticsWriter,
  state: SessionState,
  transcriptPath: string,
): Promise<SessionState> {
  // Shallow-copy state so callers see a new object, not silent mutation.
  const updated: SessionState = { ...state, activeTools: { ...state.activeTools } };

  // M6: reset the offset whenever the transcript path has changed (e.g. a
  // subagent that writes to a different file, or a session resume with a new
  // transcript). The incoming path becomes the new anchor.
  if (updated.transcriptPath !== transcriptPath) {
    updated.transcriptOffset = 0;
    updated.transcriptPath = transcriptPath;
  }

  const { entries, nextLine, wasReset } = await readTranscriptFrom(
    transcriptPath,
    updated.transcriptOffset,
  );

  // M1: Only attribute entries to the current turn when we are doing a genuine
  // incremental read (wasReset=false). On a rotation-reset rescan the returned
  // entries already exist in the store; with the store COALESCE guard on
  // turn_id, passing undefined preserves their existing turn attribution.
  const effectiveTurnId = wasReset ? null : updated.currentTurnId;

  for (const entry of entries) {
    const usage = extractAssistantUsage(entry);
    if (usage === null) continue;

    // ── Cost computation ──────────────────────────────────────────────────
    let costInputMicros: number;
    let costOutputMicros: number;
    let costCacheReadMicros: number;
    let costCacheWriteMicros: number;
    let costSource: "harness" | "writer" | "subscription_covered" | "unknown";

    if (usage.legacyCostUSD !== null) {
      // Legacy path: harness provided a pre-computed dollar cost.
      // Attribute the full amount to output if there are output tokens,
      // otherwise to input — satisfying the CHECK (total == sum) constraint.
      const totalMicros = Math.round(usage.legacyCostUSD * 1_000_000);
      costInputMicros = usage.outputTokens > 0 ? 0 : totalMicros;
      costOutputMicros = usage.outputTokens > 0 ? totalMicros : 0;
      costCacheReadMicros = 0;
      costCacheWriteMicros = 0;
      costSource = "harness";
    } else {
      // Normal path: compute from token counts using the pricing table.
      const breakdown = computeCostMicros(usage);
      costInputMicros = breakdown.costInputMicros;
      costOutputMicros = breakdown.costOutputMicros;
      costCacheReadMicros = breakdown.costCacheReadMicros;
      costCacheWriteMicros = breakdown.costCacheWriteMicros;
      costSource = breakdown.costSource;
    }

    // Subscription override: when the session is subscription-covered and we
    // computed the cost ourselves (writer), reclass cost_source accordingly.
    if (updated.subscriptionId !== null && costSource === "writer") {
      costSource = "subscription_covered";
    }

    // ── Store write ───────────────────────────────────────────────────────
    await writer.recordLlmMessage({
      sessionId: updated.centralSessionId,
      // M1: use effectiveTurnId so rotation-rescanned historical entries do
      // not get their turn attribution overwritten by the current turn.
      turnId: effectiveTurnId ?? undefined,
      harnessId: "claude-code",
      harnessMessageId: usage.harnessMessageId,
      ts: usage.ts,
      provider: "anthropic",
      modelId: usage.modelId ?? undefined,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      costInputMicros,
      costOutputMicros,
      costCacheReadMicros,
      costCacheWriteMicros,
      costCurrency: "USD",
      costSource,
      // m2: subscriptionId is only valid when this row is actually covered;
      // do not set it for 'harness' or 'unknown' rows.
      subscriptionId: costSource === "subscription_covered"
        ? (updated.subscriptionId ?? undefined)
        : undefined,
    });

    // ── Update running state ──────────────────────────────────────────────
    if (usage.modelId !== null) {
      updated.lastModelId = usage.modelId;
    }
    updated.lastProvider = "anthropic";
  }

  updated.transcriptOffset = nextLine;
  return updated;
}
