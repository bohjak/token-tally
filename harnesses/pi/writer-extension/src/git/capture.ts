/**
 * git/capture.ts — Pure helpers for capturing git context at session boundaries.
 *
 * All functions accept an injected ExecFn so they are testable without spawning
 * real processes. No module-level state; every function is a pure async
 * computation over its arguments.
 *
 * Adapted from ~/.pi/agent/extensions/analytics/src/git/capture.ts.
 */

import type { ExecFn } from "../hooks/types.ts";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type RepoSnapshot = {
  repoRoot: string;
  repoRemote: string | null;
  repoOwner: string | null;
  repoName: string | null;
  branch: string;
  headSha: string;
  dirtyCount: number;
};

// ---------------------------------------------------------------------------
// Internal: parse owner/repo from a git remote URL
// ---------------------------------------------------------------------------

/**
 * Extract owner and repo name from a git remote URL.
 * Handles SSH short form, HTTPS, and SSH long form.
 */
function parseRemoteOwnerName(
  remote: string,
): { owner: string; name: string } | null {
  const r = remote.trim();

  const sshShort = /^[\w.-]+@[\w.-]+:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(r);
  if (sshShort?.[1] && sshShort[2]) {
    return { owner: sshShort[1], name: sshShort[2] };
  }

  const httpOrSsh =
    /^(?:https?|ssh):\/\/[^/]+\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(r);
  if (httpOrSsh?.[1] && httpOrSsh[2]) {
    return { owner: httpOrSsh[1], name: httpOrSsh[2] };
  }

  return null;
}

// ---------------------------------------------------------------------------
// captureRepoSnapshot
// ---------------------------------------------------------------------------

/**
 * Capture the current git repository state.
 * Returns null if `cwd` is not inside a git repo, or if the repo has no commits.
 * Partial failures (e.g. no remote) are tolerated — those fields will be null.
 */
export async function captureRepoSnapshot(
  exec: ExecFn,
  cwd: string,
): Promise<RepoSnapshot | null> {
  const safe = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

  const [rootR, remoteR, branchR, shaR, statusR] = await Promise.all([
    safe(exec("git", ["rev-parse", "--show-toplevel"], { cwd })),
    safe(exec("git", ["config", "--get", "remote.origin.url"], { cwd })),
    safe(exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd })),
    safe(exec("git", ["rev-parse", "HEAD"], { cwd })),
    safe(exec("git", ["status", "--porcelain"], { cwd })),
  ]);

  if (!rootR || rootR.exitCode !== 0) return null;
  const repoRoot = rootR.stdout.trim();
  if (!repoRoot) return null;

  const headSha = shaR?.exitCode === 0 ? shaR.stdout.trim() : "";
  if (!headSha) return null;

  const branch =
    branchR?.exitCode === 0 && branchR.stdout.trim()
      ? branchR.stdout.trim()
      : "HEAD";

  const repoRemote =
    remoteR?.exitCode === 0 && remoteR.stdout.trim()
      ? remoteR.stdout.trim()
      : null;

  const parsed = repoRemote ? parseRemoteOwnerName(repoRemote) : null;

  const dirtyCount =
    statusR?.exitCode === 0
      ? statusR.stdout.split("\n").filter((l) => l.trim().length > 0).length
      : 0;

  return {
    repoRoot,
    repoRemote,
    repoOwner: parsed?.owner ?? null,
    repoName: parsed?.name ?? null,
    branch,
    headSha,
    dirtyCount,
  };
}
