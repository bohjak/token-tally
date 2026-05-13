/**
 * state-session-state.test.ts — Tests for state/paths.ts and state/session-state.ts
 *
 * Each test uses an isolated temp directory via XDG_STATE_HOME override so
 * tests never touch the real state directory and don't interfere with each
 * other.
 *
 * All imports use .js extensions because tests are compiled to dist/ and run
 * via node --test against the compiled output.
 */

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  readSessionState,
  writeSessionState,
  deleteSessionState,
  makeInitialSessionState,
  type SessionState,
} from "../src/state/session-state.js";
import { cursorStateDir, sessionStateFile } from "../src/state/paths.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fully-populated SessionState for round-trip testing. */
function makeFullState(overrides: Partial<SessionState> = {}): SessionState {
  const harnessSessionId = randomUUID();
  return {
    centralSessionId: randomUUID(),
    harnessSessionId,
    turnIndex: 2,
    currentTurnId: randomUUID(),
    currentHarnessTurnId: `${harnessSessionId}:t2`,
    lastGenerationId: "gen-abc123",
    messageIndex: 5,
    toolIndex: 3,
    activeTools: {
      "tool-use-id-1": {
        startedAt: 1700000000000,
        toolName: "Shell",
        harnessToolCallId: "tool-use-id-1",
      },
    },
    lastModelId: "claude-sonnet-4-5",
    lastProvider: "anthropic",
    drained: false,
    subscriptionId: null,
    ...overrides,
  };
}

/**
 * Run a test body with XDG_STATE_HOME pointing at a fresh temp directory.
 * Always cleans up, even if the body throws.
 */
async function withTempStateHome(
  fn: (tempDir: string) => Promise<void>,
): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "tt-cursor-test-"));
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
// paths.ts
// ---------------------------------------------------------------------------

describe("cursorStateDir", () => {
  test("respects XDG_STATE_HOME env var", () => {
    const prev = process.env["XDG_STATE_HOME"];
    const custom = "/tmp/custom-xdg-" + randomUUID();
    process.env["XDG_STATE_HOME"] = custom;
    try {
      const dir = cursorStateDir();
      assert.ok(
        dir.startsWith(custom),
        `Expected dir to start with ${custom}, got ${dir}`,
      );
      assert.ok(
        dir.includes("token-tally"),
        `Expected 'token-tally' in path, got ${dir}`,
      );
      assert.ok(
        dir.includes("cursor"),
        `Expected 'cursor' in path, got ${dir}`,
      );
    } finally {
      if (prev === undefined) {
        delete process.env["XDG_STATE_HOME"];
      } else {
        process.env["XDG_STATE_HOME"] = prev;
      }
    }
  });

  test("falls back to ~/.local/state when XDG_STATE_HOME is unset", () => {
    const prev = process.env["XDG_STATE_HOME"];
    delete process.env["XDG_STATE_HOME"];
    try {
      const dir = cursorStateDir();
      assert.ok(
        dir.includes(".local") && dir.includes("state"),
        `Expected default XDG path, got ${dir}`,
      );
      assert.ok(dir.includes("token-tally"), `Missing token-tally in ${dir}`);
      assert.ok(dir.includes("cursor"), `Missing cursor in ${dir}`);
    } finally {
      if (prev !== undefined) {
        process.env["XDG_STATE_HOME"] = prev;
      }
    }
  });

  test("state dir is 'cursor', not 'claude-code'", () => {
    const dir = cursorStateDir();
    assert.ok(!dir.includes("claude-code"), `Unexpected 'claude-code' in path: ${dir}`);
  });
});

describe("sessionStateFile", () => {
  test("includes the harness session id in the filename", () => {
    const sessionId = "conv-abc-123";
    const path = sessionStateFile(sessionId);
    assert.ok(
      path.endsWith(`${sessionId}.json`),
      `Expected filename to end with ${sessionId}.json, got ${path}`,
    );
  });
});

// ---------------------------------------------------------------------------
// session-state.ts — round-trip
// ---------------------------------------------------------------------------

test("write and read back a state object (round-trip)", async () => {
  await withTempStateHome(async () => {
    const sessionId = randomUUID();
    const original = makeFullState({ harnessSessionId: sessionId });

    await writeSessionState(sessionId, original);
    const read = await readSessionState(sessionId);

    assert.deepStrictEqual(read, original);
  });
});

test("round-trip preserves all new Cursor-specific fields", async () => {
  await withTempStateHome(async () => {
    const sessionId = randomUUID();
    const state = makeFullState({
      harnessSessionId: sessionId,
      lastGenerationId: "gen-xyz",
      messageIndex: 7,
      toolIndex: 4,
      drained: true,
    });

    await writeSessionState(sessionId, state);
    const read = await readSessionState(sessionId);

    assert.ok(read !== null);
    assert.equal(read.lastGenerationId, "gen-xyz");
    assert.equal(read.messageIndex, 7);
    assert.equal(read.toolIndex, 4);
    assert.equal(read.drained, true);
  });
});

