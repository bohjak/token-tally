/**
 * hooks/post-tool-use.ts — Handler for the Cursor postToolUse event.
 *
 * Fires after a tool executes successfully. Responsibilities:
 *   1. Record the completed tool call to the store (timing + success flag).
 *   2. Remove the tool from activeTools in session state.
 *
 * In Cursor, errors route to postToolUseFailure, so every postToolUse is
 * implicitly a success (isError = false).
 *
 * NOTE: Transcript drain is intentionally absent here — that is T7/T8's
 * responsibility via the stop handler.
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
 * Handle a postToolUse event.
 *
 * @param writer  Open AnalyticsWriter — caller owns open/close lifecycle.
 * @param payload Narrowed postToolUse payload from Cursor.
 */
export async function handle(
  writer: AnalyticsWriter,
  payload: Extract<HookPayload, { hook_event_name: "postToolUse" }>,
): Promise<void> {
  // ── 1. Derive harness session id ─────────────────────────────────────────
  const harnessSessionId = extractHarnessSessionId(payload);
  if (harnessSessionId === undefined) {
    console.warn(
      "[cursor-writer] postToolUse: no conversation_id in payload — ignoring",
    );
    return;
  }

  // ── 2. Load state ─────────────────────────────────────────────────────────
  const state = await readSessionState(harnessSessionId);
  if (state === null) {
    console.warn(
      "[cursor-writer] postToolUse: no state for session",
      harnessSessionId,
      "— skipping",
    );
    return;
  }

  // ── 3. Resolve pending tool entry ─────────────────────────────────────────
  // The matching preToolUse keyed the entry by harnessToolCallId which equals
  // tool_use_id when present. Look up by the same key.
  const harnessToolCallId = computeHarnessToolCallId(
    payload.tool_use_id,
    harnessSessionId,
    state.toolIndex, // index used only if tool_use_id is absent
  );

  const pending = state.activeTools[harnessToolCallId] ?? {
    startedAt: Date.now(),
    toolName: payload.tool_name ?? "unknown",
    harnessToolCallId,
  };

  // ── 4. Record tool call ────────────────────────────────────────────────────
  await writer.recordToolCall({
    sessionId: state.centralSessionId,
    turnId: state.currentTurnId ?? undefined,
    harnessId: "cursor",
    harnessToolCallId: pending.harnessToolCallId,
    toolName: pending.toolName,
    startedAt: pending.startedAt,
    endedAt: Date.now(),
    isError: false, // postToolUse → success; failures go to postToolUseFailure
  });

  // ── 5. Remove from active tools ───────────────────────────────────────────
  delete state.activeTools[harnessToolCallId];

  // ── 6. Persist state ──────────────────────────────────────────────────────
  await writeSessionState(harnessSessionId, state);
}
