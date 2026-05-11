/**
 * git/capture.test.ts — Tests for git/capture.ts helpers.
 *
 * Tests that require a real `git` binary are skipped gracefully when git is
 * not on PATH.  Tests for `gh` CLI helpers use a mock ExecFn — no GitHub
 * auth is required.
 *
 * Run: node --test src/git/capture.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";

import {
  captureRepoSnapshot,
  fetchPrForBranch,
  listOpenPrsForBranch,
  getCurrentHeadSha,
  getDiffSummary,
  isAncestor,
  parseRemoteOwnerName,
  type ExecFn,
  type PrInfo,
} from "./capture.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an ExecFn backed by real child_process.spawn. */
function makeRealExec(): ExecFn {
  return (cmd, args, opts) =>
    new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      const cp = spawn(cmd, args, { cwd: opts?.cwd ?? process.cwd() });
      cp.stdout.on("data", (d: Buffer) => {
        stdout += d.toString();
      });
      cp.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
      cp.on("close", (code) => {
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });
      cp.on("error", (err) => {
        resolve({ stdout: "", stderr: err.message, exitCode: 1 });
      });
      if (opts?.signal) {
        opts.signal.addEventListener(
          "abort",
          () => {
            cp.kill();
            resolve({ stdout, stderr, exitCode: -1 });
          },
          { once: true },
        );
      }
    });
}

const realExec = makeRealExec();

/**
 * Build a mock ExecFn from a map of `"cmd arg1 arg2 ..." → response`.
 * Keys are matched by joining cmd + args with spaces.
 * Falls back to exitCode 1 when no key matches.
 */
function makeMockExec(
  responses: Record<string, { stdout: string; exitCode: number }>,
): ExecFn {
  return async (cmd, args) => {
    const key = [cmd, ...args].join(" ");
    const r = responses[key];
    return r
      ? { stdout: r.stdout, stderr: "", exitCode: r.exitCode }
      : { stdout: "", stderr: `mock: no response for: ${key}`, exitCode: 1 };
  };
}

/** Run a shell command synchronously in a directory (for test fixture setup). */
function runSync(cmd: string, args: string[], cwd: string): void {
  execFileSync(cmd, args, { cwd, stdio: "pipe" });
}

// ---------------------------------------------------------------------------
// Check git availability (top-level await — package.json has "type": "module")
// ---------------------------------------------------------------------------

let gitAvailable = false;
try {
  execFileSync("git", ["--version"], { stdio: "pipe" });
  gitAvailable = true;
} catch {
  console.warn("[capture.test] git binary not available — real-repo tests skipped");
}

// Option object for tests that require a real git binary.
const needsGit = gitAvailable ? {} : { skip: "git binary not available" };

// ---------------------------------------------------------------------------
// parseRemoteOwnerName — pure function, no git required
// ---------------------------------------------------------------------------

describe("parseRemoteOwnerName", () => {
  it("parses SSH short form git@github.com:owner/repo.git", () => {
    const r = parseRemoteOwnerName("git@github.com:owner/repo.git");
    assert.deepEqual(r, { owner: "owner", name: "repo" });
  });

  it("parses SSH short form without .git suffix", () => {
    const r = parseRemoteOwnerName("git@github.com:my-org/my-repo");
    assert.deepEqual(r, { owner: "my-org", name: "my-repo" });
  });

  it("parses HTTPS without .git suffix", () => {
    const r = parseRemoteOwnerName("https://github.com/owner/repo");
    assert.deepEqual(r, { owner: "owner", name: "repo" });
  });

  it("parses HTTPS with .git suffix", () => {
    const r = parseRemoteOwnerName("https://github.com/owner/repo.git");
    assert.deepEqual(r, { owner: "owner", name: "repo" });
  });

  it("parses SSH long form ssh://git@github.com/owner/repo.git", () => {
    const r = parseRemoteOwnerName("ssh://git@github.com/owner/repo.git");
    assert.deepEqual(r, { owner: "owner", name: "repo" });
  });

  it("handles hyphens in owner and repo name", () => {
    const r = parseRemoteOwnerName("git@github.com:my-org/cool-project.git");
    assert.deepEqual(r, { owner: "my-org", name: "cool-project" });
  });

  it("returns null for an unrecognised URL", () => {
    assert.equal(parseRemoteOwnerName("not-a-valid-remote"), null);
  });

  it("returns null for empty string", () => {
    assert.equal(parseRemoteOwnerName(""), null);
  });

  it("handles leading/trailing whitespace (e.g. trailing newline from git output)", () => {
    const r = parseRemoteOwnerName("git@github.com:owner/repo.git\n");
    assert.deepEqual(r, { owner: "owner", name: "repo" });
  });
});

