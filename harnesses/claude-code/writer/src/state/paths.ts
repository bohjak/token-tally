/**
 * paths.ts — Filesystem locations for per-session Claude Code writer state.
 *
 * Directory: ${XDG_STATE_HOME:-~/.local/state}/token-tally/claude-code/
 *
 * Session IDs are sanitized via sanitizeIdForFilename to prevent path
 * traversal when raw harness IDs contain slashes or other unsafe chars (m6).
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { sanitizeIdForFilename } from "@token-tally/harness-kit";

/**
 * Returns the directory where per-session state files are stored.
 * Respects XDG_STATE_HOME; falls back to ~/.local/state.
 */
export function claudeCodeStateDir(): string {
  const base = process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state");
  return join(base, "token-tally", "claude-code");
}

/**
 * Returns the full path for a specific session's state file.
 *
 * The session ID is sanitized before use as a filename component to prevent
 * path traversal when raw harness IDs contain slashes or other unsafe chars.
 */
export function sessionStateFile(sessionId: string): string {
  return join(claudeCodeStateDir(), `${sanitizeIdForFilename(sessionId)}.json`);
}