// ---------------------------------------------------------------------------
// session-state.ts — delete and missing-file handling
// ---------------------------------------------------------------------------

test("delete state file, subsequent read returns null", async () => {
  await withTempStateHome(async () => {
    const sessionId = randomUUID();
    await writeSessionState(sessionId, makeFullState({ harnessSessionId: sessionId }));
    assert.notEqual(await readSessionState(sessionId), null);

    await deleteSessionState(sessionId);
    assert.equal(await readSessionState(sessionId), null);
  });
});

test("readSessionState on non-existent file returns null without throwing", async () => {
  await withTempStateHome(async () => {
    const result = await readSessionState("nonexistent-" + randomUUID());
    assert.equal(result, null);
  });
});

test("deleteSessionState on missing file is a no-op (no throw)", async () => {
  await withTempStateHome(async () => {
    await deleteSessionState("missing-" + randomUUID()); // should not throw
  });
});

// ---------------------------------------------------------------------------
// session-state.ts — directory creation
// ---------------------------------------------------------------------------

test("writeSessionState creates intermediate directories automatically", async () => {
  await withTempStateHome(async () => {
    // The state dir doesn't exist yet — write should create it
    const sessionId = randomUUID();
    const state = makeInitialSessionState(randomUUID(), sessionId);

    await writeSessionState(sessionId, state);
    const read = await readSessionState(sessionId);

    assert.ok(read !== null);
    assert.equal(read.harnessSessionId, sessionId);
  });
});

// ---------------------------------------------------------------------------
// session-state.ts — corrupt file recovery
// ---------------------------------------------------------------------------

test("readSessionState returns null and warns on invalid JSON", async () => {
  await withTempStateHome(async (tempDir) => {
    const sessionId = "corrupt-session-" + randomUUID();
    const { writeFile, mkdir } = await import("node:fs/promises");

    // Write a corrupt state file directly
    const dir = join(tempDir, "token-tally", "cursor");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${sessionId}.json`), "{ not valid json }", "utf8");

    // Should return null rather than throw
    const result = await readSessionState(sessionId);
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// makeInitialSessionState factory
// ---------------------------------------------------------------------------

describe("makeInitialSessionState", () => {
  test("returns a state with all counters at zero", () => {
    const state = makeInitialSessionState("central-uuid", "harness-session-id");
    assert.equal(state.turnIndex, 0);
    assert.equal(state.messageIndex, 0);
    assert.equal(state.toolIndex, 0);
  });

  test("returns a state with null/false for optional fields", () => {
    const state = makeInitialSessionState("central-uuid", "harness-session-id");
    assert.equal(state.currentTurnId, null);
    assert.equal(state.currentHarnessTurnId, null);
    assert.equal(state.lastGenerationId, null);
    assert.equal(state.lastModelId, null);
    assert.equal(state.lastProvider, null);
    assert.equal(state.subscriptionId, null);
    assert.equal(state.drained, false);
    assert.deepEqual(state.activeTools, {});
  });

  test("stores provided centralSessionId and harnessSessionId", () => {
    const state = makeInitialSessionState("cid-123", "hid-456");
    assert.equal(state.centralSessionId, "cid-123");
    assert.equal(state.harnessSessionId, "hid-456");
  });
});

// ---------------------------------------------------------------------------
// Cursor-specific: events without session_id use conversation_id as session key
// ---------------------------------------------------------------------------

test("state file keyed by conversation_id (no session_id on most events)", async () => {
  await withTempStateHome(async () => {
    // On most Cursor hook events (afterAgentResponse, preToolUse, stop, etc.)
    // only conversation_id is present — there is no session_id field.
    // The harness session id = conversation_id, which must work as the state key.
    const conversationId = "conv-" + randomUUID();
    const state = makeInitialSessionState(randomUUID(), conversationId);

    await writeSessionState(conversationId, state);
    const read = await readSessionState(conversationId);

    assert.ok(read !== null, "should read back state keyed by conversation_id");
    assert.equal(read.harnessSessionId, conversationId);
  });
});

test("two sessions with different conversation_ids have independent state files", async () => {
  await withTempStateHome(async () => {
    const conv1 = "conv-" + randomUUID();
    const conv2 = "conv-" + randomUUID();

    const state1 = makeInitialSessionState(randomUUID(), conv1);
    const state2 = makeInitialSessionState(randomUUID(), conv2);
    // Give them different turn indices to tell them apart
    state1.turnIndex = 10;
    state2.turnIndex = 20;

    await writeSessionState(conv1, state1);
    await writeSessionState(conv2, state2);

    const read1 = await readSessionState(conv1);
    const read2 = await readSessionState(conv2);

    assert.ok(read1 !== null);
    assert.ok(read2 !== null);
    assert.equal(read1.turnIndex, 10);
    assert.equal(read2.turnIndex, 20);
  });
});
