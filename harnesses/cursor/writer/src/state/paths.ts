/**
 * paths.ts — Filesystem locations for per-session Cursor writer state.
 *
 * Directory: ${XDG_STATE_HOME:-~/.local/state}/token-tally/cursor/
 *
 * Session IDs are sanitized via sanitizeIdForFilename to prevent path
 * traversal when raw harness IDs contain slashes or other unsafe chars (m6).
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { sanitizeIdForFilename } from "@token-tally/harness-kit";

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
 * The harness session id is sanitized before use as a filename component
 * to prevent path traversal when raw IDs contain slashes or other unsafe chars.
 */
export function sessionStateFile(harnessSessionId: string): string {
  return join(cursorStateDir(), `${sanitizeIdForFilename(harnessSessionId)}.json`);
}
