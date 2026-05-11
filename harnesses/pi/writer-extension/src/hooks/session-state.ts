/**
 * session-state.ts — In-process session state registry.
 *
 * Hooks share a single Node.js process with Pi, so a module-level Map is the
 * simplest consistent store for cross-hook state — no IPC or DB round-trips
 * needed in the hot path.
 *
 * ## Key scheme
 * Entries are keyed by session file path from `ctx.sessionManager.getSessionFile()`.
 * When Pi runs without a session file (ephemeral sessions — rare, e.g. `-p` mode),
 * EPHEMERAL_KEY is used so the map never stores `null`.
 *
 * ## Concurrency
 * Pi is single-threaded (Node.js event loop). No locking is required.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * State captured for one active Pi session, shared across all hook modules.
 */
export type SessionState = {
  /** Stable harness-level session ID (session file path or synthesized). */
  harnessSessionId: string;
  /**
   * ToTally-internal UUID returned by writer.recordSession().
   * Used as foreign key when recording turns, messages, and tool calls.
   */
  centralSessionId: string;
  /** Working directory at session start — needed for git capture at shutdown. */
  cwd: string;
  /** HEAD SHA at session start; null until async git capture resolves. */
  headShaStart: string | null;
  /** Branch name at session start; null until async git capture resolves. */
  branchStart: string | null;
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Sentinel key for ephemeral Pi sessions (no backing session file). */
export const EPHEMERAL_KEY = "~ephemeral~";

/** Module-level registry — one entry per active session. */
const registry = new Map<string, SessionState>();

function stateKey(sessionFile: string | null): string {
  return sessionFile ?? EPHEMERAL_KEY;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Register or replace a session entry. Called at session_start. */
export function setSession(
  sessionFile: string | null,
  state: SessionState,
): void {
  registry.set(stateKey(sessionFile), state);
}

/**
 * Retrieve the full session state for `sessionFile`, or undefined if not
 * registered (e.g. session_start has not yet fired for this session).
 */
export function getSession(
  sessionFile: string | null,
): SessionState | undefined {
  return registry.get(stateKey(sessionFile));
}

/**
 * Return only the centralSessionId for quick lookups by turn/message/tool hooks.
 * Returns null when the session has not been registered yet.
 */
export function getCentralSessionId(sessionFile: string | null): string | null {
  return registry.get(stateKey(sessionFile))?.centralSessionId ?? null;
}

/** Apply a partial update to an existing session entry (e.g. after git capture). */
export function patchSession(
  sessionFile: string | null,
  patch: Partial<SessionState>,
): void {
  const existing = registry.get(stateKey(sessionFile));
  if (existing != null) {
    Object.assign(existing, patch);
  }
}

/** Remove a session entry. Called at session_shutdown after final events. */
export function clearSession(sessionFile: string | null): void {
  registry.delete(stateKey(sessionFile));
}