// ---------------------------------------------------------------------------
// captureRepoSnapshot with mock exec — tests remote URL parsing paths
// ---------------------------------------------------------------------------

describe("captureRepoSnapshot (mock exec)", () => {
  /** Builds a mock that succeeds for all 5 git calls with configurable remote URL. */
  function snapshotMock(remoteUrl: string): ExecFn {
    return makeMockExec({
      "git rev-parse --show-toplevel": { stdout: "/repo/root\n", exitCode: 0 },
      "git config --get remote.origin.url": {
        stdout: `${remoteUrl}\n`,
        exitCode: 0,
      },
      "git rev-parse --abbrev-ref HEAD": { stdout: "main\n", exitCode: 0 },
      "git rev-parse HEAD": {
        stdout: "abc1234567890abc1234567890abc1234567890ab\n",
        exitCode: 0,
      },
      "git status --porcelain": { stdout: "", exitCode: 0 },
    });
  }

  it("populates repoOwner/repoName from SSH short-form remote", async () => {
    const snap = await captureRepoSnapshot(
      snapshotMock("git@github.com:myorg/myrepo.git"),
      "/repo/root",
    );
    assert.ok(snap);
    assert.equal(snap.repoOwner, "myorg");
    assert.equal(snap.repoName, "myrepo");
    assert.equal(snap.repoRemote, "git@github.com:myorg/myrepo.git");
  });

  it("populates repoOwner/repoName from HTTPS remote", async () => {
    const snap = await captureRepoSnapshot(
      snapshotMock("https://github.com/acme/widget"),
      "/repo/root",
    );
    assert.ok(snap);
    assert.equal(snap.repoOwner, "acme");
    assert.equal(snap.repoName, "widget");
  });

  it("returns null when rev-parse --show-toplevel exits non-zero (not a git repo)", async () => {
    const exec = makeMockExec({
      "git rev-parse --show-toplevel": { stdout: "", exitCode: 128 },
    });
    const snap = await captureRepoSnapshot(exec, "/not-a-repo");
    assert.equal(snap, null);
  });

  it("returns null when HEAD SHA is missing (empty repo)", async () => {
    const exec = makeMockExec({
      "git rev-parse --show-toplevel": { stdout: "/repo\n", exitCode: 0 },
      "git config --get remote.origin.url": { stdout: "", exitCode: 1 },
      "git rev-parse --abbrev-ref HEAD": { stdout: "main\n", exitCode: 0 },
      "git rev-parse HEAD": { stdout: "", exitCode: 128 }, // no commits
      "git status --porcelain": { stdout: "", exitCode: 0 },
    });
    const snap = await captureRepoSnapshot(exec, "/repo");
    assert.equal(snap, null);
  });

  it("tolerates missing remote (repoOwner/repoName are null)", async () => {
    const exec = makeMockExec({
      "git rev-parse --show-toplevel": { stdout: "/repo\n", exitCode: 0 },
      "git config --get remote.origin.url": { stdout: "", exitCode: 1 },
      "git rev-parse --abbrev-ref HEAD": { stdout: "main\n", exitCode: 0 },
      "git rev-parse HEAD": { stdout: "deadbeef\n", exitCode: 0 },
      "git status --porcelain": { stdout: "", exitCode: 0 },
    });
    const snap = await captureRepoSnapshot(exec, "/repo");
    assert.ok(snap);
    assert.equal(snap.repoRemote, null);
    assert.equal(snap.repoOwner, null);
    assert.equal(snap.repoName, null);
  });

  it("counts dirty files from git status --porcelain output", async () => {
    const exec = makeMockExec({
      "git rev-parse --show-toplevel": { stdout: "/repo\n", exitCode: 0 },
      "git config --get remote.origin.url": { stdout: "", exitCode: 1 },
      "git rev-parse --abbrev-ref HEAD": { stdout: "main\n", exitCode: 0 },
      "git rev-parse HEAD": { stdout: "deadbeef\n", exitCode: 0 },
      // Two modified files
      "git status --porcelain": {
        stdout: " M src/a.ts\n M src/b.ts\n",
        exitCode: 0,
      },
    });
    const snap = await captureRepoSnapshot(exec, "/repo");
    assert.ok(snap);
    assert.equal(snap.dirtyCount, 2);
  });

  it("returns branch=HEAD when rev-parse --abbrev-ref HEAD fails", async () => {
    const exec = makeMockExec({
      "git rev-parse --show-toplevel": { stdout: "/repo\n", exitCode: 0 },
      "git config --get remote.origin.url": { stdout: "", exitCode: 1 },
      "git rev-parse --abbrev-ref HEAD": { stdout: "", exitCode: 1 },
      "git rev-parse HEAD": { stdout: "deadbeef\n", exitCode: 0 },
      "git status --porcelain": { stdout: "", exitCode: 0 },
    });
    const snap = await captureRepoSnapshot(exec, "/repo");
    assert.ok(snap);
    assert.equal(snap.branch, "HEAD");
  });
});

