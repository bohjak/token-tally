/**
 * Tests for src/state/paths.ts and src/state/session-state.ts.
 *
 * Each test uses an isolated temp directory via XDG_STATE_HOME override so
 * tests never touch the real state directory and don't interfere with each
 * other.
 *
 * Imports use .js extensions because this file is compiled to dist/ and run
 * as ESM from the dist tree.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  readSessionState,
  writeSessionState,
  deleteSessionState,
  type SessionState,
} from "../src/state/session-state.js";
import { claudeCodeStateDir } from "../src/state/paths.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid SessionState for testing. */
function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    centralSessionId: randomUUID(),
    harnessSessionId: randomUUID(),
    turnIndex: 0,
    currentTurnId: null,
    currentHarnessTurnId: null,
    transcriptOffset: 0,
    lastModelId: null,
    lastProvider: null,
    subscriptionId: null,
    activeTools: {},
    ...overrides,
  };
}

/**
 * Run a test with a temporary XDG_STATE_HOME so state files land in a
 * throwaway directory and are cleaned up afterwards.
 */
async function withTempStateHome(
  fn: (tempDir: string) => Promise<void>,
): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "tt-test-"));
  const prev = process.env["XDG_STATE_HOME"];
  process.env["XDG_STATE_HOME"] = tempDir;
  try {
    await fn(tempDir);
  } finally {
    if (prev === undefined) {
      delete process.env["XDG_STATE_HOME"];
    } else {
      process.env["XDG_STATE_HOME"] = prev;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("write and read back a state object (round-trip)", async () => {
  await withTempStateHome(async () => {
    const sessionId = randomUUID();
    const original = makeState({
      centralSessionId: "central-123",
      harnessSessionId: sessionId,
      turnIndex: 3,
      currentTurnId: "turn-uuid",
      currentHarnessTurnId: `${sessionId}:t3`,
      transcriptOffset: 42,
      lastModelId: "claude-sonnet-4-5",
      lastProvider: "anthropic",
      subscriptionId: "sub-abc",
      activeTools: {
        "tool-1": { startedAt: 1700000000000, toolName: "Bash" },
      },
    });

    await writeSessionState(sessionId, original);
    const read = await readSessionState(sessionId);

    assert.deepStrictEqual(read, original);
  });
});

test("delete state file, subsequent read returns null", async () => {
  await withTempStateHome(async () => {
    const sessionId = randomUUID();
    const state = makeState({ harnessSessionId: sessionId });

    await writeSessionState(sessionId, state);
    assert.notEqual(await readSessionState(sessionId), null);

    await deleteSessionState(sessionId);
    assert.equal(await readSessionState(sessionId), null);
  });
});

test("read from non-existent path returns null without throwing", async () => {
  await withTempStateHome(async () => {
    const result = await readSessionState("nonexistent-session-id-" + randomUUID());
    assert.equal(result, null);
  });
});

test("deleteSessionState on missing file is a no-op (no throw)", async () => {
  await withTempStateHome(async () => {
    // Should not throw
    await deleteSessionState("missing-session-" + randomUUID());
  });
});

test("claudeCodeStateDir respects XDG_STATE_HOME env var", async () => {
  const prev = process.env["XDG_STATE_HOME"];
  const customBase = "/tmp/custom-xdg-state-" + randomUUID();
  process.env["XDG_STATE_HOME"] = customBase;
  try {
    const dir = claudeCodeStateDir();
    assert.ok(
      dir.startsWith(customBase),
      `Expected dir to start with ${customBase}, got ${dir}`,
    );
    assert.ok(
      dir.includes("token-tally"),
      `Expected dir to include 'token-tally', got ${dir}`,
    );
    assert.ok(
      dir.includes("claude-code"),
      `Expected dir to include 'claude-code', got ${dir}`,
    );
  } finally {
    if (prev === undefined) {
      delete process.env["XDG_STATE_HOME"];
    } else {
      process.env["XDG_STATE_HOME"] = prev;
    }
  }
});

test("writeSessionState creates intermediate directories automatically", async () => {
  await withTempStateHome(async () => {
    // The state dir doesn't exist yet — write should create it
    const sessionId = randomUUID();
    const state = makeState({ harnessSessionId: sessionId });

    // Should not throw even though the directory tree doesn't exist yet
    await writeSessionState(sessionId, state);

    const read = await readSessionState(sessionId);
    assert.ok(read !== null);
    assert.equal(read.harnessSessionId, state.harnessSessionId);
  });
});
