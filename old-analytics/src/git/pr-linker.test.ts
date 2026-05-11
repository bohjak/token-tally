/**
 * pr-linker.test.ts — Tests for PrLinker (T13).
 *
 * Uses a real SqliteSink with an in-memory database and a stubbed ExecFn.
 * No real git or gh processes are spawned.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SqliteSink } from "../sinks/sqlite.ts";
import type { AnalyticsConfig } from "../sinks/types.ts";
import { PrLinker } from "./pr-linker.ts";
import type { ExecFn } from "./capture.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(): AnalyticsConfig {
  return {
    local: { enabled: true, dbPath: ":memory:", rawLogDir: "/tmp/pi-test-raw" },
    privacy: {
      storePrompts: "hashed",
      storeToolArgs: "summary",
      storeToolOutputs: "size-only",
      redactPatterns: [],
    },
    git: { enabled: true, fetchPR: false, ghTimeoutMs: 2_000 },
  };
}

let _ts = 1_700_000_000_000;
const tick = () => (_ts += 100);

function seedSession(
  sink: SqliteSink,
  id: string,
  opts: {
    cwd?: string;
    repoRemote?: string | null;
    branchStart?: string;
    branchEnd?: string | null;
    headShaStart?: string;
    headShaEnd?: string | null;
    startedAt?: number;
  } = {},
): void {
  const startedAt = opts.startedAt ?? tick();
  sink.write({
    kind: "session_start",
    ts: startedAt,
    id,
    parent_session_id: null,
    parent_session_file: null,
    started_at: startedAt,
    cwd: opts.cwd ?? "/tmp/test-repo",
    repo_root: "/tmp/test-repo",
    repo_remote: opts.repoRemote ?? "https://github.com/owner/repo",
    repo_owner: "owner",
    repo_name: "repo",
    branch_start: opts.branchStart ?? "main",
    head_sha_start: opts.headShaStart ?? "start_sha",
    dirty_at_start: 0,
    pi_version: "0.72.0",
    hostname: "test-host",
  });
  // End the session to populate branch_end and head_sha_end.
  sink.write({
    kind: "session_end",
    ts: tick(),
    session_id: id,
    ended_at: tick(),
    branch_end: opts.branchEnd ?? null,
    head_sha_end: opts.headShaEnd ?? null,
    exit_reason: "normal",
  });
}

function seedCommit(sink: SqliteSink, sessionId: string, sha: string): void {
  sink.write({
    kind: "commit_made",
    ts: tick(),
    session_id: sessionId,
    turn_id: null,
    sha,
    subject: `feat: ${sha.slice(0, 7)}`,
    files_changed: 1,
    insertions: 5,
    deletions: 0,
  });
}

function seedFileTouched(sink: SqliteSink, sessionId: string, path: string): void {
  sink.write({
    kind: "file_touched",
    ts: tick(),
    tool_call_id: `tc-${path}`,
    session_id: sessionId,
    path,
    op: "read",
    bytes: 100,
    sensitive: false,
  });
}

function seedBranchTransition(
  sink: SqliteSink,
  sessionId: string,
  fromBranch: string,
  toBranch: string,
): void {
  sink.write({
    kind: "branch_transition",
    ts: tick(),
    session_id: sessionId,
    turn_id: null,
    from_branch: fromBranch,
    to_branch: toBranch,
  });
}

/** Read all pr_association rows for a given session from SQLite. */
function readAssocs(
  sink: SqliteSink,
  sessionId: string,
): Array<{ pr_number: number; confidence: number; reason: string }> {
  return (
    sink.database!
      .prepare(
        "SELECT pr_number, confidence, reason FROM pr_associations WHERE session_id = ?",
      )
      .all(sessionId) as Array<{ pr_number: number; confidence: number; reason: string }>
  );
}

/**
 * Flexible exec stub: routes by (cmd, predicate on args).
 * The first matching route wins; unmatched calls return exitCode=1 / empty stdout.
 */
function makeExec(
  routes: Array<{
    cmd: string;
    when: (args: string[]) => boolean;
    out: string;
    exitCode?: number;
  }>,
): ExecFn {
  return async (cmd, args) => {
    for (const route of routes) {
      if (route.cmd !== cmd) continue;
      if (route.when(args)) {
        return { stdout: route.out, stderr: "", exitCode: route.exitCode ?? 0 };
      }
    }
    return { stdout: "", stderr: "no route matched", exitCode: 1 };
  };
}

// JSON helpers
const prListJson = (prs: Array<{ number: number; url: string; headRefName?: string; title?: string }>) =>
  JSON.stringify(prs.map((p) => ({ number: p.number, url: p.url, headRefName: p.headRefName ?? "", title: p.title ?? "" })));