// ---------------------------------------------------------------------------
// Tests requiring a real git repository
// ---------------------------------------------------------------------------

describe(
  "with real git repository",
  gitAvailable ? {} : { skip: "git binary not available" },
  () => {
    let repoDir = "";
    let initialSha = "";
    let featureSha = "";
    let nonGitDir = "";

    before(async () => {
      // ── Create temp repo ────────────────────────────────────────────────
      repoDir = mkdtempSync(join(tmpdir(), "pi-analytics-capture-test-"));
      nonGitDir = mkdtempSync(join(tmpdir(), "pi-analytics-nongit-"));

      runSync("git", ["init", "-q"], repoDir);
      runSync("git", ["config", "user.email", "t@t.com"], repoDir);
      runSync("git", ["config", "user.name", "Test User"], repoDir);

      // Initial commit on main branch.
      writeFileSync(join(repoDir, "readme.txt"), "hello\n");
      runSync("git", ["add", "."], repoDir);
      runSync(
        "git",
        ["-c", "user.email=t@t.com", "-c", "user.name=Test User",
          "commit", "-m", "initial commit", "-q"],
        repoDir,
      );

      // Capture initial SHA.
      const buf = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir });
      initialSha = buf.toString().trim();

      // Feature branch with a second commit.
      runSync("git", ["checkout", "-b", "feat/test", "-q"], repoDir);
      writeFileSync(
        join(repoDir, "feature.ts"),
        Array.from({ length: 5 }, (_, i) => `export const x${i} = ${i};\n`).join(""),
      );
      runSync("git", ["add", "."], repoDir);
      runSync(
        "git",
        ["-c", "user.email=t@t.com", "-c", "user.name=Test User",
          "commit", "-m", "feat: add feature", "-q"],
        repoDir,
      );

      const buf2 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir });
      featureSha = buf2.toString().trim();
    });

    after(() => {
      if (repoDir) rmSync(repoDir, { recursive: true, force: true });
      if (nonGitDir) rmSync(nonGitDir, { recursive: true, force: true });
    });

    // ── captureRepoSnapshot ───────────────────────────────────────────────

    it("captureRepoSnapshot: returns a snapshot for a valid git repo", async () => {
      const snap = await captureRepoSnapshot(realExec, repoDir);
      assert.ok(snap, "expected non-null snapshot");
      assert.equal(typeof snap.repoRoot, "string");
      assert.ok(snap.repoRoot.length > 0);
      assert.equal(snap.headSha, featureSha);
      assert.equal(snap.branch, "feat/test");
      // No remote configured in this test repo.
      assert.equal(snap.repoRemote, null);
      assert.equal(snap.repoOwner, null);
    });

    it("captureRepoSnapshot: returns null outside a git repo", async () => {
      const snap = await captureRepoSnapshot(realExec, nonGitDir);
      assert.equal(snap, null);
    });

    it("captureRepoSnapshot: dirty count is 0 on a clean tree", async () => {
      const snap = await captureRepoSnapshot(realExec, repoDir);
      assert.ok(snap);
      assert.equal(snap.dirtyCount, 0);
    });

    // ── getCurrentHeadSha ─────────────────────────────────────────────────

    it("getCurrentHeadSha: returns current HEAD SHA", async () => {
      const sha = await getCurrentHeadSha(realExec, repoDir);
      assert.equal(sha, featureSha);
    });

    it("getCurrentHeadSha: returns null outside a git repo", async () => {
      const sha = await getCurrentHeadSha(realExec, nonGitDir);
      assert.equal(sha, null);
    });

    // ── getDiffSummary ────────────────────────────────────────────────────

    it("getDiffSummary: returns 1 commit and 1 file for a single-commit range", async () => {
      const diff = await getDiffSummary(realExec, repoDir, initialSha, featureSha);
      assert.equal(diff.commits.length, 1, "expected exactly 1 commit");
      const commit = diff.commits[0];
      assert.ok(commit);
      assert.equal(commit.sha, featureSha);
      assert.equal(commit.subject, "feat: add feature");
      assert.equal(commit.filesChanged, 1);
      // feature.ts has 5 added lines, 0 deleted.
      assert.equal(commit.insertions, 5);
      assert.equal(commit.deletions, 0);

      assert.equal(diff.files.length, 1, "expected exactly 1 file");
      const file = diff.files[0];
      assert.ok(file);
      assert.equal(file.path, "feature.ts");
      assert.equal(file.insertions, 5);
      assert.equal(file.deletions, 0);
    });

    it("getDiffSummary: returns empty for same-SHA range", async () => {
      const diff = await getDiffSummary(realExec, repoDir, featureSha, featureSha);
      assert.equal(diff.commits.length, 0);
      assert.equal(diff.files.length, 0);
    });

    it("getDiffSummary: returns empty for an invalid SHA range", async () => {
      const diff = await getDiffSummary(
        realExec,
        repoDir,
        "0000000000000000000000000000000000000000",
        featureSha,
      );
      // git exits non-zero for unknown SHA → empty result.
      assert.equal(diff.commits.length, 0);
    });

    // ── isAncestor ────────────────────────────────────────────────────────

    it("isAncestor: initial commit is an ancestor of feature commit", async () => {
      const result = await isAncestor(realExec, repoDir, initialSha, featureSha);
      assert.equal(result, true);
    });

    it("isAncestor: feature commit is NOT an ancestor of initial commit", async () => {
      const result = await isAncestor(realExec, repoDir, featureSha, initialSha);
      assert.equal(result, false);
    });

    it("isAncestor: a commit is its own ancestor", async () => {
      // git merge-base --is-ancestor sha sha exits 0.
      const result = await isAncestor(realExec, repoDir, initialSha, initialSha);
      assert.equal(result, true);
    });

    it("isAncestor: returns false for unknown SHA", async () => {
      const result = await isAncestor(
        realExec,
        repoDir,
        "0000000000000000000000000000000000000000",
        featureSha,
      );
      assert.equal(result, false);
    });
  },
);

