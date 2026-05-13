/**
 * paths.ts — Filesystem locations for per-session Cursor writer state.
 *
 * State files track in-progress session data across hook invocations, which
 * run as separate short-lived processes. Each session gets its own JSON file
 * named by the Cursor harness session id (conversation_id or session_id).
 *
 * Directory: ${XDG_STATE_HOME:-~/.local/state}/token-tally/cursor/
 */

import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Returns the directory where per-session Cursor writer state files are stored.
 * Respects XDG_STATE_HOME; falls back to ~/.local/state.
 */
export function cursorStateDir(): string {
  const base =
    process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state");
  return join(base, "token-tally", "cursor");
}

/**
 * Returns the full path for a specific session's state file.
 *
 * @param harnessSessionId  The Cursor harness session id (conversation_id ?? session_id).
 */
export function sessionStateFile(harnessSessionId: string): string {
  return join(cursorStateDir(), `${harnessSessionId}.json`);
}
