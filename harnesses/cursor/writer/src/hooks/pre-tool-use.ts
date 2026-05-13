/**
 * hooks/pre-tool-use.ts — Handler for the Cursor preToolUse event.
 *
 * Fires before any tool executes. We buffer the in-flight tool call into
 * session state so that post-tool-use.ts / post-tool-use-failure.ts can
 * record the complete entry (with start time and error flag) once Cursor
 * reports the outcome.
 *
 * No database write happens here — only state file I/O.
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
 * Handle a preToolUse event.
 *
 * Buffers `{ startedAt, toolName, harnessToolCallId }` into
 * `state.activeTools`, keyed by the stable tool_use_id (or a synthesized key
 * when tool_use_id is absent). Replays/duplicates overwrite the entry.
 */
export async function handle(
  _writer: AnalyticsWriter,
  payload: Extract<HookPayload, { hook_event_name: "preToolUse" }>,
): Promise<void> {
  // ── 1. Derive harness session id ─────────────────────────────────────────
  const harnessSessionId = extractHarnessSessionId(payload);
  if (harnessSessionId === undefined) {
    console.warn(
      "[cursor-writer] preToolUse: no conversation_id in payload — ignoring",
    );
    return;
  }

  // ── 2. Load state ─────────────────────────────────────────────────────────
  const state = await readSessionState(harnessSessionId);
  if (state === null) {
    console.warn(
      "[cursor-writer] preToolUse: no state for session",
      harnessSessionId,
      "— skipping tool buffering",
    );
    return;
  }

  // ── 3. Compute a stable key ───────────────────────────────────────────────
  // Use tool_use_id as the key when present (Cursor provides it on the
  // majority of tool events). Fall back to a synthesized key using toolIndex.
  const harnessToolCallId = computeHarnessToolCallId(
    payload.tool_use_id,
    harnessSessionId,
    state.toolIndex,
  );

  // Increment toolIndex when synthesizing so the next synthesized ID differs.
  // When tool_use_id is present we still increment to keep the counter
  // predictable (it only matters for synthesis).
  state.toolIndex += 1;

  // The active-tools map key is the canonical harness tool call id.
  state.activeTools[harnessToolCallId] = {
    startedAt: Date.now(),
    toolName: payload.tool_name ?? "unknown",
    harnessToolCallId,
  };

  // ── 4. Persist state ──────────────────────────────────────────────────────
  await writeSessionState(harnessSessionId, state);
}
