/**
 * hooks/post-tool-use-failure.ts — Handler for the Cursor postToolUseFailure event.
 *
 * Fires when a tool fails, times out, or is denied. This event is distinct
 * from postToolUse — Cursor routes success and failure to separate events.
 *
 * Responsibilities:
 *   1. Record the failed tool call to the store (isError = true).
 *   2. Remove the tool from activeTools in session state.
 */

import type { AnalyticsWriter } from "@token-tally/store";
import type { HookPayload } from "./types.js";
import {
  readSessionState,
  writeSessionState,
} from "../state/session-state.js";
import {
  extractHarnessSessionId,
  computeHarnessToolCallId,
} from "../ids/synthesize.js";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle a postToolUseFailure event.
 *
 * @param writer  Open AnalyticsWriter — caller owns open/close lifecycle.
 * @param payload Narrowed postToolUseFailure payload from Cursor.
 */
export async function handle(
  writer: AnalyticsWriter,
  payload: Extract<HookPayload, { hook_event_name: "postToolUseFailure" }>,
): Promise<void> {
  // ── 1. Derive harness session id ─────────────────────────────────────────
  const harnessSessionId = extractHarnessSessionId(payload);
  if (harnessSessionId === undefined) {
    console.warn(
      "[cursor-writer] postToolUseFailure: no conversation_id in payload — ignoring",
    );
    return;
  }

  // ── 2. Load state ─────────────────────────────────────────────────────────
  const state = await readSessionState(harnessSessionId);
  if (state === null) {
    console.warn(
      "[cursor-writer] postToolUseFailure: no state for session",
      harnessSessionId,
      "— skipping",
    );
    return;
  }

  // ── 3. Resolve pending tool entry ─────────────────────────────────────────
  // When tool_use_id is absent, preToolUse stored the entry under
  // tc${toolIndex} and THEN incremented toolIndex. Use toolIndex - 1 to find
  // the matching pre-tool entry. Tool calls in Cursor are serial per turn.
  const lookupIndex = payload.tool_use_id ? state.toolIndex : Math.max(0, state.toolIndex - 1);
  const harnessToolCallId = computeHarnessToolCallId(
    payload.tool_use_id,
    harnessSessionId,
    lookupIndex,
  );

  const pending = state.activeTools[harnessToolCallId] ?? {
    startedAt: Date.now(),
    toolName: payload.tool_name ?? "unknown",
    harnessToolCallId,
  };

  // ── 4. Record failed tool call ────────────────────────────────────────────
  await writer.recordToolCall({
    sessionId: state.centralSessionId,
    turnId: state.currentTurnId ?? undefined,
    harnessId: "cursor",
    harnessToolCallId: pending.harnessToolCallId,
    toolName: pending.toolName,
    startedAt: pending.startedAt,
    endedAt: Date.now(),
    isError: true, // postToolUseFailure → always an error
  });

  // ── 5. Remove from active tools ───────────────────────────────────────────
  delete state.activeTools[harnessToolCallId];

  // ── 6. Persist state ──────────────────────────────────────────────────────
  await writeSessionState(harnessSessionId, state);
}
