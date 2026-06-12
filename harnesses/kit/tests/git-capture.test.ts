/**
 * git-capture.test.ts — Tests for src/git-capture.ts
 *
 * Uses Node's built-in test runner. Includes both real-git integration tests
 * and ExecFn injection tests (no real git required).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { captureRepoSnapshot, type ExecFn } from "../src/git-capture.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tt-kit-git-test-"));
}

// ---------------------------------------------------------------------------
// Integration tests (real git)
// ---------------------------------------------------------------------------

test("returns null for a directory that is not a git repo", async () => {
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
    execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/test-repo.git"], {
      cwd: dir,
      stdio: "ignore",
    });
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
      ["remote", "add", "origin", "https://user:s3cr3t@github.com/acme/repo.git"],
      { cwd: dir, stdio: "ignore" },
    );
    const result = await captureRepoSnapshot(dir);
    assert.notEqual(result, null);
    assert.ok(
      result!.repoRemote !== null && !result!.repoRemote.includes("s3cr3t"),
      `repoRemote should not contain the password; got: ${result!.repoRemote}`,
    );
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

// ---------------------------------------------------------------------------
// ExecFn injection tests (no real git required)
// ---------------------------------------------------------------------------

describe("captureRepoSnapshot with injected ExecFn", () => {
  // Stub that maps (cmd+args) to a response string.
  const makeStubExec = (responses: Record<string, string | null>): ExecFn => {
    return async (_cmd, args, _cwd, _timeoutMs) => {
      const key = args.join(" ");
      return responses[key] ?? null;
    };
  };

  test("returns snapshot when exec provides rev-parse and remote URL", async () => {
    const exec = makeStubExec({
      "rev-parse --show-toplevel": "/home/user/project",
      "config --get remote.origin.url": "git@github.com:myorg/myrepo.git",
    });
    const result = await captureRepoSnapshot("/any/cwd", exec);
    assert.deepEqual(result, {
      repoOwner: "myorg",
      repoName: "myrepo",
      repoRemote: "git@github.com:myorg/myrepo.git",
    });
  });

  test("returns null when rev-parse returns null (not a git repo)", async () => {
    const exec = makeStubExec({});
    const result = await captureRepoSnapshot("/any/cwd", exec);
    assert.equal(result, null);
  });

  test("returns snapshot with null remote fields when no remote is configured", async () => {
    const exec = makeStubExec({
      "rev-parse --show-toplevel": "/home/user/project",
      // "config --get remote.origin.url" is absent → null
    });
    const result = await captureRepoSnapshot("/any/cwd", exec);
    assert.deepEqual(result, { repoOwner: null, repoName: null, repoRemote: null });
  });

  test("repo metadata capture is deterministic with stubbed exec (await safety)", async () => {
    // Verifies that with a stubbed exec, the async capture completes
    // synchronously-ish and returns a consistent result (no race with process exit).
    let callCount = 0;
    const exec: ExecFn = async (_cmd, args, _cwd, _timeoutMs) => {
      callCount++;
      if (args[0] === "rev-parse") return "/repo";
      if (args[0] === "config") return "https://github.com/org/repo.git";
      return null;
    };

    const result = await captureRepoSnapshot("/cwd", exec);
    assert.notEqual(result, null);
    assert.equal(result!.repoOwner, "org");
    assert.equal(result!.repoName, "repo");
    // Both calls (rev-parse + config) must have completed before we got a result.
    assert.equal(callCount, 2, "both exec calls must have completed before resolve");
  });
});
