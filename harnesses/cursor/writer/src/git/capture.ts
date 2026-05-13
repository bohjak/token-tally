/**
 * git/capture.ts — Best-effort git repo metadata capture for the Cursor writer.
 *
 * Identical in logic to harnesses/claude-code/writer/src/git/capture.ts.
 * Captures only what the ToTally schema stores: repoOwner, repoName, repoRemote.
 * Branch, SHA, and dirty-count are omitted (not in schema).
 *
 * Returns null outside a git repo or when git is unavailable.
 *
 * T6 owns this file and may extend it; the implementation here is intentionally
 * copied from the Claude Code writer so the package compiles before T6 runs.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
// Helpers
// ---------------------------------------------------------------------------

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

function parseRemoteOwnerName(
  remote: string,
): { owner: string; name: string } | null {
  const r = remote.trim();

  // SSH short form: git@github.com:owner/repo.git
  const sshShort = /^[\w.-]+@[\w.-]+:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(r);
  if (sshShort?.[1] && sshShort[2]) {
    return { owner: sshShort[1], name: sshShort[2] };
  }

  // HTTPS or SSH long form
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
 * Capture git repo metadata for a given working directory.
 * Returns null when cwd is not inside a git repo or git is unavailable.
 */
export async function captureRepoSnapshot(
  cwd: string,
): Promise<RepoSnapshot | null> {
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
