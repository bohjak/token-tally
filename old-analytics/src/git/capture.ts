/**
 * git/capture.ts — Pure helpers for capturing git/GitHub context.
 *
 * All functions accept an injected `ExecFn` so they can be tested without
 * spawning real processes.  No module-level state; every function is a pure
 * async computation over its arguments.
 *
 * Used by:
 *   - hooks/session.ts  (T6)  — captureRepoSnapshot at session start/shutdown
 *   - hooks/tool.ts     (T10) — getCurrentHeadSha after detected git commit
 *   - git/pr-linker.ts  (T13) — isAncestor, getDiffSummary, listOpenPrsForBranch
 *   - src/index.ts      (T15) — ExecFn adapter wrapping pi.exec
 */

// ---------------------------------------------------------------------------
// ExecFn — injectable shell abstraction
// ---------------------------------------------------------------------------

/**
 * Signature for the injected executor.
 *
 * Implementations MUST NOT reject on a non-zero exit code — they should
 * return the code in `exitCode` instead.  Rejection is reserved for truly
 * unrecoverable errors (e.g. the child process could not be spawned at all
 * due to ENOENT).  Every public function in this module wraps exec calls in
 * try/catch and treats rejections as `exitCode: 1`.
 */
export type ExecFn = (
  cmd: string,
  args: string[],
  opts?: {
    cwd?: string;
    timeout?: number;
    signal?: AbortSignal;
  },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

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
  /** Number of files with uncommitted changes at capture time. */
  dirtyCount: number;
};

export type PrInfo = {
  number: number;
  url: string;
  title: string;
};

export type CommitInfo = {
  sha: string;
  subject: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
};

export type FileChange = {
  path: string;
  insertions: number;
  deletions: number;
};

// ---------------------------------------------------------------------------
// Internal: parse owner/repo from a git remote URL
// ---------------------------------------------------------------------------

/**
 * Extract owner and repo name from a git remote URL.
 *
 * Handles the four common formats:
 *   git@github.com:owner/repo.git        (SSH short form)
 *   https://github.com/owner/repo         (HTTPS without .git suffix)
 *   https://github.com/owner/repo.git     (HTTPS with .git suffix)
 *   ssh://git@github.com/owner/repo.git   (SSH long form)
 *
 * Returns null when the URL does not match any known pattern.
 *
 * Exported for direct unit testing; not intended for external callers —
 * prefer `captureRepoSnapshot` which calls this internally.
 */
export function parseRemoteOwnerName(
  remote: string,
): { owner: string; name: string } | null {
  const r = remote.trim();

  // ── SSH short form: user@host:owner/repo[.git] ────────────────────────────
  // Character class [\w.-] matches word chars, literal dots, literal hyphens.
  const sshShort =
    /^[\w.-]+@[\w.-]+:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(r);
  if (sshShort) {
    const owner = sshShort[1];
    const name = sshShort[2];
    if (owner && name) return { owner, name };
  }

  // ── HTTPS or SSH long form: scheme://host/owner/repo[.git] ───────────────
  const httpOrSsh =
    /^(?:https?|ssh):\/\/[^/]+\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(r);
  if (httpOrSsh) {
    const owner = httpOrSsh[1];
    const name = httpOrSsh[2];
    if (owner && name) return { owner, name };
  }

  return null;
}

// ---------------------------------------------------------------------------
// captureRepoSnapshot
// ---------------------------------------------------------------------------

/**
 * Capture the current git repository state by running five git commands in
 * parallel.  Returns null if `cwd` is not inside a git repo, or if the repo
 * has no commits yet (no HEAD SHA).
 *
 * Partial failures (e.g. no remote configured) are tolerated — those fields
 * will be null in the returned snapshot.
 */
