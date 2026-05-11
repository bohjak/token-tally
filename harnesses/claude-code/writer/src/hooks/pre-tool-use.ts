/**
 * pre-tool-use.ts — PreToolUse hook handler.
 *
 * Buffers the in-flight tool call into per-session state so that
 * post-tool-use.ts can record the complete tool call (with start time and
 * error flag) once Claude Code reports the outcome.
 *
 * No database write happens here — only state file I/O. The `writer`
 * parameter is accepted for API consistency with other handlers.
 */

import type { AnalyticsWriter } from "@token-tally/store";
import type { HookPayload } from "./types.js";
import {
  readSessionState,
  writeSessionState,
} from "../state/session-state.js";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle a PreToolUse hook event.
 *
 * Writes `{ startedAt, toolName }` into `state.activeTools[tool_use_id]`.
 * If the same `tool_use_id` already exists (replay / duplicate delivery),
 * the entry is overwritten — idempotent.
 *
 * Returns early with a warning if no session state file exists yet
 * (e.g. the writer was installed mid-session after SessionStart fired).
 */
export async function handle(
  _writer: AnalyticsWriter,
  payload: Extract<HookPayload, { hook_event_name: "PreToolUse" }>,
): Promise<void> {
  const state = await readSessionState(payload.session_id);

  if (state === null) {
    console.warn(
      `[claude-code-writer] PreToolUse: no state found for session ${payload.session_id}; skipping tool buffering`,
    );
    return;
  }

  state.activeTools[payload.tool_use_id] = {
    startedAt: Date.now(),
    toolName: payload.tool_name,
  };

  await writeSessionState(payload.session_id, state);
}
