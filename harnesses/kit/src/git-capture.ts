/**
 * git-capture.ts — Best-effort git repo metadata capture.
 *
 * Replaces two verbatim copies in harnesses/claude-code/writer/src/git/capture.ts
 * and harnesses/cursor/writer/src/git/capture.ts.
 *
 * The `ExecFn` parameter is injected rather than hard-coded so unit tests can
 * stub git without spawning real processes. Default callers pass no ExecFn
 * and get the real execFile-based implementation.
 *
 * Captures only what the ToTally schema stores: repoOwner, repoName,
 * repoRemote. Branch, SHA, and dirty-count are omitted (not in schema).
 * Returns null outside a git repo or when git is unavailable.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Executes a command in the given working directory with a hard timeout.
 * Returns stdout as a trimmed string on success, null on any error.
 *
 * The injectable form allows tests to stub git without spawning processes.
 */
export type ExecFn = (
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
) => Promise<string | null>;

export type RepoSnapshot = {
  repoOwner: string | null;
  repoName: string | null;
  repoRemote: string | null; // credential-redacted
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Default ExecFn backed by node:child_process.execFile.
 */
const defaultExec: ExecFn = async (cmd, args, cwd, timeoutMs) => {
  try {
    const { stdout } = await execFileAsync(cmd, args, { cwd, timeout: timeoutMs });
    return stdout.trim() || null;
  } catch {
    return null;
  }
};

/**
 * Strip embedded credentials from HTTP/HTTPS remote URLs.
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

/** Timeout for each git subprocess (ms). */
export const GIT_TIMEOUT_MS = 5_000;

/**
 * Capture the git repo metadata for a given working directory.
 *
 * @param cwd  - Directory to inspect.
 * @param exec - Optional exec function; defaults to the real execFile wrapper.
 *               Inject a stub in tests to avoid spawning real git processes.
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
  exec: ExecFn = defaultExec,
): Promise<RepoSnapshot | null> {
  // A non-null root confirms we're inside a git repo (and git is on PATH).
  const root = await exec("git", ["rev-parse", "--show-toplevel"], cwd, GIT_TIMEOUT_MS);
  if (root === null) return null;

  const rawRemote = await exec("git", ["config", "--get", "remote.origin.url"], cwd, GIT_TIMEOUT_MS);
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
