/**
 * git/pr-linker.ts — T13: Multi-session → PR association reconciler.
 *
 * Implements the five heuristics from PLAN.md §Multi-session → PR linking:
 *
 *   1. commit-in-pr     (1.0) — a commit SHA from this session is in the PR
 *   2. ancestor-of-pr   (0.9) — session.head_sha_end is ancestor of PR head SHA
 *   3. branch-match     (0.8) — session's branch_end or a transition target
 *                               equals the PR's head branch
 *   4. files-overlap    (0.5) — ≥50% of session files_touched overlap PR files;
 *                               evaluated against both existing candidates AND all
 *                               currently-open PRs (independent discovery path)
 *   5. preceding-window (0.3) — same repo, within `precedingWindowMs` before a
 *                               session that already has a ≥0.8 link
 *
 * Per-PR, only the highest confidence is kept.  Persistence is idempotent:
 * `upsertPrAssociation` on conflict only upgrades confidence, never downgrades.
 *
 * All exec calls are wrapped in try/catch; errors are logged via console.warn
 * and never propagate to callers.
 */

import type { SqliteSink, PrAssociationRow } from "../sinks/sqlite.ts";
import type { ExecFn, PrInfo } from "./capture.ts";
import { isAncestor, listOpenPrsForBranch } from "./capture.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PrLinkerOpts {
  /** How far back (ms) to look for preceding-window sessions. Default 24 h. */
  precedingWindowMs?: number;
  /** Timeout (ms) for each `gh` CLI call. Default 5000 ms. */
  ghTimeoutMs?: number;
  /**
   * Working directory for exec calls when no per-session cwd is available.
   * Defaults to `process.cwd()`.
   */
  cwd?: string;
}

// ---------------------------------------------------------------------------
// Internal shapes returned by `gh` JSON output
// ---------------------------------------------------------------------------

type GhPrRef = {
  number: number;
  url: string;
  /** Head-branch name — may be empty string when reconstructed from non-branch sources. */
  headRefName: string;
};

type GhPrDetail = {
  headRefOid?: string;
  files?: Array<{ path: string }>;
};

function parseGhJson(stdout: string): unknown | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// PrLinker
// ---------------------------------------------------------------------------

export class PrLinker {
  private sink: SqliteSink;
  private exec: ExecFn;
  private precedingWindowMs: number;
  private ghTimeoutMs: number;
  private cwd: string;

