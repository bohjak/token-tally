/**
 * hooks/subagent-stop.ts — Handler for the Claude Code "SubagentStop" event.
 *
 * Fires when a subagent (a nested agent spawned by the main agent) finishes.
 * The parent agent is still active, so this handler deliberately does NOT
 * close the open turn — only the main "Stop" event does that.
 *
 * Responsibilities:
 *   1. Drain any new transcript entries written by the subagent.
 *   2. Persist the updated offset back to state.
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
 * Handle a "SubagentStop" hook event.
 *
 * A null state means the writer missed SessionStart. Log and return — we
 * cannot drain a transcript we have no offset for without risking duplicate
 * llm_messages rows (the next drain would start from 0 and re-record
 * everything).
 */
export async function handle(
  writer: AnalyticsWriter,
  payload: Extract<HookPayload, { hook_event_name: "SubagentStop" }>,
): Promise<void> {
  let state = await readSessionState(payload.session_id);
  if (state === null) {
    console.warn(
      "[claude-code-writer] SubagentStop: no state found for session",
      payload.session_id,
      "— skipping (writer may have missed SessionStart)",
    );
    return;
  }

  // ── 1. Drain transcript ─────────────────────────────────────────────────
  // The subagent may have produced additional assistant messages. Drain them
  // now so they are recorded promptly (rather than waiting for the next
  // PostToolUse or Stop on the parent agent).
  state = await drainTranscript(writer, state, payload.transcript_path);

  // ── 2. Persist updated offset ───────────────────────────────────────────
  // Do NOT touch currentTurnId or currentHarnessTurnId — the parent turn is
  // still open and will be closed by the subsequent Stop event.
  await writeSessionState(payload.session_id, state);
}