export async function captureRepoSnapshot(
  exec: ExecFn,
  cwd: string,
): Promise<RepoSnapshot | null> {
  // Wrap each call so a rejection doesn't abort the parallel set.
  const safe = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

  const [rootR, remoteR, branchR, shaR, statusR] = await Promise.all([
    safe(exec("git", ["rev-parse", "--show-toplevel"], { cwd })),
    safe(exec("git", ["config", "--get", "remote.origin.url"], { cwd })),
    safe(exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd })),
    safe(exec("git", ["rev-parse", "HEAD"], { cwd })),
    safe(exec("git", ["status", "--porcelain"], { cwd })),
  ]);

  // Non-zero exit from rev-parse --show-toplevel means we are not in a git repo.
  if (!rootR || rootR.exitCode !== 0) return null;
  const repoRoot = rootR.stdout.trim();
  if (!repoRoot) return null;

  // No HEAD SHA means an empty repo (0 commits) — not worth recording.
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

  // Count non-blank lines in `git status --porcelain`.
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

// ---------------------------------------------------------------------------
// fetchPrForBranch
// ---------------------------------------------------------------------------

/**
 * Fetch the open PR for `branch` via `gh pr view`.
 *
 * Returns null when:
 *   - `gh` is not installed (ENOENT / non-zero exit)
 *   - No PR exists for the branch
 *   - The JSON response is malformed
 *   - The call exceeds `timeoutMs`
 *
 * The timeout is implemented with `Promise.race` so it fires even if the
 * injected `ExecFn` does not honour the `AbortSignal`.
 */
