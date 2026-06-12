/**
 * session-state.ts — Per-session state persistence for the Claude Code writer.
 *
 * Because Claude Code hook handlers run as separate short-lived processes,
 * shared mutable state must be persisted to disk between invocations. Each
 * session gets a JSON file tracking the mapping to ToTally's internal IDs,
 * turn index, transcript read position, and in-flight tool calls.
 *
 * IO is delegated to @token-tally/harness-kit's generic state-io helpers,
 * which use pid-suffixed tmp files to avoid concurrent clobbering (m7 fix).
 */

import { readJsonState, writeJsonState, deleteJsonState } from "@token-tally/harness-kit";
import { sessionStateFile } from "./paths.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Persisted state for one active Claude Code session.
 *
 * Written after every hook invocation that modifies state and read at the
 * start of every subsequent hook invocation in the same session.
 */
export type SessionState = {
  /** ToTally-internal UUID for the sessions row. */
  centralSessionId: string;

  /** Claude Code's own session identifier (used as the state file name). */
  harnessSessionId: string;

  /** Monotonically incrementing turn counter within this session. */
  turnIndex: number;

  /** ToTally-internal UUID for the currently open turn, or null between turns. */
  currentTurnId: string | null;

  /** Synthesized harness turn ID for the current turn, or null between turns. */
  currentHarnessTurnId: string | null;

  /**
   * Absolute path to the transcript file this offset is indexed against.
   * When the incoming transcript_path differs, drain.ts resets the offset to 0.
   * Null on initial state (no drain has occurred yet).
   */
  transcriptPath: string | null;

  /**
   * Number of lines consumed from the transcript JSONL so far.
   * Used as `fromLine` to avoid re-processing already-recorded entries.
   */
  transcriptOffset: number;

  /** Most recently observed model ID (carried across turns for context). */
  lastModelId: string | null;

  /** Most recently observed provider (carried across turns for context). */
  lastProvider: string | null;

  /**
   * ToTally subscriptions.id if this session is running under a flat-fee plan,
   * null otherwise.
   */
  subscriptionId: string | null;

  /**
   * Tool calls started (PreToolUse) but not yet completed (PostToolUse).
   * Keyed by the Claude Code tool_use_id.
   */
  activeTools: Record<string, { startedAt: number; toolName: string }>;
};

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Reads the state file for the given session ID.
 *
 * Returns null when:
 * - The file does not exist (ENOENT) — normal for the first hook of a session.
 * - The file exists but contains invalid JSON — logs a warning and returns null.
 */
export async function readSessionState(
  sessionId: string,
): Promise<SessionState | null> {
  return readJsonState<SessionState>(
    sessionStateFile(sessionId),
    "[claude-code-writer]",
  );
}

// ---------------------------------------------------------------------------
// Write (atomic)
// ---------------------------------------------------------------------------

/**
 * Atomically writes `state` to the session state file.
 *
 * Uses a pid-suffixed tmp file and `fs.rename` so concurrent readers never
 * observe a partial write. Creates the state directory if needed.
 */
export async function writeSessionState(
  sessionId: string,
  state: SessionState,
): Promise<void> {
  return writeJsonState(sessionStateFile(sessionId), state);
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Deletes the state file for the given session ID.
 * Silently ignores ENOENT; re-throws other errors.
 */
export async function deleteSessionState(sessionId: string): Promise<void> {
  return deleteJsonState(sessionStateFile(sessionId));
}
