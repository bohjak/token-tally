/**
 * user-prompt-submit.ts — Handler for the UserPromptSubmit hook event.
 *
 * Fires when the user submits a prompt to Claude Code. We use this as the
 * signal to open a new turn in the store. The prompt text itself is
 * intentionally ignored (data minimisation).
 */

import type { AnalyticsWriter } from "@token-tally/store";
import type { HookPayload } from "./types.js";
import {
  readSessionState,
  writeSessionState,
  type SessionState,
} from "../state/session-state.js";
import { synthesizeTurnId, centralUuid } from "../ids/synthesize.js";
import { INTEGRATION_VERSION } from "../version.js";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle a UserPromptSubmit hook event.
 *
 * Opens a new turn in the store and persists the updated session state so
 * subsequent hooks (PreToolUse, PostToolUse, Stop) can link their records to
 * the correct turn.
 */
export async function handle(
  writer: AnalyticsWriter,
  payload: Extract<HookPayload, { hook_event_name: "UserPromptSubmit" }>,
): Promise<void> {
  // ── 1. Load existing session state ────────────────────────────────────────
  let state = await readSessionState(payload.session_id);

  // ── 2. Recover from missing state (install-mid-session case) ──────────────
  // If the writer extension was installed after the session started, there
  // will be no state file. We synthesise a minimal session row so recording
  // can continue from this point forward.
  if (state === null) {
    console.warn(
      "[claude-code-writer] UserPromptSubmit: no session state found for session",
      payload.session_id,
      "— synthesising minimal state (extension may have been installed mid-session)",
    );

    // Register the harness first so the FK constraint on sessions.harness_id
    // passes. Without this, recordSession fails on a fresh/purged DB.
    await writer.recordHarness({
      name: "claude-code",
      displayName: "Claude Code",
      version: process.env["CLAUDE_CODE_VERSION"] ?? "unknown",
      integrationVersion: INTEGRATION_VERSION,
    });

    const sessionResult = await writer.recordSession({
      harnessId: "claude-code",
      harnessSessionId: payload.session_id,
      cwd: payload.cwd,
      startedAt: Date.now(),
    });

    state = {
      centralSessionId: sessionResult.id,
      harnessSessionId: payload.session_id,
      turnIndex: 0,
      currentTurnId: null,
      currentHarnessTurnId: null,
      transcriptPath: null,
      transcriptOffset: 0,
      lastModelId: null,
      lastProvider: null,
      subscriptionId: null,
      activeTools: {},
    } satisfies SessionState;
  }

  // ── 3. Advance the turn counter ────────────────────────────────────────────
  state.turnIndex += 1;

  // ── 4. Synthesise a stable harness-scoped turn ID ─────────────────────────
  state.currentHarnessTurnId = synthesizeTurnId(
    payload.session_id,
    state.turnIndex,
  );

  // ── 5. Open a new turn in the store ───────────────────────────────────────
  // recordTurn generates the UUID internally and returns it in RecordResult.id.
  const turnResult = await writer.recordTurn({
    sessionId: state.centralSessionId,
    harnessId: "claude-code",
    harnessTurnId: state.currentHarnessTurnId,
    turnIndex: state.turnIndex,
    startedAt: Date.now(),
  });

  state.currentTurnId = turnResult.id;

  // ── 6. Persist updated state ───────────────────────────────────────────────
  await writeSessionState(payload.session_id, state);
}