export async function fetchPrForBranch(
  exec: ExecFn,
  cwd: string,
  branch: string,
  timeoutMs: number,
): Promise<PrInfo | null> {
  const controller = new AbortController();

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error("gh pr view timed out"));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([
      exec("gh", ["pr", "view", branch, "--json", "number,url,title"], {
        cwd,
        signal: controller.signal,
      }),
      deadline,
    ]);

    if (result.exitCode !== 0) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return null;
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).number !== "number"
    ) {
      return null;
    }

    return parsed as PrInfo;
  } catch {
    // Covers: timeout rejection, AbortError, any exec rejection.
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// listOpenPrsForBranch
// ---------------------------------------------------------------------------

/**
 * List all open PRs whose head branch matches `branch` via `gh pr list`.
 * Returns an empty array on any error or timeout.
 */
export async function listOpenPrsForBranch(
  exec: ExecFn,
  cwd: string,
  branch: string,
  timeoutMs: number,
): Promise<PrInfo[]> {
  const controller = new AbortController();

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error("gh pr list timed out"));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([
      exec(
        "gh",
        [
          "pr",
          "list",
          "--head",
          branch,
          "--state",
          "open",
          "--json",
          "number,url,title",
        ],
        { cwd, signal: controller.signal },
      ),
      deadline,
    ]);

    if (result.exitCode !== 0) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return [];
    }

    if (!Array.isArray(parsed)) return [];
    return parsed as PrInfo[];
  } catch {
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// getCurrentHeadSha
// ---------------------------------------------------------------------------

/**
 * Return the current HEAD commit SHA, or null if unavailable (e.g. empty
 * repo, not a git directory, exec failure).
 */
export async function getCurrentHeadSha(
  exec: ExecFn,
  cwd: string,
): Promise<string | null> {
  try {
    const result = await exec("git", ["rev-parse", "HEAD"], { cwd });
    if (result.exitCode !== 0) return null;
    const sha = result.stdout.trim();
    return sha || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// getDiffSummary
// ---------------------------------------------------------------------------

/**
 * Return structured commit and file-change data for `fromSha..toSha`.
 *
 * Runs `git log --numstat` with a custom record-separator prefix so the
 * output can be parsed into per-commit blocks without ambiguity.
 *
 * Expected output shape (one block per commit, newest first):
 *
 *   COMMIT_SEP|<sha>|<subject>
 *   <blank line>
 *   <ins>\t<del>\t<path>
 *   ...
 *   <blank line>
 *   COMMIT_SEP|...
 *
 * Binary files: git emits `-\t-\t<path>`; these count toward `filesChanged`
 * but contribute 0 to insertions/deletions.
 *
 * The returned `files` array is deduplicated across commits: when the same
 * path appears in multiple commits its insertions/deletions are summed.
 */
export async function getDiffSummary(
  exec: ExecFn,
  cwd: string,
  fromSha: string,
  toSha: string,
): Promise<{ commits: CommitInfo[]; files: FileChange[] }> {
  const SEP = "COMMIT_SEP";
  const range = `${fromSha}..${toSha}`;

  let result: { stdout: string; exitCode: number; stderr: string };
  try {
    result = await exec(
      "git",
      ["log", "--numstat", `--pretty=tformat:${SEP}|%H|%s`, range],
      { cwd },
    );
  } catch {
    return { commits: [], files: [] };
  }

  if (result.exitCode !== 0 || !result.stdout.trim()) {
    return { commits: [], files: [] };
  }

  const commits: CommitInfo[] = [];
  const allFileEntries: FileChange[] = []; // collects across all commits before dedup

  let currentSha: string | null = null;
  let currentSubject = "";
  let currentFiles: FileChange[] = [];
  let currentInsertions = 0;
  let currentDeletions = 0;
  let currentFilesChanged = 0;

  function flushCommit(): void {
    if (!currentSha) return;
    commits.push({
      sha: currentSha,
      subject: currentSubject,
      filesChanged: currentFilesChanged,
      insertions: currentInsertions,
      deletions: currentDeletions,
    });
    allFileEntries.push(...currentFiles);
    // Reset accumulators.
    currentSha = null;
    currentSubject = "";
    currentFiles = [];
    currentInsertions = 0;
    currentDeletions = 0;
    currentFilesChanged = 0;
  }

  for (const line of result.stdout.split("\n")) {
    if (line.startsWith(`${SEP}|`)) {
      flushCommit();
      // Format: "COMMIT_SEP|<sha>|<subject>"
      // Subject may itself contain "|", so only split on the first pipe after SEP.
      const rest = line.slice(SEP.length + 1);
      const pipeIdx = rest.indexOf("|");
      if (pipeIdx === -1) {
        currentSha = rest;
        currentSubject = "";
      } else {
        currentSha = rest.slice(0, pipeIdx);
        currentSubject = rest.slice(pipeIdx + 1);
      }
    } else if (line.trim() === "") {
      // Blank lines separate the format line from numstat lines, and commits
      // from one another.  We skip them.
    } else {
      // numstat line: "<insertions>\t<deletions>\t<path>"
      // Binary files:  "-\t-\t<path>"
      const tabIdx1 = line.indexOf("\t");
      const tabIdx2 = line.indexOf("\t", tabIdx1 + 1);
      if (tabIdx1 !== -1 && tabIdx2 !== -1) {
        const insStr = line.slice(0, tabIdx1);
        const delStr = line.slice(tabIdx1 + 1, tabIdx2);
        const path = line.slice(tabIdx2 + 1);

        const insertions = insStr === "-" ? 0 : (parseInt(insStr, 10) || 0);
        const deletions = delStr === "-" ? 0 : (parseInt(delStr, 10) || 0);

        currentInsertions += insertions;
        currentDeletions += deletions;
        currentFilesChanged++;
        currentFiles.push({ path, insertions, deletions });
      }
    }
  }

  flushCommit();

  // Deduplicate `files` across commits: same path → sum ins/del.
  const fileMap = new Map<string, FileChange>();
  for (const f of allFileEntries) {
    const existing = fileMap.get(f.path);
    if (existing) {
      existing.insertions += f.insertions;
      existing.deletions += f.deletions;
    } else {
      fileMap.set(f.path, { ...f });
    }
  }

  return {
    commits,
    files: Array.from(fileMap.values()),
  };
}

// ---------------------------------------------------------------------------
// isAncestor
// ---------------------------------------------------------------------------

/**
 * Return true if `ancestor` is a reachable ancestor of `descendant` (or is
 * the same commit — git considers a commit its own ancestor).
 *
 * Uses `git merge-base --is-ancestor` whose exit code encodes the answer:
 *   0 → true, 1 → false.
 *
 * Returns false on any error (e.g. unknown SHA, not a git repo).
 */
export async function isAncestor(
  exec: ExecFn,
  cwd: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    const result = await exec(
      "git",
      ["merge-base", "--is-ancestor", ancestor, descendant],
      { cwd },
    );
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
