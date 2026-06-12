/**
 * hooks/stop.ts — Handler for the Claude Code "Stop" hook event.
 *
 * Fires when the main agent loop has finished responding to a user turn.
 * Responsibilities:
 *   1. Drain any remaining transcript entries into llm_messages.
 *   2. Close the currently open turn by setting its endedAt timestamp.
 *   3. Clear any in-flight tool entries (defensive — stale after Stop).
 *   4. Persist updated state.
 *
 * Does NOT close the session; that is SessionEnd's job.
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
 * Handle a "Stop" hook event.
 *
 * A null state means the writer missed SessionStart (e.g. installed mid-
 * session). Log a warning and return — we cannot safely close a turn we
 * never opened.
 */
export async function handle(
  writer: AnalyticsWriter,
  payload: Extract<HookPayload, { hook_event_name: "Stop" }>,
): Promise<void> {
  let state = await readSessionState(payload.session_id);
  if (state === null) {
    console.warn(
      "[claude-code-writer] Stop: no state found for session",
      payload.session_id,
      "— skipping (writer may have missed SessionStart)",
    );
    return;
  }

  // ── 1. Drain transcript ─────────────────────────────────────────────────
  state = await drainTranscript(writer, state, payload.transcript_path);

  // ── 2. Close current turn ───────────────────────────────────────────────
  // Both IDs are required — if either is null the turn was never opened and
  // there is nothing to close.
  if (state.currentTurnId !== null && state.currentHarnessTurnId !== null) {
    const now = Date.now();
    await writer.recordTurn({
      sessionId: state.centralSessionId,
      harnessId: "claude-code",
      harnessTurnId: state.currentHarnessTurnId,
      // Pass startedAt: 0 as the sentinel value. The store upsert uses
      // COALESCE(NULLIF(excluded.started_at, 0), turns.started_at) so the
      // value 0 is treated as "preserve the existing started_at" — the real
      // start time was recorded by UserPromptSubmit and must not be overwritten.
      startedAt: 0,
      endedAt: now,
    });
    state.currentTurnId = null;
    state.currentHarnessTurnId = null;
  }

  // ── 3. Clear stale in-flight tools ─────────────────────────────────────
  // Any tool that was in PreToolUse but never reached PostToolUse is now
  // stale — the agent has stopped. Drop them so they don't pollute the next
  // turn's bookkeeping.
  state.activeTools = {};

  // ── 4. Persist ─────────────────────────────────────────────────────────
  await writeSessionState(payload.session_id, state);
}
