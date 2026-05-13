/**
 * session-state.ts — Per-session state persistence for the Cursor writer.
 *
 * Because Cursor hook handlers run as separate short-lived processes, shared
 * mutable state must be persisted to disk between invocations. Each session
 * gets a JSON file tracking the mapping to ToTally's internal IDs, turn/
 * message/tool counters, and in-flight tool calls.
 *
 * Writes use a tmp-then-rename pattern to ensure readers never observe a
 * partial file. The directory is created on first write.
 */

import {
  readFile,
  writeFile,
  rename,
  unlink,
  mkdir,
} from "node:fs/promises";
import { dirname } from "node:path";
import { sessionStateFile } from "./paths.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Persisted state for one active Cursor session.
 *
 * Written after every hook invocation that modifies state, read at the start
 * of every subsequent hook invocation in the same session.
 *
 * Cursor-specific notes vs. Claude Code:
 * - `messageIndex` tracks assistant messages separately from turns because
 *   `afterAgentResponse` fires without a separate turn-start event.
 * - `toolIndex` provides a synthesized tool-call id when `tool_use_id` is absent.
 * - `drained` is set to true after a `stop` or `sessionEnd` event successfully
 *   attempts the transcript / state.vscdb token backfill so we don't repeat it.
 * - `lastGenerationId` detects when a new `generation_id` arrives (= new turn).
 */
export interface SessionState {
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
   * Used as fallback for harness_message_id when conversation_id or
   * generation_id is absent.
   */
  messageIndex: number;

  // ---- Tool call tracking --------------------------------------------------

  /**
   * Monotonically incrementing tool-call counter within this session.
   * Used as fallback when `tool_use_id` is absent.
   */
  toolIndex: number;

  /**
   * Tool calls that have started (preToolUse) but not yet completed
   * (postToolUse / postToolUseFailure). Keyed by the Cursor tool_use_id, or
   * by the synthesised harness tool call id when tool_use_id is absent.
   */
  activeTools: Record<string, { startedAt: number; toolName: string; harnessToolCallId: string }>;

  // ---- Model attribution ---------------------------------------------------

  /** Most recently seen model id (carried across turns as a fallback). */
  lastModelId: string | null;

  /** Most recently seen provider (e.g. "anthropic", "openai"). */
  lastProvider: string | null;

  // ---- Backfill control ----------------------------------------------------

  /**
   * True after a `stop` or `sessionEnd` event has attempted the best-effort
   * transcript / state.vscdb token backfill. Prevents double-draining when
   * both events fire in the same session.
   */
  drained: boolean;

  // ---- Subscription --------------------------------------------------------

  /**
   * ToTally subscriptions.id if this session is running under a flat-fee plan,
   * null otherwise.
   */
  subscriptionId: string | null;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Reads the state file for the given harness session id.
 *
 * Returns `null` when:
 * - The file does not exist (ENOENT) — normal for the first hook of a session.
 * - The file exists but contains invalid JSON — logs a warning and returns null
 *   so the caller can recover rather than crash.
 */
export async function readSessionState(
  harnessSessionId: string,
): Promise<SessionState | null> {
  const path = sessionStateFile(harnessSessionId);
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
      `[cursor-writer] state file for session ${harnessSessionId} contains invalid JSON; discarding`,
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
  harnessSessionId: string,
  state: SessionState,
): Promise<void> {
  const path = sessionStateFile(harnessSessionId);
  const tmp = `${path}.tmp`;

  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, JSON.stringify(state), "utf8");
  await rename(tmp, path);
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Deletes the state file for the given harness session id.
 *
 * Best-effort: silently ignores ENOENT (file already gone is fine). Other
 * errors are re-thrown so they surface as unexpected failures.
 */
export async function deleteSessionState(
  harnessSessionId: string,
): Promise<void> {
  const path = sessionStateFile(harnessSessionId);
  try {
    await unlink(path);
  } catch (err: unknown) {
    if (isEnoent(err)) return;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a fresh SessionState for a newly discovered session.
 * All counters start at 0; all optional fields are null/false.
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
    drained: false,
    subscriptionId: null,
  };
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
