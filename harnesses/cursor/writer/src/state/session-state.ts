/**
 * session-state.ts — Per-session state persistence for the Cursor writer.
 *
 * Because Cursor hook handlers run as separate short-lived processes, shared
 * mutable state must be persisted to disk between invocations. Each session
 * gets a JSON file tracking the mapping to ToTally's internal IDs, turn/
 * message/tool counters, and in-flight tool calls.
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
 * Persisted state for one active Cursor session.
 *
 * Written after every hook invocation that modifies state, read at the start
 * of every subsequent hook invocation in the same session.
 */
export type SessionState = {
  // ---- ToTally-internal IDs -----------------------------------------------

  /** UUID of the sessions row in ToTally's central store. */
  centralSessionId: string;

  /**
   * The Cursor harness session id: `conversation_id ?? session_id` from the
   * first event seen for this session.
   */
  harnessSessionId: string;

  // ---- Turn tracking -------------------------------------------------------

  /**
   * Monotonically incrementing turn counter within this session.
   * Used as a fallback when `generation_id` is absent.
   */
  turnIndex: number;

  /** UUID of the currently open turn row in ToTally's store, or null. */
  currentTurnId: string | null;

  /**
   * The harness turn id for the current turn (generation_id, or synthesised
   * `<sessionId>:t<turnIndex>`), or null when no turn is open.
   */
  currentHarnessTurnId: string | null;

  /**
   * The most recent `generation_id` seen, used to detect when a new turn
   * starts (= generation_id changes).
   */
  lastGenerationId: string | null;

  // ---- Message tracking ----------------------------------------------------

  /**
   * Monotonically incrementing message counter within this session.
   * Fallback for harness_message_id when conversation_id or generation_id
   * is absent.
   */
  messageIndex: number;

  // ---- Tool call tracking --------------------------------------------------

  /** Monotonically incrementing tool-call counter within this session. */
  toolIndex: number;

  /**
   * Tool calls that have started (preToolUse) but not yet completed.
   * Keyed by Cursor tool_use_id, or by the synthesised harness tool call id.
   */
  activeTools: Record<string, { startedAt: number; toolName: string; harnessToolCallId: string }>;

  // ---- Model attribution ---------------------------------------------------

  /** Most recently seen model id (carried across turns as a fallback). */
  lastModelId: string | null;

  /** Most recently seen provider (e.g. "anthropic", "openai"). */
  lastProvider: string | null;

  // ---- Backfill control ----------------------------------------------------

  /**
   * Harness message IDs written by `afterAgentResponse` not yet backfilled.
   * Populated by afterAgentResponse; consumed by `runBackfill` in stop/sessionEnd.
   */
  pendingHarnessMessageIds: string[];

  // ---- Subscription --------------------------------------------------------

  /**
   * ToTally subscriptions.id if this session is running under a flat-fee plan,
   * null otherwise.
   */
  subscriptionId: string | null;
};

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Reads the state file for the given harness session id.
 *
 * Returns null when:
 * - The file does not exist (ENOENT) — normal for the first hook of a session.
 * - The file contains invalid JSON — logs a warning and returns null.
 */
export async function readSessionState(
  harnessSessionId: string,
): Promise<SessionState | null> {
  return readJsonState<SessionState>(
    sessionStateFile(harnessSessionId),
    "[cursor-writer]",
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
  harnessSessionId: string,
  state: SessionState,
): Promise<void> {
  return writeJsonState(sessionStateFile(harnessSessionId), state);
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Deletes the state file for the given harness session id.
 * Silently ignores ENOENT; re-throws other errors.
 */
export async function deleteSessionState(
  harnessSessionId: string,
): Promise<void> {
  return deleteJsonState(sessionStateFile(harnessSessionId));
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a fresh SessionState for a newly discovered session.
 * All counters start at 0; all optional fields are null/false/empty.
 */
export function makeInitialSessionState(
  centralSessionId: string,
  harnessSessionId: string,
): SessionState {
  return {
    centralSessionId,
    harnessSessionId,
    turnIndex: 0,
    currentTurnId: null,
    currentHarnessTurnId: null,
    lastGenerationId: null,
    messageIndex: 0,
    toolIndex: 0,
    activeTools: {},
    lastModelId: null,
    lastProvider: null,
    pendingHarnessMessageIds: [],
    subscriptionId: null,
  };
}
