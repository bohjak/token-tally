/**
 * Tests for src/git/capture.ts
 *
 * Uses Node's built-in test runner. Spawns real git processes against temp
 * directories to keep tests realistic without a mocking layer.
 *
 * Tests are skipped if git is not on PATH.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { captureRepoSnapshot } from "../src/git/capture.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true if `git` is available on PATH. */
function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Create a fresh temp directory and return its path. */
async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tt-git-test-"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("returns null for a directory that is not a git repo", async (t) => {
  // This test does NOT require git on PATH — the non-repo case should work
  // even when git is available, as long as the directory has no .git.
  const dir = await makeTmpDir();
  try {
    const result = await captureRepoSnapshot(dir);
    assert.equal(result, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("returns a snapshot with repoRemote for an initialised repo with a remote", async (t) => {
  if (!gitAvailable()) {
    t.skip("git not available on PATH");
    return;
  }

  const dir = await makeTmpDir();
  try {
    execFileSync("git", ["init", dir], { stdio: "ignore" });
    execFileSync(
      "git",
      ["remote", "add", "origin", "git@github.com:acme/test-repo.git"],
      { cwd: dir, stdio: "ignore" },
    );

    const result = await captureRepoSnapshot(dir);
    assert.notEqual(result, null);
    assert.equal(result!.repoRemote, "git@github.com:acme/test-repo.git");
    assert.equal(result!.repoOwner, "acme");
    assert.equal(result!.repoName, "test-repo");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("redacts credentials embedded in an HTTPS remote URL", async (t) => {
  if (!gitAvailable()) {
    t.skip("git not available on PATH");
    return;
  }

  const dir = await makeTmpDir();
  try {
    execFileSync("git", ["init", dir], { stdio: "ignore" });
    execFileSync(
      "git",
      [
        "remote",
        "add",
        "origin",
        "https://user:s3cr3t@github.com/acme/repo.git",
      ],
      { cwd: dir, stdio: "ignore" },
    );

    const result = await captureRepoSnapshot(dir);
    assert.notEqual(result, null);
    assert.ok(
      result!.repoRemote !== null && !result!.repoRemote.includes("s3cr3t"),
      `repoRemote should not contain the password; got: ${result!.repoRemote}`,
    );
    // Owner/name still parsed from the redacted URL
    assert.equal(result!.repoOwner, "acme");
    assert.equal(result!.repoName, "repo");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("returns null for a non-existent directory", async () => {
  const result = await captureRepoSnapshot("/tmp/tt-does-not-exist-xyz123");
  assert.equal(result, null);
});
