/**
 * Git metadata resolution for the Pi session log importer.
 *
 * Resolves repo remote URL, owner, and name from a cwd path.
 * Uses `git remote get-url origin` via execSync (no injected ExecFn needed;
 * the harness package's git/capture.ts is a different workspace package).
 *
 * Credentials are stripped via redactRemoteUrl before storage.
 */

import { execSync } from "child_process";
import { redactRemoteUrl } from "../../util";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GitMetadata {
  repoRemote: string | null;
  repoOwner: string | null;
  repoName: string | null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolves git metadata for the given `cwd`.
 * Returns null for all fields if the directory is not a git repo or if
 * `git` is not available.
 */
export function resolveGitMetadata(cwd: string): GitMetadata {
  let remote: string;
  try {
    remote = execSync("git remote get-url origin", {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    }).trim();
  } catch {
    return { repoRemote: null, repoOwner: null, repoName: null };
  }

  if (!remote) return { repoRemote: null, repoOwner: null, repoName: null };

  const redacted = redactRemoteUrl(remote);
  const { owner, name } = parseRemoteOwnerAndName(redacted);

  return { repoRemote: redacted, repoOwner: owner, repoName: name };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseRemoteOwnerAndName(
  remote: string,
): { owner: string | null; name: string | null } {
  // HTTPS: https://github.com/owner/repo.git
  try {
    const url = new URL(remote);
    const parts = url.pathname.replace(/^\//, "").replace(/\.git$/, "").split("/");
    if (parts.length >= 2 && parts[0] !== "" && parts[1] !== "") {
      return { owner: parts[0], name: parts[1] };
    }
  } catch {
    // Not a valid HTTPS URL.
  }

  // SSH short form: git@github.com:owner/repo.git
  const sshMatch = /^[^@]+@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/.exec(remote);
  if (sshMatch != null) {
    return { owner: sshMatch[1], name: sshMatch[2] };
  }

  return { owner: null, name: null };
}
