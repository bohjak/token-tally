/**
 * tests/transcript-drain.test.ts — Unit tests for transcript/drain.ts
 *
 * Uses a fake AnalyticsWriter (plain object with a recordLlmMessage stub)
 * so no SQLite DB is needed. Transcript files are written to os.tmpdir().
 *
 * Import paths use .js extensions (Node16 module resolution).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { AnalyticsWriter } from "@token-tally/store";
import { drainTranscript } from "../src/transcript/drain.js";
import type { SessionState } from "../src/state/session-state.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Captured arguments from a fake writer's recordLlmMessage call.
 * We preserve the full payload so tests can assert specific fields.
 */
type LlmCall = Parameters<AnalyticsWriter["recordLlmMessage"]>[0];

/**
 * Build a minimal fake AnalyticsWriter that accumulates recordLlmMessage calls.
 * The real writer is not imported — using `as unknown as AnalyticsWriter` so
 * TypeScript accepts it in drainTranscript's signature.
 */
function makeFakeWriter(): { writer: AnalyticsWriter; calls: LlmCall[] } {
  const calls: LlmCall[] = [];
  const writer = {
    recordLlmMessage: async (payload: LlmCall) => {
      calls.push(payload);
      return { id: randomUUID() };
    },
  } as unknown as AnalyticsWriter;
  return { writer, calls };
}

/**
 * Build a minimal SessionState for testing. All IDs are stable strings so
 * assertions are deterministic.
 */
function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    centralSessionId: "central-session-1",
    harnessSessionId: "harness-session-1",
    turnIndex: 1,
    currentTurnId: "turn-id-1",
    currentHarnessTurnId: "harness-session-1:t1",
    transcriptPath: null,
    transcriptOffset: 0,
    lastModelId: null,
    lastProvider: null,
    subscriptionId: null,
    activeTools: {},
    ...overrides,
  };
}

/** Serialise one transcript entry as JSONL (no trailing newline). */
function toLine(entry: object): string {
  return JSON.stringify(entry);
}

/** Write a transcript file containing the given lines (joined by \n). */
async function writeTmpTranscript(lines: string[]): Promise<string> {
  const path = join(tmpdir(), `drain-test-${randomUUID()}.jsonl`);
  await writeFile(path, lines.join("\n"), "utf8");
  return path;
}

