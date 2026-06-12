/**
 * hooks/before-submit-prompt.ts — Handler for the Cursor beforeSubmitPrompt event.
 *
 * Fires when the user hits send, before the backend request. We use this as
 * the signal to open a new turn in the store.
 *
 * The prompt text is intentionally ignored — data minimisation principle.
 * We record only that a turn happened.
 *
 * Cursor sends `generation_id` on this event (a stable identifier for this
 * user-to-model exchange). We use it as the harness turn id so the turn can
 * be correlated across beforeSubmitPrompt / afterAgentResponse / stop.
 */

import type { AnalyticsWriter } from "@token-tally/store";
import type { HookPayload } from "./types.js";
import {
  readSessionState,
  writeSessionState,
  makeInitialSessionState,
} from "../state/session-state.js";
import {
  extractHarnessSessionId,
  computeHarnessTurnId,
} from "../ids/synthesize.js";
import { INTEGRATION_VERSION } from "../version.js";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle a beforeSubmitPrompt event.
 *
 * Opens a new turn row in the store and persists updated session state so
 * subsequent events (preToolUse, afterAgentResponse, stop) can link their
 * records to the correct turn.
 */
export async function handle(
  writer: AnalyticsWriter,
  payload: Extract<HookPayload, { hook_event_name: "beforeSubmitPrompt" }>,
): Promise<void> {
  // ── 1. Derive harness session id ─────────────────────────────────────────
  const harnessSessionId = extractHarnessSessionId(payload);
  if (harnessSessionId === undefined) {
    console.warn(
      "[cursor-writer] beforeSubmitPrompt: no conversation_id in payload — ignoring",
    );
    return;
  }

  // ── 2. Load or synthesise state ──────────────────────────────────────────
  let state = await readSessionState(harnessSessionId);

  if (state === null) {
    // Install-mid-session: synthesise a minimal session row.
    console.warn(
      "[cursor-writer] beforeSubmitPrompt: no state for session",
      harnessSessionId,
      "— synthesising (writer may have been installed mid-session)",
    );

    const cwd =
      payload.cwd ??
      (payload.workspace_roots && payload.workspace_roots.length > 0
        ? payload.workspace_roots[0]
        : undefined);

    // Register harness FIRST — sessions.harness_id has a FK to harnesses(name).
    // Without this, recordSession fails with a FK violation on a fresh DB.
    await writer.recordHarness({
      name: "cursor",
      displayName: "Cursor",
      version: payload.cursor_version ?? undefined,
      integrationVersion: INTEGRATION_VERSION,
    });

    const sessionResult = await writer.recordSession({
      harnessId: "cursor",
      harnessSessionId,
      cwd,
      startedAt: Date.now(),
    });

    state = makeInitialSessionState(sessionResult.id, harnessSessionId);
  }

  // ── 3. Advance turn counter ───────────────────────────────────────────────
  // Increment before computing the synthesized ID so each turn gets a unique
  // counter value. When generation_id is present this counter is unused, but
  // we increment anyway for consistency.
  state.turnIndex += 1;

  // ── 4. Compute harness turn id ────────────────────────────────────────────
  const harnessTurnId = computeHarnessTurnId(
    payload.generation_id,
    harnessSessionId,
    state.turnIndex,
  );

  // ── 5. Open turn in the store ─────────────────────────────────────────────
  const turnResult = await writer.recordTurn({
    sessionId: state.centralSessionId,
    harnessId: "cursor",
    harnessTurnId,
    turnIndex: state.turnIndex,
    startedAt: Date.now(),
    modelId: payload.model ?? state.lastModelId ?? undefined,
  });

  // ── 6. Update state ───────────────────────────────────────────────────────
  state.currentTurnId = turnResult.id;
  state.currentHarnessTurnId = harnessTurnId;
  state.lastGenerationId = payload.generation_id ?? null;

  if (payload.model) {
    state.lastModelId = payload.model;
  }

  await writeSessionState(harnessSessionId, state);
}
