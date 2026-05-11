/**
 * session-state.ts — Per-session state persistence for the Claude Code writer.
 *
 * Because Claude Code hook handlers run as separate short-lived processes,
 * shared mutable state must be persisted to disk between invocations. Each
 * session gets a JSON file tracking the mapping to ToTally's internal IDs,
 * turn index, transcript read position, and in-flight tool calls.
 *
 * Writes use a tmp-then-rename pattern to ensure readers never observe a
 * partial file.
 */

import { readFile, writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { sessionStateFile } from "./paths.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Persisted state for one active Claude Code session.
 *
 * This is written after every hook invocation that modifies state and read
 * at the start of every subsequent hook invocation in the same session.
 */
export interface SessionState {
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
   * Number of lines consumed from the transcript JSONL so far.
   * Used as the `fromLine` argument to `readTranscriptFrom` to avoid
   * re-processing entries already recorded.
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
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Reads the state file for the given session ID.
 *
 * Returns `null` when:
 * - The file does not exist (ENOENT) — normal for the first hook of a session.
 * - The file exists but contains invalid JSON — logs a warning and returns null
 *   so the caller can recover rather than crash.
 */
export async function readSessionState(
  sessionId: string,
): Promise<SessionState | null> {
  const path = sessionStateFile(sessionId);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err: unknown) {
    if (isEnoent(err)) return null;
    throw err;
  }

  try {
    return JSON.parse(raw) as SessionState;
  } catch {
    console.warn(
      `[claude-code-writer] state file for session ${sessionId} contains invalid JSON; discarding`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Write (atomic)
// ---------------------------------------------------------------------------

/**
 * Atomically writes `state` to the session state file.
 *
 * Uses a `.tmp` intermediate file and `fs.rename` so concurrent readers never
 * observe a partial write. Creates the state directory if it does not exist.
 */
export async function writeSessionState(
  sessionId: string,
  state: SessionState,
): Promise<void> {
  const path = sessionStateFile(sessionId);
  const tmp = `${path}.tmp`;

  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, JSON.stringify(state), "utf8");
  await rename(tmp, path);
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Deletes the state file for the given session ID.
 *
 * Best-effort: silently ignores ENOENT (file already gone is fine). Other
 * errors are re-thrown so they surface as unexpected failures.
 */
export async function deleteSessionState(sessionId: string): Promise<void> {
  const path = sessionStateFile(sessionId);
  try {
    await unlink(path);
  } catch (err: unknown) {
    if (isEnoent(err)) return;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}
