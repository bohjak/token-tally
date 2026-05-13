/**
 * hooks/session-end.ts — Handler for the Cursor sessionEnd event.
 *
 * Fires once when a Cursor composer conversation terminates. Responsibilities:
 *   1. Run one final best-effort token/cost backfill if stop did not already drain.
 *   2. Close the session row by setting ended_at.
 *   3. Delete the on-disk session state file.
 *
 * Recovery: if no state file exists (writer installed mid-session), we
 * synthesise a minimal state so the session row exists in the DB.
 *
 */

import type { AnalyticsWriter } from "@token-tally/store";
import type { HookPayload } from "./types.js";
import {
  readSessionState,
  writeSessionState,
  deleteSessionState,
  makeInitialSessionState,
} from "../state/session-state.js";
import { extractHarnessSessionId } from "../ids/synthesize.js";
import { runBackfill } from "./stop.js";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle a sessionEnd event.
 *
 * @param writer  Open AnalyticsWriter — caller owns open/close lifecycle.
 * @param payload Narrowed sessionEnd payload from Cursor.
 */
export async function handle(
  writer: AnalyticsWriter,
  payload: Extract<HookPayload, { hook_event_name: "sessionEnd" }>,
): Promise<void> {
  // ── 1. Derive harness session id ─────────────────────────────────────────
  const harnessSessionId = extractHarnessSessionId(payload);
  if (harnessSessionId === undefined) {
    console.warn(
      "[cursor-writer] sessionEnd: payload missing both conversation_id and session_id — ignoring",
    );
    return;
  }

  // ── 2. Load or synthesise state ──────────────────────────────────────────
  let state = await readSessionState(harnessSessionId);

  if (state === null) {
    // Writer was installed after the session started. Create a minimal session
    // row so the DB has a record, then close it.
    console.warn(
      "[cursor-writer] sessionEnd: no state file found for session",
      harnessSessionId,
      "— synthesising minimal session row",
    );

    const cwd =
      payload.cwd ??
      (payload.workspace_roots && payload.workspace_roots.length > 0
        ? payload.workspace_roots[0]
        : undefined);

    const sessionResult = await writer.recordSession({
      harnessId: "cursor",
      harnessSessionId,
      cwd,
      startedAt: Date.now(),
    });

    state = makeInitialSessionState(sessionResult.id, harnessSessionId);
    await writeSessionState(harnessSessionId, state);
  }

  // ── 3. Final best-effort token/cost backfill ─────────────────────────────
  // A normal agent loop fires stop before sessionEnd, but abrupt window closes
  // may skip stop. Run one final drain here before deleting the state file.
  if (!state.drained) {
    await runBackfill(writer, harnessSessionId, state.centralSessionId, payload);
    state.drained = true;
  }

  // ── 4. Close the session row ─────────────────────────────────────────────
  // Pass startedAt: 0 so the NULLIF guard in the upsert SQL preserves the
  // original start time written by sessionStart. Only endedAt is new here.
  await writer.recordSession({
    harnessId: "cursor",
    harnessSessionId,
    startedAt: 0, // NULLIF guard: keeps stored value
    endedAt: Date.now(),
  });

  // ── 5. Clean up state file ───────────────────────────────────────────────
  await deleteSessionState(harnessSessionId);
}