/** Build an assistant transcript entry. */
function assistantEntry(
  uuid: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  overrides: Record<string, unknown> = {},
): object {
  return {
    type: "assistant",
    uuid,
    timestamp: "2024-01-15T10:00:00.000Z",
    message: {
      model,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test 1 — Basic drain: known model, writer cost source
// ---------------------------------------------------------------------------

test("basic drain: known haiku model computes writer cost correctly", async () => {
  const entry = assistantEntry("msg-1", "claude-3-5-haiku-20241022", 100, 50);
  const path = await writeTmpTranscript([toLine(entry)]);

  try {
    const { writer, calls } = makeFakeWriter();
    const state = makeState();
    const updated = await drainTranscript(writer, state, path);

    // One call recorded.
    assert.equal(calls.length, 1, "should record exactly one llm_message");

    const call = calls[0]!;
    assert.equal(call.harnessMessageId, "msg-1");
    assert.equal(call.costSource, "writer");
    assert.equal(call.harnessId, "claude-code");
    assert.equal(call.provider, "anthropic");
    assert.equal(call.modelId, "claude-3-5-haiku-20241022");
    assert.equal(call.inputTokens, 100);
    assert.equal(call.outputTokens, 50);

    // haiku rates: input=0.8/MTok → round(100 × 0.8) = 80 micros
    //              output=4/MTok  → round(50  × 4)   = 200 micros
    assert.equal(call.costInputMicros, 80, "costInputMicros should be 80");
    assert.equal(call.costOutputMicros, 200, "costOutputMicros should be 200");
    assert.equal(call.costCacheReadMicros, 0);
    assert.equal(call.costCacheWriteMicros, 0);

    // Verify total = sum of breakdown (mirrors the DB CHECK constraint).
    const expectedTotal =
      (call.costInputMicros ?? 0) +
      (call.costOutputMicros ?? 0) +
      (call.costCacheReadMicros ?? 0) +
      (call.costCacheWriteMicros ?? 0);
    // (costTotalMicros is computed by the store, not the drain helper — just
    //  verify the four breakdown fields sum correctly here.)
    assert.equal(expectedTotal, 280, "breakdown fields should sum to 280");

    // State: offset should have advanced, model/provider updated.
    assert.ok(updated.transcriptOffset > 0, "offset should advance past 0");
    assert.equal(updated.lastModelId, "claude-3-5-haiku-20241022");
    assert.equal(updated.lastProvider, "anthropic");
  } finally {
    await unlink(path).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Test 2 — Legacy costUSD: harness-provided cost
// ---------------------------------------------------------------------------

test("legacy costUSD: attributes full cost to output when output_tokens > 0", async () => {
  const entry = assistantEntry("msg-legacy", "claude-3-5-haiku-20241022", 0, 200, {
    costUSD: 0.001,
  });
  const path = await writeTmpTranscript([toLine(entry)]);

  try {
    const { writer, calls } = makeFakeWriter();
    const updated = await drainTranscript(writer, makeState(), path);

    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.harnessMessageId, "msg-legacy");
    assert.equal(call.costSource, "harness", "legacy costUSD should set costSource to harness");
    // 0.001 USD × 1_000_000 = 1_000 micros, all attributed to output (output_tokens=200 > 0)
    assert.equal(call.costOutputMicros, 1000, "costOutputMicros should be 1000");
    assert.equal(call.costInputMicros, 0, "costInputMicros should be 0");
    assert.equal(call.costCacheReadMicros, 0);
    assert.equal(call.costCacheWriteMicros, 0);

    assert.ok(updated.transcriptOffset > 0);
  } finally {
    await unlink(path).catch(() => undefined);
  }
});

test("legacy costUSD: attributes full cost to input when output_tokens = 0", async () => {
  const entry = assistantEntry("msg-legacy-in", "claude-3-5-haiku-20241022", 50, 0, {
    costUSD: 0.00004,
  });
  const path = await writeTmpTranscript([toLine(entry)]);

  try {
    const { writer, calls } = makeFakeWriter();
    await drainTranscript(writer, makeState(), path);

    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.costSource, "harness");
    // 0.00004 × 1_000_000 = 40 micros, all to input (output_tokens=0)
    assert.equal(call.costInputMicros, 40);
    assert.equal(call.costOutputMicros, 0);
  } finally {
    await unlink(path).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Test 3 — Subscription covered
// ---------------------------------------------------------------------------

test("subscription covered: writer cost is reclassified to subscription_covered", async () => {
  const entry = assistantEntry("msg-sub", "claude-3-5-haiku-20241022", 100, 50);
  const path = await writeTmpTranscript([toLine(entry)]);

  try {
    const { writer, calls } = makeFakeWriter();
    const state = makeState({ subscriptionId: "sub-123" });
    await drainTranscript(writer, state, path);

    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.costSource, "subscription_covered");
    assert.equal(call.subscriptionId, "sub-123");
    // Cost breakdown still holds the PAYG list-price equivalent.
    assert.equal(call.costInputMicros, 80);
    assert.equal(call.costOutputMicros, 200);
  } finally {
    await unlink(path).catch(() => undefined);
  }
});

test("subscription covered: legacy harness cost is NOT reclassified", async () => {
  // cost_source = "harness" should stay "harness" even under a subscription —
  // the harness provided the cost directly.
  const entry = assistantEntry("msg-sub-legacy", "claude-3-5-haiku-20241022", 0, 100, {
    costUSD: 0.001,
  });
  const path = await writeTmpTranscript([toLine(entry)]);

  try {
    const { writer, calls } = makeFakeWriter();
    const state = makeState({ subscriptionId: "sub-xyz" });
    await drainTranscript(writer, state, path);

    assert.equal(calls.length, 1);
    // "harness" cost source: the override only applies to "writer" source.
    assert.equal(calls[0]!.costSource, "harness");
    // m2 fix: subscriptionId must NOT be set on non-covered rows.
    assert.equal(
      calls[0]!.subscriptionId,
      undefined,
      "subscriptionId should be undefined for harness-cost rows",
    );
  } finally {
    await unlink(path).catch(() => undefined);
  }
});

test("m2: unknown-cost rows do not get subscriptionId even when session has one", async () => {
  // An unknown model produces costSource='unknown'; subscriptionId must be
  // undefined to avoid readers treating the row as 'free' subscription usage.
  const entry = assistantEntry("msg-unknown-sub", "claude-supernova-99", 500, 250);
  const path = await writeTmpTranscript([toLine(entry)]);

  try {
    const { writer, calls } = makeFakeWriter();
    const state = makeState({ subscriptionId: "sub-abc" });
    await drainTranscript(writer, state, path);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.costSource, "unknown", "unknown model should give unknown costSource");
    assert.equal(
      calls[0]!.subscriptionId,
      undefined,
      "subscriptionId must not be set on unknown-cost rows",
    );
  } finally {
    await unlink(path).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Test 4 — Unknown model: all costs zero, costSource = "unknown"
// ---------------------------------------------------------------------------

test("unknown model: costSource is unknown and all cost micros are 0", async () => {
  // Use a non-claude model ID — the prefix-strip fallback in lookupModelRates
  // would eventually reduce any "claude-*" ID to "claude" which then prefix-
  // matches every entry in the table. A completely foreign model ID is safe.
  const entry = assistantEntry("msg-unknown", "gpt-totally-unknown-9999", 1000, 500);
  const path = await writeTmpTranscript([toLine(entry)]);

  try {
    const { writer, calls } = makeFakeWriter();
    await drainTranscript(writer, makeState(), path);

    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.costSource, "unknown");
    assert.equal(call.costInputMicros, 0);
    assert.equal(call.costOutputMicros, 0);
    assert.equal(call.costCacheReadMicros, 0);
    assert.equal(call.costCacheWriteMicros, 0);
  } finally {
    await unlink(path).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Test 5 — Incremental reading: drain only processes new lines
//
// The reader resets offset only when fromLine > totalLines (transcript
// rotation/truncation). Idempotency for already-recorded entries is the
// store's job via ON CONFLICT DO UPDATE on (harness_id, harness_message_id).
// This test verifies that when the transcript GROWS between drain calls, only
// the NEW entries are processed by the second call — the core incremental
// guarantee. A companion test covers the trailing-newline case (C1 fix).
// ---------------------------------------------------------------------------

test("incremental reading: second drain only processes new transcript entries", async () => {
  const entry1 = assistantEntry("msg-inc-1", "claude-3-5-haiku-20241022", 10, 5);
  const entry2 = assistantEntry("msg-inc-2", "claude-3-5-haiku-20241022", 20, 10);
  const path = join(tmpdir(), `drain-incremental-${randomUUID()}.jsonl`);

  try {
    // Write only entry1 (no trailing newline so totalLines = 1).
    await writeFile(path, toLine(entry1), "utf8");

    const { writer, calls } = makeFakeWriter();
    const state0 = makeState();

    // First drain: reads entry1, offset advances to totalLines (1).
    const state1 = await drainTranscript(writer, state0, path);
    assert.equal(calls.length, 1, "first drain should record msg-inc-1");
    assert.equal(calls[0]!.harnessMessageId, "msg-inc-1");
    assert.ok(state1.transcriptOffset > 0, "offset should advance after first drain");

    // Grow the transcript: add entry2 separated by a newline. Now totalLines=2
    // and state1.transcriptOffset (=1) < 2 so the reader won't reset.
    await writeFile(path, toLine(entry1) + "\n" + toLine(entry2), "utf8");

    // Second drain: starts at offset=1, reads only entry2.
    const state2 = await drainTranscript(writer, state1, path);
    assert.equal(calls.length, 2, "second drain should add msg-inc-2");
    assert.equal(calls[1]!.harnessMessageId, "msg-inc-2");
    assert.ok(state2.transcriptOffset > state1.transcriptOffset, "offset should advance again");
  } finally {
    await unlink(path).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Test 6 — Non-assistant entries skipped
// ---------------------------------------------------------------------------

test("non-assistant entries are skipped; only assistant entries recorded", async () => {
  const userEntry = { type: "user", uuid: "user-1", content: "hello" };
  const systemEntry = { type: "system", content: "system prompt" };
  const assistantE = assistantEntry("msg-assistant-1", "claude-3-5-haiku-20241022", 50, 25);

  const path = await writeTmpTranscript([
    toLine(userEntry),
    toLine(systemEntry),
    toLine(assistantE),
  ]);

  try {
    const { writer, calls } = makeFakeWriter();
    await drainTranscript(writer, makeState(), path);

    assert.equal(calls.length, 1, "only the assistant entry should trigger a call");
    assert.equal(calls[0]!.harnessMessageId, "msg-assistant-1");
  } finally {
    await unlink(path).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Test 7 — Empty transcript: no calls, offset stays at 0
// ---------------------------------------------------------------------------

test("empty transcript: no recordLlmMessage calls, lastModelId unchanged", async () => {
  const path = await writeTmpTranscript([]);

  try {
    const { writer, calls } = makeFakeWriter();
    const state = makeState({ transcriptOffset: 0 });
    const updated = await drainTranscript(writer, state, path);

    assert.equal(calls.length, 0, "empty transcript should produce no calls");
    // The reader returns nextLine = totalLines even for empty content.
    // An empty string split by '\n' yields [""], the trailing-empty strip
    // then pops it → totalLines=0 → offset=0. What matters is no entries.
    assert.ok(updated.transcriptOffset >= 0, "offset should be non-negative");
    assert.equal(updated.lastModelId, null, "lastModelId unchanged when no entries");
  } finally {
    await unlink(path).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Test 8 — Missing transcript file: no calls, no throw
// ---------------------------------------------------------------------------

test("missing transcript file: no calls and no throw", async () => {
  const path = join(tmpdir(), `drain-nonexistent-${randomUUID()}.jsonl`);
  const { writer, calls } = makeFakeWriter();
  const state = makeState();

  const updated = await drainTranscript(writer, state, path);
  assert.equal(calls.length, 0, "missing file should produce no calls");
  assert.equal(updated.transcriptOffset, 0, "offset should remain 0 for missing file");
});

// ---------------------------------------------------------------------------
// Test 9 — State propagation: sessionId/turnId passed through to store
// ---------------------------------------------------------------------------

test("state sessionId and turnId are forwarded to recordLlmMessage", async () => {
  const entry = assistantEntry("msg-ids", "claude-3-5-haiku-20241022", 10, 5);
  const path = await writeTmpTranscript([toLine(entry)]);

  try {
    const { writer, calls } = makeFakeWriter();
    const state = makeState({
      centralSessionId: "session-abc",
      currentTurnId: "turn-xyz",
    });
    await drainTranscript(writer, state, path);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.sessionId, "session-abc");
    assert.equal(calls[0]!.turnId, "turn-xyz");
  } finally {
    await unlink(path).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Test 10 — Null currentTurnId: turnId omitted (undefined) from payload
// ---------------------------------------------------------------------------

test("null currentTurnId is passed as undefined to recordLlmMessage", async () => {
  const entry = assistantEntry("msg-no-turn", "claude-3-5-haiku-20241022", 10, 5);
  const path = await writeTmpTranscript([toLine(entry)]);

  try {
    const { writer, calls } = makeFakeWriter();
    const state = makeState({ currentTurnId: null });
    await drainTranscript(writer, state, path);

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]!.turnId,
      undefined,
      "null currentTurnId should be passed as undefined",
    );
  } finally {
    await unlink(path).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// C1 regression (drain): trailing-newline incremental growth doesn't skip
// ---------------------------------------------------------------------------

test("C1 regression: trailing-newline file growth doesn't skip first new entry", async () => {
  const entry1 = assistantEntry("msg-tnl-1", "claude-3-5-haiku-20241022", 10, 5);
  const entry2 = assistantEntry("msg-tnl-2", "claude-3-5-haiku-20241022", 20, 10);
  const path = join(tmpdir(), `drain-trailing-newline-${randomUUID()}.jsonl`);

  try {
    // Write entry1 WITH a trailing newline (real-world Claude Code transcript format).
    await writeFile(path, toLine(entry1) + "\n", "utf8");

    const { writer, calls } = makeFakeWriter();
    const state0 = makeState();

    const state1 = await drainTranscript(writer, state0, path);
    assert.equal(calls.length, 1, "first drain should read msg-tnl-1");
    assert.equal(calls[0]!.harnessMessageId, "msg-tnl-1");
    // With the C1 fix, offset should be 1 (real line count), not 2 (phantom).
    assert.equal(state1.transcriptOffset, 1, "offset should be 1 after first trailing-newline drain");

    // Grow transcript: append entry2 with trailing newline.
    await writeFile(path, toLine(entry1) + "\n" + toLine(entry2) + "\n", "utf8");

    const state2 = await drainTranscript(writer, state1, path);
    assert.equal(calls.length, 2, "second drain must capture msg-tnl-2, not skip it");
    assert.equal(calls[1]!.harnessMessageId, "msg-tnl-2", "second entry must be msg-tnl-2");
    assert.equal(state2.transcriptOffset, 2);
  } finally {
    await unlink(path).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// M6: transcript path binding — offset resets when path changes
// ---------------------------------------------------------------------------

test("M6: offset resets to 0 when transcriptPath changes", async () => {
  const entry = assistantEntry("msg-path-1", "claude-3-5-haiku-20241022", 10, 5);
  const path1 = await writeTmpTranscript([toLine(entry)]);
  const entry2 = assistantEntry("msg-path-2", "claude-3-5-haiku-20241022", 20, 10);
  const path2 = await writeTmpTranscript([toLine(entry2)]);

  try {
    const { writer, calls } = makeFakeWriter();
    // State has an advanced offset from a previous path.
    const state = makeState({ transcriptPath: path1, transcriptOffset: 999 });

    // Drain with a DIFFERENT path — offset should reset to 0 and read from start.
    const updated = await drainTranscript(writer, state, path2);
    assert.equal(calls.length, 1, "new path should read from beginning");
    assert.equal(calls[0]!.harnessMessageId, "msg-path-2");
    assert.equal(updated.transcriptPath, path2, "transcriptPath should update to new path");
  } finally {
    await unlink(path1).catch(() => undefined);
    await unlink(path2).catch(() => undefined);
  }
});