const prDetailJson = (headRefOid?: string, files?: string[]) =>
  JSON.stringify({ headRefOid: headRefOid ?? null, files: (files ?? []).map((p) => ({ path: p })) });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PrLinker", () => {
  let sink: SqliteSink;

  beforeEach(async () => {
    sink = new SqliteSink();
    await sink.init(makeConfig());
  });

  afterEach(async () => {
    await sink.close();
  });

  // ── 1. commit-in-pr → confidence 1.0 ────────────────────────────────────
  it("links session via commit-in-pr with confidence 1.0", async () => {
    const sha = "abc123def456";
    seedSession(sink, "s1");
    seedCommit(sink, "s1", sha);

    const exec = makeExec([
      {
        cmd: "gh",
        when: (a) => a.includes("--search") && a.includes(sha),
        out: prListJson([{ number: 42, url: "https://github.com/o/r/pull/42", headRefName: "feat/x" }]),
      },
    ]);

    const linker = new PrLinker(sink, exec, { ghTimeoutMs: 500 });
    await linker.linkSession("s1");

    const assocs = readAssocs(sink, "s1");
    assert.equal(assocs.length, 1);
    assert.equal(assocs[0].pr_number, 42);
    assert.equal(assocs[0].confidence, 1.0);
    assert.equal(assocs[0].reason, "commit-in-pr");
  });

  // ── 2. branch-match → confidence 0.8 ────────────────────────────────────
  it("links session via branch-match with confidence 0.8", async () => {
    seedSession(sink, "s2", { branchEnd: "feat/my-branch" });

    const exec = makeExec([
      {
        cmd: "gh",
        // listOpenPrsForBranch sends --head <branch>
        when: (a) => a.includes("--head") && a.includes("feat/my-branch"),
        out: prListJson([{ number: 43, url: "https://github.com/o/r/pull/43", title: "my PR" }]),
      },
    ]);

    const linker = new PrLinker(sink, exec, { ghTimeoutMs: 500 });
    await linker.linkSession("s2");

    const assocs = readAssocs(sink, "s2");
    assert.equal(assocs.length, 1);
    assert.equal(assocs[0].pr_number, 43);
    assert.equal(assocs[0].confidence, 0.8);
    assert.equal(assocs[0].reason, "branch-match");
  });

  // ── 3. files-overlap ≥50% → confidence 0.5 ──────────────────────────────
  it("links session via files-overlap (≥50%) with confidence 0.5", async () => {
    // No commits, no branch → discovered purely from file-overlap path.
    seedSession(sink, "s3", { branchEnd: null });
    seedFileTouched(sink, "s3", "src/foo.ts");
    seedFileTouched(sink, "s3", "src/bar.ts");

    const exec = makeExec([
      {
        // listAllOpenPrs: gh pr list --state open (no --head flag)
        cmd: "gh",
        when: (a) =>
          a.includes("pr") && a.includes("list") && a.includes("--state") &&
          a.includes("open") && !a.includes("--head"),
        out: prListJson([{ number: 44, url: "https://github.com/o/r/pull/44", title: "overlapping" }]),
      },
      {
        // getPrDetail: gh pr view 44
        cmd: "gh",
        when: (a) => a.includes("view") && a.includes("44"),
        // PR has src/foo.ts and src/baz.ts: 1/2 = 50% overlap
        out: prDetailJson(undefined, ["src/foo.ts", "src/baz.ts"]),
      },
    ]);

    const linker = new PrLinker(sink, exec, { ghTimeoutMs: 500 });
    await linker.linkSession("s3");

    const assocs = readAssocs(sink, "s3");
    assert.equal(assocs.length, 1);
    assert.equal(assocs[0].pr_number, 44);
    assert.equal(assocs[0].confidence, 0.5);
    assert.equal(assocs[0].reason, "files-overlap");
  });

  // ── 4. files-overlap <50% → no association ──────────────────────────────
  it("does not link session when files-overlap is below 50%", async () => {
    seedSession(sink, "s4", { branchEnd: null });
    // 3 session files
    seedFileTouched(sink, "s4", "src/foo.ts");
    seedFileTouched(sink, "s4", "src/bar.ts");
    seedFileTouched(sink, "s4", "src/baz.ts");

    const exec = makeExec([
      {
        cmd: "gh",
        when: (a) =>
          a.includes("list") && a.includes("--state") &&
          a.includes("open") && !a.includes("--head"),
        out: prListJson([{ number: 45, url: "https://github.com/o/r/pull/45" }]),
      },
      {
        cmd: "gh",
        when: (a) => a.includes("view") && a.includes("45"),
        // Only 1 of 3 files overlap → 33% < 50%
        out: prDetailJson(undefined, ["src/foo.ts"]),
      },
    ]);

    const linker = new PrLinker(sink, exec, { ghTimeoutMs: 500 });
    await linker.linkSession("s4");

    const assocs = readAssocs(sink, "s4");
    assert.equal(assocs.length, 0);
  });

  // ── 5. ancestor-of-pr → confidence 0.9 ──────────────────────────────────
  it("upgrades confidence to 0.9 via ancestor-of-pr", async () => {
    const headShaEnd = "ancestor_sha";
    const prHeadOid = "descendant_sha";
    seedSession(sink, "s5", { branchEnd: "feat/z", headShaEnd });

    const exec = makeExec([
      {
        // branch-match discovers PR 46 at confidence 0.8
        cmd: "gh",
        when: (a) => a.includes("--head") && a.includes("feat/z"),
        out: prListJson([{ number: 46, url: "https://github.com/o/r/pull/46", title: "z PR" }]),
      },
      {
        // getPrDetail returns headRefOid for ancestor check
        cmd: "gh",
        when: (a) => a.includes("view") && a.includes("46"),
        out: prDetailJson(prHeadOid),
      },
      {
        // isAncestor: git merge-base --is-ancestor <ancestor> <descendant>
        cmd: "git",
        when: (a) =>
          a.includes("--is-ancestor") &&
          a.includes(headShaEnd) &&
          a.includes(prHeadOid),
        out: "",
        exitCode: 0, // 0 = true
      },
    ]);

    const linker = new PrLinker(sink, exec, { ghTimeoutMs: 500 });
    await linker.linkSession("s5");

    const assocs = readAssocs(sink, "s5");
    assert.equal(assocs.length, 1);
    assert.equal(assocs[0].pr_number, 46);
    assert.equal(assocs[0].confidence, 0.9);
    assert.equal(assocs[0].reason, "ancestor-of-pr");
  });

  // ── 6. preceding-window → confidence 0.3 ────────────────────────────────
  it("links a preceding session via preceding-window at confidence 0.3", async () => {
    const repo = "https://github.com/owner/repo";
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;

    // Research session (s6a) starts 1h before implementation session (s6b).
    seedSession(sink, "s6a", { repoRemote: repo, startedAt: now - oneHour, branchEnd: null });
    seedSession(sink, "s6b", { repoRemote: repo, startedAt: now, branchEnd: "feat/impl" });

    // Link s6b to PR #47 at confidence 0.8 via branch-match.
    sink.upsertPrAssociation({
      session_id: "s6b",
      repo_remote: repo,
      pr_number: 47,
      pr_url: "https://github.com/o/r/pull/47",
      confidence: 0.8,
      reason: "branch-match",
      linked_at: now,
    });

    // s6a has no commits, no branch → only preceding-window should fire.
    const exec = makeExec([]); // No gh routes needed; preceding-window is pure SQL.

    const linker = new PrLinker(sink, exec, { ghTimeoutMs: 500, cwd: "/tmp/test-repo" });
    await linker.linkSession("s6a");

    const assocs = readAssocs(sink, "s6a");
    assert.equal(assocs.length, 1);
    assert.equal(assocs[0].pr_number, 47);
    assert.equal(assocs[0].confidence, 0.3);
    assert.equal(assocs[0].reason, "preceding-window");
  });

  // ── 7. idempotency — re-run does not downgrade confidence ────────────────
  it("does not downgrade confidence on repeated linkSession calls", async () => {
    const sha = "idempotent_sha";
    seedSession(sink, "s7", { branchEnd: "feat/idem" });
    seedCommit(sink, "s7", sha);

    // First run: commit-in-pr fires (confidence 1.0).
    const exec1 = makeExec([
      {
        cmd: "gh",
        when: (a) => a.includes("--search") && a.includes(sha),
        out: prListJson([{ number: 48, url: "https://github.com/o/r/pull/48", headRefName: "feat/idem" }]),
      },
    ]);
    const linker = new PrLinker(sink, exec1, { ghTimeoutMs: 500 });
    await linker.linkSession("s7");

    let assocs = readAssocs(sink, "s7");
    assert.equal(assocs[0].confidence, 1.0);

    // Second run: commit-search returns nothing, branch-match returns PR 48 (0.8).
    // Confidence must remain 1.0 due to upsert MAX semantics.
    const exec2 = makeExec([
      {
        cmd: "gh",
        when: (a) => a.includes("--search"),
        out: "[]",
      },
      {
        cmd: "gh",
        when: (a) => a.includes("--head") && a.includes("feat/idem"),
        out: prListJson([{ number: 48, url: "https://github.com/o/r/pull/48", title: "idem" }]),
      },
    ]);
    const linker2 = new PrLinker(sink, exec2, { ghTimeoutMs: 500 });
    await linker2.linkSession("s7");

    assocs = readAssocs(sink, "s7");
    assert.equal(assocs.length, 1);
    assert.equal(assocs[0].confidence, 1.0, "confidence must not be downgraded");
    assert.equal(assocs[0].reason, "commit-in-pr", "reason must not be downgraded");
  });

  it("treats empty gh JSON output as no result without warning", async () => {
    seedSession(sink, "empty-json", { branchEnd: null });
    seedCommit(sink, "empty-json", "empty_json_sha");
    seedFileTouched(sink, "empty-json", "src/foo.ts");

    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };

    try {
      const exec = makeExec([
        { cmd: "gh", when: () => true, out: "", exitCode: 0 },
      ]);
      const linker = new PrLinker(sink, exec, { ghTimeoutMs: 500 });

      await assert.doesNotReject(() => linker.linkSession("empty-json"));
    } finally {
      console.warn = originalWarn;
    }

    const assocs = readAssocs(sink, "empty-json");
    assert.equal(assocs.length, 0);
    assert.deepEqual(warnings, []);
  });

  // ── 8. gh missing (exit 127) → no throw, no association ─────────────────
  it("handles missing gh (exit 127) without throwing or creating associations", async () => {
    seedSession(sink, "s8", { branchEnd: "feat/missing-gh" });
    seedCommit(sink, "s8", "deadbeef");

    // All gh calls fail with 127 (command not found).
    const exec = makeExec([
      { cmd: "gh", when: () => true, out: "", exitCode: 127 },
    ]);

    const linker = new PrLinker(sink, exec, { ghTimeoutMs: 500 });
    // Must resolve without throwing.
    await assert.doesNotReject(() => linker.linkSession("s8"));

    const assocs = readAssocs(sink, "s8");
    assert.equal(assocs.length, 0);
  });

  // ── Bonus: branch_transition → branch-match on transition target ─────────
  it("checks branch_transitions.to_branch for branch-match", async () => {
    seedSession(sink, "s9", { branchEnd: "main" }); // ended on main
    seedBranchTransition(sink, "s9", "main", "feat/transition-branch");

    const exec = makeExec([
      {
        cmd: "gh",
        when: (a) => a.includes("--head") && a.includes("feat/transition-branch"),
        out: prListJson([{ number: 50, url: "https://github.com/o/r/pull/50", title: "transition PR" }]),
      },
    ]);

    const linker = new PrLinker(sink, exec, { ghTimeoutMs: 500 });
    await linker.linkSession("s9");

    const assocs = readAssocs(sink, "s9");
    const found = assocs.find((a) => a.pr_number === 50);
    assert.ok(found, "should have found PR 50 via branch_transition target");
    assert.equal(found.confidence, 0.8);
    assert.equal(found.reason, "branch-match");
  });

  // ── sweepRecent re-runs linkSession for all sessions in the repo ─────────
  it("sweepRecent calls linkSession for each session in the repo", async () => {
    const repo = "https://github.com/owner/repo";
    const base = Date.now() - 60_000;
    seedSession(sink, "sweep1", { repoRemote: repo, startedAt: base });
    seedSession(sink, "sweep2", { repoRemote: repo, startedAt: base + 1_000 });
    seedCommit(sink, "sweep1", "sweep_sha_1");
    seedCommit(sink, "sweep2", "sweep_sha_2");

    const called: string[] = [];
    const exec = makeExec([
      {
        cmd: "gh",
        when: (a) => a.includes("--search") && a.some((s) => s.startsWith("sweep_sha_")),
        out: JSON.stringify([{ number: 99, url: "https://github.com/o/r/pull/99", headRefName: "feat/sweep" }]),
      },
    ]);

    const linker = new PrLinker(sink, exec, { ghTimeoutMs: 500, cwd: "/tmp/test-repo" });
    await linker.sweepRecent(repo, base - 1);

    const a1 = readAssocs(sink, "sweep1");
    const a2 = readAssocs(sink, "sweep2");
    assert.equal(a1.length, 1, "sweep1 should be linked");
    assert.equal(a2.length, 1, "sweep2 should be linked");
    void called; // suppress unused-variable lint
  });
});
