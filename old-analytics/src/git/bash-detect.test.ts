/**
 * bash-detect.test.ts — Test suite for detectGitOps().
 *
 * Covers all required cases from the T12 spec plus edge cases for the
 * tokenizer and splitter.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectGitOps } from "./bash-detect.ts";
import type { DetectedOp } from "./bash-detect.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ops(command: string): DetectedOp[] {
  return detectGitOps(command);
}

// ---------------------------------------------------------------------------
// Required spec cases
// ---------------------------------------------------------------------------

describe("detectGitOps — required spec cases", () => {
  it('git add . && git commit -m "x"', () => {
    const result = ops('git add . && git commit -m "x"');
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], { kind: "git-commit" });
  });

  it("git commit -am 'fix' && git push", () => {
    const result = ops("git commit -am 'fix' && git push");
    assert.equal(result.length, 2);
    assert.deepEqual(result[0], { kind: "git-commit" });
    assert.deepEqual(result[1], { kind: "git-push", remote: undefined, branch: undefined });
  });

  it("git checkout -b feat/x && git push -u origin feat/x", () => {
    const result = ops("git checkout -b feat/x && git push -u origin feat/x");
    assert.equal(result.length, 2);
    assert.deepEqual(result[0], { kind: "git-checkout", toBranch: "feat/x", created: true });
    assert.deepEqual(result[1], { kind: "git-push", remote: "origin", branch: "feat/x" });
  });

  it("git switch main", () => {
    const result = ops("git switch main");
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], { kind: "git-switch", toBranch: "main", created: false });
  });

  it("gh pr create --fill", () => {
    const result = ops("gh pr create --fill");
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], { kind: "gh-pr-create" });
  });

  it("echo not git commit — no match", () => {
    const result = ops("echo not git commit");
    assert.equal(result.length, 0);
  });

  it("no-match case — plain echo", () => {
    const result = ops("echo hello world");
    assert.equal(result.length, 0);
  });

  it("empty string — no match", () => {
    const result = ops("");
    assert.equal(result.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Additional required cases
// ---------------------------------------------------------------------------

describe("detectGitOps — additional required cases", () => {
  it("git push origin main", () => {
    const result = ops("git push origin main");
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], { kind: "git-push", remote: "origin", branch: "main" });
  });

  it("git switch -c feat/y", () => {
    const result = ops("git switch -c feat/y");
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], { kind: "git-switch", toBranch: "feat/y", created: true });
  });

  it("git checkout main — no created flag", () => {
    const result = ops("git checkout main");
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], { kind: "git-checkout", toBranch: "main", created: false });
  });
});

// ---------------------------------------------------------------------------
// Quoting edge cases
// ---------------------------------------------------------------------------

describe("detectGitOps — quoting edge cases", () => {
  it('quoted && inside commit message does not split the command', () => {
    // git commit -m "a && b"  must be treated as one segment
    const result = ops('git commit -m "a && b"');
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], { kind: "git-commit" });
  });

  it("single-quoted commit message with special chars", () => {
    const result = ops("git commit -m 'feat: add && improve; stuff'");
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], { kind: "git-commit" });
  });

  it("commit message with semicolon inside double quotes — no extra segment", () => {
    const result = ops('git commit -m "fix: a; b"');
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], { kind: "git-commit" });
  });

  it("quoted branch name in checkout", () => {
    const result = ops('git checkout -b "feat/quoted-branch"');
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], {
      kind: "git-checkout",
      toBranch: "feat/quoted-branch",
      created: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Separator styles
// ---------------------------------------------------------------------------

describe("detectGitOps — separator styles", () => {
  it("semicolon separator", () => {
    const result = ops("git commit -m init; git push");
    assert.equal(result.length, 2);
    assert.equal(result[0].kind, "git-commit");
    assert.equal(result[1].kind, "git-push");
  });

  it("|| separator — both sides still detected", () => {
    const result = ops("git commit -m x || git push");
    assert.equal(result.length, 2);
    assert.equal(result[0].kind, "git-commit");
    assert.equal(result[1].kind, "git-push");
  });

  it("pipe — both sides still detected", () => {
    // The right side of a pipe is rarely a git command but we don't gate on that.
    const result = ops("git push 2>&1 | tee log.txt");
    assert.equal(result.length, 1);
    assert.equal(result[0].kind, "git-push");
  });

  it("multi-op chain: checkout + commit + push", () => {
    const result = ops(
      "git checkout -b feat/z && git commit --allow-empty -m init && git push -u origin feat/z",
    );
    assert.equal(result.length, 3);
    assert.deepEqual(result[0], { kind: "git-checkout", toBranch: "feat/z", created: true });
    assert.deepEqual(result[1], { kind: "git-commit" });
    assert.deepEqual(result[2], { kind: "git-push", remote: "origin", branch: "feat/z" });
  });
});

// ---------------------------------------------------------------------------
// git commit variants
// ---------------------------------------------------------------------------

describe("detectGitOps — git commit variants", () => {
  it("git commit --amend", () => {
    assert.equal(ops("git commit --amend").length, 1);
    assert.equal(ops("git commit --amend")[0].kind, "git-commit");
  });

  it("git commit -a -m msg", () => {
    assert.equal(ops("git commit -a -m msg")[0].kind, "git-commit");
  });

  it("git commit --amend --no-edit", () => {
    assert.equal(ops("git commit --amend --no-edit")[0].kind, "git-commit");
  });
});

// ---------------------------------------------------------------------------
// git push variants
// ---------------------------------------------------------------------------

describe("detectGitOps — git push variants", () => {
  it("git push alone — no remote or branch", () => {
    const result = ops("git push");
    assert.deepEqual(result[0], { kind: "git-push", remote: undefined, branch: undefined });
  });

  it("git push --force origin main", () => {
    const result = ops("git push --force origin main");
    assert.deepEqual(result[0], { kind: "git-push", remote: "origin", branch: "main" });
  });

  it("git push -u origin feat/x", () => {
    const result = ops("git push -u origin feat/x");
    assert.deepEqual(result[0], { kind: "git-push", remote: "origin", branch: "feat/x" });
  });

  it("git push origin HEAD", () => {
    const result = ops("git push origin HEAD");
    assert.deepEqual(result[0], { kind: "git-push", remote: "origin", branch: "HEAD" });
  });

  it("git push origin local:remote refspec", () => {
    // local part of `local:remote` is reported as branch
    const result = ops("git push origin feat/x:refs/heads/feat/x");
    assert.deepEqual(result[0], { kind: "git-push", remote: "origin", branch: "feat/x" });
  });
});

// ---------------------------------------------------------------------------
// gh pr create variants
// ---------------------------------------------------------------------------

describe("detectGitOps — gh pr create variants", () => {
  it("gh pr create with multiple flags", () => {
    const result = ops("gh pr create --title 'My PR' --body 'details' --base main");
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], { kind: "gh-pr-create" });
  });

  it("gh pr view does NOT match gh-pr-create", () => {
    assert.equal(ops("gh pr view 42").length, 0);
  });

  it("gh pr list does NOT match gh-pr-create", () => {
    assert.equal(ops("gh pr list --state open").length, 0);
  });
});

// ---------------------------------------------------------------------------
// No-match sanity checks
// ---------------------------------------------------------------------------

describe("detectGitOps — no-match sanity checks", () => {
  it("git status is not captured", () => {
    assert.equal(ops("git status").length, 0);
  });

  it("git add is not captured", () => {
    assert.equal(ops("git add -A").length, 0);
  });

  it("git log is not captured", () => {
    assert.equal(ops("git log --oneline").length, 0);
  });

  it("npm install is not captured", () => {
    assert.equal(ops("npm install && npm test").length, 0);
  });

  it("word 'commit' in an echo is not captured", () => {
    assert.equal(ops("echo 'this is a commit message'").length, 0);
  });

  it("git commit inside a string argument is not captured", () => {
    // e.g. `echo "git commit"` — only 'echo' is the command
    assert.equal(ops('echo "git commit"').length, 0);
  });
});

// ---------------------------------------------------------------------------
// Environment variable prefix handling
// ---------------------------------------------------------------------------

describe("detectGitOps — env-var prefix handling", () => {
  it("GIT_DIR=/x git commit is still detected", () => {
    const result = ops("GIT_DIR=/x git commit -m msg");
    assert.equal(result.length, 1);
    assert.equal(result[0].kind, "git-commit");
  });

  it("HOME=/tmp git push origin main is still detected", () => {
    const result = ops("HOME=/tmp git push origin main");
    assert.deepEqual(result[0], { kind: "git-push", remote: "origin", branch: "main" });
  });
});