// ---------------------------------------------------------------------------
// fetchPrForBranch — mock-based tests
// ---------------------------------------------------------------------------

describe("fetchPrForBranch (mock exec)", () => {
  const fakePr: PrInfo = {
    number: 42,
    url: "https://github.com/owner/repo/pull/42",
    title: "fix: something important",
  };

  it("returns PR info when gh exits 0 with valid JSON", async () => {
    const exec = makeMockExec({
      "gh pr view main --json number,url,title": {
        stdout: JSON.stringify(fakePr),
        exitCode: 0,
      },
    });
    const result = await fetchPrForBranch(exec, "/repo", "main", 5000);
    assert.deepEqual(result, fakePr);
  });

  it("returns null when gh exits non-zero (no PR / not found)", async () => {
    const exec = makeMockExec({
      "gh pr view main --json number,url,title": {
        stdout: '{"message":"no open pull requests"}',
        exitCode: 1,
      },
    });
    const result = await fetchPrForBranch(exec, "/repo", "main", 5000);
    assert.equal(result, null);
  });

  it("returns null when gh is not installed (exec rejects)", async () => {
    const exec: ExecFn = async () => {
      throw new Error("spawn gh ENOENT");
    };
    const result = await fetchPrForBranch(exec, "/repo", "main", 5000);
    assert.equal(result, null);
  });

  it("returns null when JSON is malformed", async () => {
    const exec = makeMockExec({
      "gh pr view main --json number,url,title": {
        stdout: "not json {{{",
        exitCode: 0,
      },
    });
    const result = await fetchPrForBranch(exec, "/repo", "main", 5000);
    assert.equal(result, null);
  });

  it("returns null when JSON lacks a numeric `number` field", async () => {
    const exec = makeMockExec({
      "gh pr view main --json number,url,title": {
        stdout: JSON.stringify({ url: "https://...", title: "x" }),
        exitCode: 0,
      },
    });
    const result = await fetchPrForBranch(exec, "/repo", "main", 5000);
    assert.equal(result, null);
  });

  it("returns null when the call exceeds timeoutMs", async () => {
    // exec that sleeps longer than the timeout
    const slowExec: ExecFn = (_cmd, _args) =>
      new Promise((resolve) =>
        setTimeout(
          () => resolve({ stdout: JSON.stringify(fakePr), stderr: "", exitCode: 0 }),
          500,
        ),
      );

    const result = await fetchPrForBranch(slowExec, "/repo", "main", 50);
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// listOpenPrsForBranch — mock-based tests
// ---------------------------------------------------------------------------

describe("listOpenPrsForBranch (mock exec)", () => {
  const fakePrs: PrInfo[] = [
    { number: 10, url: "https://github.com/o/r/pull/10", title: "feat A" },
    { number: 11, url: "https://github.com/o/r/pull/11", title: "feat B" },
  ];

  it("returns array of PRs on success", async () => {
    const exec = makeMockExec({
      "gh pr list --head feat/x --state open --json number,url,title": {
        stdout: JSON.stringify(fakePrs),
        exitCode: 0,
      },
    });
    const result = await listOpenPrsForBranch(exec, "/repo", "feat/x", 5000);
    assert.deepEqual(result, fakePrs);
  });

  it("returns [] when gh exits non-zero", async () => {
    const exec = makeMockExec({
      "gh pr list --head feat/x --state open --json number,url,title": {
        stdout: "",
        exitCode: 1,
      },
    });
    const result = await listOpenPrsForBranch(exec, "/repo", "feat/x", 5000);
    assert.deepEqual(result, []);
  });

  it("returns [] when exec rejects (gh not installed)", async () => {
    const exec: ExecFn = async () => {
      throw new Error("spawn gh ENOENT");
    };
    const result = await listOpenPrsForBranch(exec, "/repo", "feat/x", 5000);
    assert.deepEqual(result, []);
  });

  it("returns [] when response is not a JSON array", async () => {
    const exec = makeMockExec({
      "gh pr list --head feat/x --state open --json number,url,title": {
        stdout: JSON.stringify({ notAnArray: true }),
        exitCode: 0,
      },
    });
    const result = await listOpenPrsForBranch(exec, "/repo", "feat/x", 5000);
    assert.deepEqual(result, []);
  });

  it("returns [] on timeout", async () => {
    const slowExec: ExecFn = (_cmd, _args) =>
      new Promise((resolve) =>
        setTimeout(
          () => resolve({ stdout: "[]", stderr: "", exitCode: 0 }),
          500,
        ),
      );
    const result = await listOpenPrsForBranch(slowExec, "/repo", "feat/x", 50);
    assert.deepEqual(result, []);
  });
});
