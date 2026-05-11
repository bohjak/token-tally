/**
 * paths.ts — Filesystem locations for per-session Claude Code writer state.
 *
 * State files track in-progress session data across hook invocations, which
 * run as separate short-lived processes. Each session gets its own JSON file
 * named by the Claude Code session ID.
 *
 * Directory: ${XDG_STATE_HOME:-~/.local/state}/token-tally/claude-code/
 */

import { join } from "node:path";
import { homedir } from "node:os";

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
 */
export function sessionStateFile(sessionId: string): string {
  return join(claudeCodeStateDir(), `${sessionId}.json`);
}
