/**
 * git/capture.ts — Best-effort git repo metadata capture for the Claude Code writer.
 *
 * Unlike the Pi writer, which uses an injected ExecFn, this module uses
 * node:child_process.execFile directly. Claude Code's hook process has no
 * harness exec wrapper to inject.
 *
 * Only captures what the ToTally schema stores: repoOwner, repoName, repoRemote.
 * Branch, SHA, and dirty-count are omitted (not in schema).
 *
 * Returns null outside a git repo or when git is unavailable.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Timeout for each git subprocess (ms).
const GIT_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RepoSnapshot {
  repoOwner: string | null;
  repoName: string | null;
  repoRemote: string | null; // credential-redacted
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Run a git command in `cwd` with a hard timeout.
 * Returns stdout on success, null on any error (non-zero exit, timeout, ENOENT).
 */
async function git(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Strip embedded credentials from HTTP/HTTPS remote URLs before storage.
 * SSH remotes (git@host:path) are returned unchanged.
 *
 * Examples:
 *   "https://user:token@github.com/owner/repo.git" → "https://github.com/owner/repo.git"
 *   "git@github.com:owner/repo.git"               → unchanged
 */
function redactRemoteUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      (parsed.username !== "" || parsed.password !== "")
    ) {
      parsed.username = "";
      parsed.password = "";
      return parsed.toString();
    }
  } catch {
    // Not a parseable URL (e.g. SSH short form); return as-is.
  }
  return url;
}

/**
 * Extract owner and repo name from a git remote URL.
 * Handles SSH short form, HTTPS, and SSH long form.
 */
function parseRemoteOwnerName(
  remote: string,
): { owner: string; name: string } | null {
  const r = remote.trim();

  // SSH short form: git@github.com:owner/repo.git
  const sshShort = /^[\w.-]+@[\w.-]+:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(r);
  if (sshShort?.[1] && sshShort[2]) {
    return { owner: sshShort[1], name: sshShort[2] };
  }

  // HTTPS or SSH long form: https://github.com/owner/repo.git
  const httpOrSsh =
    /^(?:https?|ssh):\/\/[^/]+\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(r);
  if (httpOrSsh?.[1] && httpOrSsh[2]) {
    return { owner: httpOrSsh[1], name: httpOrSsh[2] };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Capture the git repo metadata for a given working directory.
 *
 * Returns null when:
 * - `cwd` is not inside a git repo (git rev-parse fails)
 * - git is not available on PATH
 *
 * Partial failures (no remote configured) are tolerated — those fields
 * will be null.
 */
export async function captureRepoSnapshot(
  cwd: string,
): Promise<RepoSnapshot | null> {
  // A non-null root confirms we're inside a git repo (and git is on PATH).
  const root = await git(["rev-parse", "--show-toplevel"], cwd);
  if (root === null) return null;

  const rawRemote = await git(["config", "--get", "remote.origin.url"], cwd);
  if (rawRemote === null) {
    return { repoOwner: null, repoName: null, repoRemote: null };
  }

  const repoRemote = redactRemoteUrl(rawRemote);
  const parsed = parseRemoteOwnerName(repoRemote);

  return {
    repoOwner: parsed?.owner ?? null,
    repoName: parsed?.name ?? null,
    repoRemote,
  };
}
