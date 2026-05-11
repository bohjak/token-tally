/**
 * hooks/post-tool-use.ts — PostToolUse hook handler.
 *
 * Fires after each tool call completes. Responsibilities:
 *   1. Record the completed tool call to the store (with timing + error flag).
 *   2. Remove the tool from `activeTools` in session state.
 *   3. Drain any new assistant transcript entries since the last drain.
 *
 * If state is missing (e.g. first hook after install mid-session), we log a
 * warning and return early — there is no centralSessionId to write against.
 */

import type { AnalyticsWriter } from "@token-tally/store";
import type { HookPayload } from "./types.js";
import {
  readSessionState,
  writeSessionState,
} from "../state/session-state.js";
import { drainTranscript } from "../transcript/drain.js";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle a PostToolUse hook event.
 *
 * @param writer  Open AnalyticsWriter — caller owns open/close lifecycle.
 * @param payload Narrowed PostToolUse hook payload from Claude Code.
 */
export async function handle(
  writer: AnalyticsWriter,
  payload: Extract<HookPayload, { hook_event_name: "PostToolUse" }>,
): Promise<void> {
  // ── 1. Load state ─────────────────────────────────────────────────────────
  let state = await readSessionState(payload.session_id);
  if (state === null) {
    console.warn(
      `[claude-code-writer] PostToolUse: no state for session ${payload.session_id}; skipping`,
    );
    return;
  }

  // ── 2. Resolve pending tool entry ─────────────────────────────────────────
  // The tool should have been buffered by the preceding PreToolUse hook.
  // Fall back to synthesising a minimal entry in case PreToolUse was missed
  // (e.g. install happened after the tool was started).
  const pending = state.activeTools[payload.tool_use_id] ?? {
    startedAt: Date.now(),
    toolName: payload.tool_name,
  };

  // ── 3. Record the tool call ────────────────────────────────────────────────
  await writer.recordToolCall({
    sessionId: state.centralSessionId,
    turnId: state.currentTurnId ?? undefined,
    harnessId: "claude-code",
    harnessToolCallId: payload.tool_use_id,
    toolName: pending.toolName,
    startedAt: pending.startedAt,
    endedAt: Date.now(),
    isError: !!(payload.tool_response as { is_error?: boolean } | undefined)
      ?.is_error,
  });

  // ── 4. Remove from activeTools ────────────────────────────────────────────
  delete state.activeTools[payload.tool_use_id];

  // ── 5. Drain transcript ───────────────────────────────────────────────────
  // Returns a new state object with updated transcriptOffset, lastModelId,
  // and lastProvider. Caller (us) is responsible for persisting it.
  state = await drainTranscript(writer, state, payload.transcript_path);

  // ── 6. Persist state ──────────────────────────────────────────────────────
  await writeSessionState(payload.session_id, state);
}