  constructor(sink: SqliteSink, exec: ExecFn, opts?: PrLinkerOpts) {
    this.sink = sink;
    this.exec = exec;
    this.precedingWindowMs = opts?.precedingWindowMs ?? 24 * 60 * 60 * 1000;
    this.ghTimeoutMs = opts?.ghTimeoutMs ?? 5_000;
    this.cwd = opts?.cwd ?? process.cwd();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Eager: evaluate all heuristics for a single session and persist any new
   * or improved associations to `pr_associations`.
   */
  async linkSession(sessionId: string): Promise<void> {
    const session = this.sink.getSessionById(sessionId);
    if (!session) return;

    const cwd = session.cwd ?? this.cwd;
    const commits = this.sink.getCommitsForSession(sessionId);
    const filesTouched = this.sink.getFilesTouchedForSession(sessionId);
    const sessionFiles = new Set(filesTouched.map((f) => f.path));

    // Accumulate the best (confidence, reason) per pr_number.
    const candidates = new Map<
      number,
      { pr: GhPrRef; confidence: number; reason: string }
    >();

    /** Keeps only the highest confidence per PR. */
    const bump = (pr: GhPrRef, confidence: number, reason: string) => {
      const existing = candidates.get(pr.number);
      if (!existing || existing.confidence < confidence) {
        candidates.set(pr.number, { pr, confidence, reason });
      }
    };

    // ── 1. commit-in-pr (1.0) ─────────────────────────────────────────────
    for (const commit of commits) {
      if (!commit.sha) continue;
      for (const pr of await this.searchPrsByCommit(commit.sha, cwd)) {
        bump(pr, 1.0, "commit-in-pr");
      }
    }

    // ── 3. branch-match (0.8) ─────────────────────────────────────────────
    // Collected before ancestor-of-pr so we have a full candidate set first.
    const branches = new Set<string>();
    if (session.branch_end) branches.add(session.branch_end);
    for (const t of this.getBranchTransitions(sessionId)) {
      if (t.to_branch) branches.add(t.to_branch);
    }
    for (const branch of branches) {
      for (const pr of await this.safeListOpenPrs(branch, cwd)) {
        bump(
          { number: pr.number, url: pr.url, headRefName: branch },
          0.8,
          "branch-match",
        );
      }
    }

    // ── 2. ancestor-of-pr (0.9) ───────────────────────────────────────────
    if (session.head_sha_end) {
      for (const [prNum, cand] of candidates) {
        if (cand.confidence >= 0.9) continue;
        const detail = await this.getPrDetail(prNum, session.repo_remote, cwd);
        if (detail?.headRefOid) {
          const ok = await this.safeIsAncestor(
            session.head_sha_end,
            detail.headRefOid,
            cwd,
          );
          if (ok) bump(cand.pr, 0.9, "ancestor-of-pr");
        }
      }
    }

    // ── 4. files-overlap ≥50% (0.5) ───────────────────────────────────────
    if (sessionFiles.size > 0) {
      // a) Upgrade any low-confidence candidate whose PR has ≥50% file overlap.
      for (const [prNum, cand] of candidates) {
        if (cand.confidence >= 0.5) continue;
        const detail = await this.getPrDetail(prNum, session.repo_remote, cwd);
        if (this.fileOverlap(sessionFiles, detail) >= 0.5) {
          bump(cand.pr, 0.5, "files-overlap");
        }
      }

      // b) Independent discovery: check all currently-open PRs for the repo.
      //    This surfaces PRs that weren't found via commit-search or branch-match.
      for (const pr of await this.listAllOpenPrs(cwd)) {
        if (candidates.has(pr.number)) continue; // already handled above
        const detail = await this.getPrDetail(pr.number, session.repo_remote, cwd);
        if (this.fileOverlap(sessionFiles, detail) >= 0.5) {
          bump(
            { number: pr.number, url: pr.url, headRefName: "" },
            0.5,
            "files-overlap",
          );
        }
      }
    }

    // ── 5. preceding-window (0.3) ─────────────────────────────────────────
    // Find sessions in the same repo that started within `precedingWindowMs`
    // *after* this session and have a strong (≥0.8) PR link.  Credit this
    // session with a 0.3 link to the same PRs, capturing planning/research
    // sessions that precede the implementation.
    if (session.repo_remote) {
      const linkedAfter = this.findLinkedSessionsAfterTs(
        session.repo_remote,
        session.started_at,
        this.precedingWindowMs,
      );
      for (const row of linkedAfter) {
        if (row.session_id === sessionId) continue; // never link to self
        if (!candidates.has(row.pr_number)) {
          bump(
            { number: row.pr_number, url: row.pr_url, headRefName: "" },
            0.3,
            "preceding-window",
          );
        }
      }
    }

    // ── Persist ────────────────────────────────────────────────────────────
    const now = Date.now();
    for (const [prNum, cand] of candidates) {
      const row: PrAssociationRow = {
        session_id: sessionId,
        repo_remote: session.repo_remote ?? "",
        pr_number: prNum,
        pr_url: cand.pr.url,
        confidence: cand.confidence,
        reason: cand.reason,
        linked_at: now,
      };
      this.sink.upsertPrAssociation(row);
    }
  }

  /**
   * Lazy sweep: re-run `linkSession` for every session in the given repo
   * that started at or after `sinceTs` (Unix ms).  Idempotent — upsert
   * only upgrades confidence.
   */
  async sweepRecent(repoRemote: string, sinceTs: number): Promise<void> {
    const sessions = this.sink.findSessionsByRepoSince(repoRemote, sinceTs);
    for (const session of sessions) {
      try {
        await this.linkSession(session.id);
      } catch (err) {
        console.warn(
          `[analytics:PrLinker] sweepRecent: linkSession failed for ${session.id}:`,
          err,
        );
      }
    }
  }

  // ── Private: gh helpers ────────────────────────────────────────────────────

  /**
   * `gh pr list --search <sha> --state all --json number,url,headRefName`
   *
   * Uses GitHub search to find PRs whose commit history contains the SHA.
   * Returns [] on any error (including missing `gh`, exit code 127, etc.).
   */
  private async searchPrsByCommit(sha: string, cwd: string): Promise<GhPrRef[]> {
    try {
      const result = await this.exec(
        "gh",
        [
          "pr", "list",
          "--search", sha,
          "--state", "all",
          "--json", "number,url,headRefName",
        ],
        { cwd, timeout: this.ghTimeoutMs },
      );
      if (result.exitCode !== 0) return [];
      const parsed = parseGhJson(result.stdout);
      if (!Array.isArray(parsed)) return [];
      return parsed as GhPrRef[];
    } catch (err) {
      console.warn(`[analytics:PrLinker] searchPrsByCommit(${sha}) failed:`, err);
      return [];
    }
  }

  /**
   * `gh pr view <number> --json headRefOid,files`
   *
   * Returns the PR's current HEAD SHA and modified file list.
   * Appends `--repo owner/repo` when derivable from `repoRemote`.
   */
  private async getPrDetail(
    prNumber: number,
    repoRemote: string | null,
    cwd: string,
  ): Promise<GhPrDetail | null> {
    try {
      const args = ["pr", "view", String(prNumber), "--json", "headRefOid,files"];
      if (repoRemote) {
        const m = repoRemote.match(/[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
        if (m) args.push("--repo", m[1]);
      }
      const result = await this.exec("gh", args, { cwd, timeout: this.ghTimeoutMs });
      if (result.exitCode !== 0) return null;
      const parsed = parseGhJson(result.stdout);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
      return parsed as GhPrDetail;
    } catch (err) {
      console.warn(`[analytics:PrLinker] getPrDetail(#${prNumber}) failed:`, err);
      return null;
    }
  }

  /**
   * `gh pr list --state open --json number,url,title`
   *
   * Used by the files-overlap independent-discovery path to surface open PRs
   * not found via commit-search or branch-match.
   */
  private async listAllOpenPrs(cwd: string): Promise<PrInfo[]> {
    try {
      const result = await this.exec(
        "gh",
        ["pr", "list", "--state", "open", "--json", "number,url,title"],
        { cwd, timeout: this.ghTimeoutMs },
      );
      if (result.exitCode !== 0) return [];
      const parsed = parseGhJson(result.stdout);
      if (!Array.isArray(parsed)) return [];
      return parsed as PrInfo[];
    } catch (err) {
      console.warn(`[analytics:PrLinker] listAllOpenPrs failed:`, err);
      return [];
    }
  }

  /** Wrapper around `capture.listOpenPrsForBranch` — never throws. */
  private async safeListOpenPrs(branch: string, cwd: string): Promise<PrInfo[]> {
    try {
      return await listOpenPrsForBranch(this.exec, cwd, branch, this.ghTimeoutMs);
    } catch (err) {
      console.warn(`[analytics:PrLinker] listOpenPrsForBranch(${branch}) failed:`, err);
      return [];
    }
  }

  /** Wrapper around `capture.isAncestor` — returns false on any error. */
  private async safeIsAncestor(
    ancestor: string,
    descendant: string,
    cwd: string,
  ): Promise<boolean> {
    try {
      return await isAncestor(this.exec, cwd, ancestor, descendant);
    } catch {
      return false;
    }
  }

  // ── Private: files-overlap helper ─────────────────────────────────────────

  /**
   * Compute the fraction of `sessionFiles` that also appear in `detail.files`.
   * Returns 0 when the PR detail is missing or has no files.
   */
  private fileOverlap(sessionFiles: Set<string>, detail: GhPrDetail | null): number {
    if (!detail?.files || detail.files.length === 0 || sessionFiles.size === 0) return 0;
    const prFiles = new Set(detail.files.map((f) => f.path));
    const overlap = [...sessionFiles].filter((f) => prFiles.has(f)).length;
    return overlap / sessionFiles.size;
  }

  // ── Private: raw SQL helpers (queries not on SqliteSink's public API) ──────

  /** Return `to_branch` values from `branch_transitions` for a session. */
  private getBranchTransitions(sessionId: string): Array<{ to_branch: string }> {
    const db = this.sink.database;
    if (!db) return [];
    try {
      return db
        .prepare("SELECT to_branch FROM branch_transitions WHERE session_id = ?")
        .all(sessionId) as Array<{ to_branch: string }>;
    } catch {
      return [];
    }
  }

  /**
   * Find `pr_associations` rows (confidence ≥ 0.8) for sessions in the same
   * repo that started strictly after `afterTs` and within `windowMs` ms of it.
   * Used to evaluate the preceding-window heuristic.
   */
  private findLinkedSessionsAfterTs(
    repoRemote: string,
    afterTs: number,
    windowMs: number,
  ): Array<{ session_id: string; pr_number: number; pr_url: string }> {
    const db = this.sink.database;
    if (!db) return [];
    try {
      return db
        .prepare(
          `SELECT pa.session_id, pa.pr_number, pa.pr_url
           FROM pr_associations pa
           JOIN sessions s ON s.id = pa.session_id
           WHERE pa.repo_remote = ?
             AND s.started_at > ?
             AND s.started_at <= ?
             AND pa.confidence >= 0.8`,
        )
        .all(repoRemote, afterTs, afterTs + windowMs) as Array<{
          session_id: string;
          pr_number: number;
          pr_url: string;
        }>;
    } catch {
      return [];
    }
  }
}
