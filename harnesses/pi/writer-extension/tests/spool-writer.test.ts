/**
 * spool-writer.test.ts — Additional spool behaviour tests.
 *
 * Focuses on edge cases not covered by cli-writer.test.ts:
 *   - Multiple session upserts (git-capture pattern) produce multiple records.
 *   - Multiple close() calls are idempotent.
 *   - Session-level tool calls and raw events are included in correct order.
 *   - A full simulated Pi session (harness → session → turn → message →
 *     tool → session-end) produces a correctly ordered, ingestable file.
 */

import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createCliAnalyticsWriter } from "../src/cli-writer.ts";

const previousEnv = { ...process.env };
const tempRoots: string[] = [];

afterEach(() => {
  process.env = { ...previousEnv };
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tt-pi-spool-writer-test-"));
  tempRoots.push(root);
  return root;
}

function readClosedRecords(
  spoolDir: string,
): Array<{ type: string; payload: Record<string, unknown> }> {
  const closedFiles = readdirSync(spoolDir).filter((f) =>
    f.endsWith(".ndjson.closed"),
  );
  assert.equal(closedFiles.length, 1, "expected exactly one closed spool file");

  return readFileSync(join(spoolDir, closedFiles[0]!), "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as { type: string; payload: Record<string, unknown> });
}

// ---------------------------------------------------------------------------

test("multiple recordSession calls (upsert pattern) all appear in the file", async () => {
  const root = makeTempRoot();
  process.env.XDG_DATA_HOME = join(root, "data");

  const writer = createCliAnalyticsWriter();

  // Simulate: session_start writes the initial row.
  const r1 = await writer.recordSession({
    harnessId: "pi",
    harnessSessionId: "upsert-session",
    startedAt: 1_000,
  });
  assert.equal(r1.id, "spool:pi:upsert-session");

  // Simulate: async git capture resolves and upserts with repo metadata.
  const r2 = await writer.recordSession({
    harnessId: "pi",
    harnessSessionId: "upsert-session",
    startedAt: 1_000,
    repoName: "my-repo",
  });
  assert.equal(r2.id, "spool:pi:upsert-session", "synthetic ID is stable across upserts");

  // Simulate: session_shutdown writes the end time.
  await writer.recordSession({
    harnessId: "pi",
    harnessSessionId: "upsert-session",
    startedAt: 1_000,
    endedAt: 5_000,
  });

  await writer.close();

  const spoolDir = join(root, "data", "token-tally", "spool");
  const records = readClosedRecords(spoolDir);

  // All three session records must be present and the drain will apply them
  // as sequential ON CONFLICT DO UPDATE upserts.
  const sessionRecords = records.filter((r) => r.type === "session");
  assert.equal(
    sessionRecords.length,
    3,
    "all three session calls (start, git-upsert, shutdown) must appear in the file",
  );
  assert.equal(
    sessionRecords[2]!.payload["endedAt"],
    5_000,
    "final session record must carry endedAt",
  );
});

test("multiple close() calls are idempotent — only one closed file created", async () => {
  const root = makeTempRoot();
  process.env.XDG_DATA_HOME = join(root, "data");

  const writer = createCliAnalyticsWriter();
  await writer.recordHarness({ name: "pi", displayName: "Pi" });
  await writer.close();
  await writer.close(); // second close should be a no-op
  await writer.close(); // third close should also be a no-op

  const spoolDir = join(root, "data", "token-tally", "spool");
  const closedFiles = readdirSync(spoolDir).filter((f) =>
    f.endsWith(".ndjson.closed"),
  );
  assert.equal(
    closedFiles.length,
    1,
    "repeated close() calls must produce exactly one closed file",
  );
});

test("raw events are included in the spool file", async () => {
  const root = makeTempRoot();
  process.env.XDG_DATA_HOME = join(root, "data");

  const writer = createCliAnalyticsWriter();
  const sessionResult = await writer.recordSession({
    harnessId: "pi",
    harnessSessionId: "raw-event-session",
    startedAt: 1_000,
  });
  await writer.recordRawEvent({
    harnessId: "pi",
    sessionId: sessionResult.id,
    kind: "test-event",
    payloadJson: JSON.stringify({ foo: "bar" }),
    ts: 2_000,
  });
  await writer.close();

  const spoolDir = join(root, "data", "token-tally", "spool");
  const records = readClosedRecords(spoolDir);
  assert.equal(records.length, 2);
  assert.equal(records[1]!.type, "raw-event");
  assert.equal(records[1]!.payload["kind"], "test-event");
});

test("full simulated Pi session: harness → session → turn → message → tool → session-end", async () => {
  const root = makeTempRoot();
  process.env.XDG_DATA_HOME = join(root, "data");

  const writer = createCliAnalyticsWriter();

  // session_start
  await writer.recordHarness({ name: "pi", displayName: "Pi", version: "1.2.3" });
  const sessionResult = await writer.recordSession({
    harnessId: "pi",
    harnessSessionId: "full-session",
    startedAt: 1_000,
  });

  // turn_start
  const turnResult = await writer.recordTurn({
    harnessId: "pi",
    sessionId: sessionResult.id,
    harnessTurnId: "full-session:t0",
    turnIndex: 0,
    startedAt: 2_000,
  });

  // message_end
  const msgResult = await writer.recordLlmMessage({
    harnessId: "pi",
    sessionId: sessionResult.id,
    turnId: turnResult.id,
    harnessMessageId: "full-session:t0:m0",
    ts: 3_000,
    modelId: "claude-opus-4-5",
    provider: "anthropic",
    inputTokens: 200,
    outputTokens: 100,
    costInputMicros: 3_000,
    costOutputMicros: 7_500,
    costSource: "harness",
  });
  assert.ok(msgResult.id.startsWith("spool:pi:"));

  // tool_execution_end
  await writer.recordToolCall({
    harnessId: "pi",
    sessionId: sessionResult.id,
    turnId: turnResult.id,
    harnessToolCallId: "tc-xyz",
    toolName: "bash",
    startedAt: 4_000,
    endedAt: 4_200,
    isError: false,
  });

  // turn_end (upsert with endedAt)
  await writer.recordTurn({
    harnessId: "pi",
    sessionId: sessionResult.id,
    harnessTurnId: "full-session:t0",
    turnIndex: 0,
    startedAt: 2_000,
    endedAt: 5_000,
  });

  // session_shutdown (upsert with endedAt)
  await writer.recordSession({
    harnessId: "pi",
    harnessSessionId: "full-session",
    startedAt: 1_000,
    endedAt: 6_000,
  });

  await writer.close();

  const spoolDir = join(root, "data", "token-tally", "spool");
  const records = readClosedRecords(spoolDir);

  const types = records.map((r) => r.type);
  assert.deepEqual(
    types,
    ["harness", "session", "turn", "llm-message", "tool-call", "turn", "session"],
    "records must appear in Pi's natural event-fire order",
  );

  // Verify spool IDs are embedded correctly in child records.
  const [, , turn1] = records;
  assert.equal(
    turn1!.payload["sessionId"],
    "spool:pi:full-session",
    "turn.sessionId must be the session synthetic spool ID",
  );

  const [, , , msg] = records;
  assert.equal(
    msg!.payload["turnId"],
    `spool:spool:pi:full-session:full-session:t0`,
    "message.turnId must be the turn synthetic spool ID",
  );
});
