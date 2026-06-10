/**
 * cli-writer.test.ts — Tests for the SpoolBasedWriter returned by
 * createCliAnalyticsWriter().
 *
 * These tests verify the writer's public contract:
 *   - Synthetic IDs are returned immediately without DB round-trips.
 *   - Records are written to a PID-bearing active spool file.
 *   - close() drains the write queue and rotates the file to .ndjson.closed.
 *   - Lifecycle ordering is preserved in the output file.
 *   - Post-close record calls are silently dropped.
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
  const root = mkdtempSync(join(tmpdir(), "tt-pi-cli-writer-test-"));
  tempRoots.push(root);
  return root;
}

// ---------------------------------------------------------------------------

test("recordSession returns synthetic spool ID without awaiting any DB work", async () => {
  const root = makeTempRoot();
  process.env.XDG_DATA_HOME = join(root, "data");

  const writer = createCliAnalyticsWriter();
  const result = await writer.recordSession({
    harnessId: "pi",
    harnessSessionId: "test-session-1",
    startedAt: 1_000,
  });

  assert.equal(result.id, "spool:pi:test-session-1");

  await writer.close();
});

test("recordTurn returns synthetic spool ID embedding the session synthetic ID", async () => {
  const root = makeTempRoot();
  process.env.XDG_DATA_HOME = join(root, "data");

  const writer = createCliAnalyticsWriter();

  const sessionResult = await writer.recordSession({
    harnessId: "pi",
    harnessSessionId: "test-session-1",
    startedAt: 1_000,
  });

  const turnResult = await writer.recordTurn({
    harnessId: "pi",
    sessionId: sessionResult.id,
    harnessTurnId: "test-session-1:t0",
    turnIndex: 0,
    startedAt: 2_000,
  });

  // Turn synthetic ID embeds the session synthetic ID so the drain daemon
  // can compute the same key from the record alone.
  assert.equal(turnResult.id, `spool:${sessionResult.id}:test-session-1:t0`);

  await writer.close();
});

test("close() rotates active spool file to .ndjson.closed", async () => {
  const root = makeTempRoot();
  process.env.XDG_DATA_HOME = join(root, "data");

  const writer = createCliAnalyticsWriter();
  await writer.recordHarness({ name: "pi", displayName: "Pi" });
  await writer.close();

  const spoolDir = join(root, "data", "token-tally", "spool");
  const files = readdirSync(spoolDir);

  assert.equal(
    files.filter((f) => f.endsWith(".ndjson") && !f.endsWith(".closed")).length,
    0,
    "no active .ndjson files should remain after close()",
  );
  assert.equal(
    files.filter((f) => f.endsWith(".ndjson.closed")).length,
    1,
    "exactly one .ndjson.closed file should exist after close()",
  );
});

test("active spool file contains PID in its filename", async () => {
  const root = makeTempRoot();
  process.env.XDG_DATA_HOME = join(root, "data");

  const writer = createCliAnalyticsWriter();
  await writer.recordHarness({ name: "pi", displayName: "Pi" });
  // close() flushes the async write queue and rotates the active file so we
  // can inspect the filename without racing against the pending appendFile.
  await writer.close();

  const spoolDir = join(root, "data", "token-tally", "spool");
  const allSpoolFiles = readdirSync(spoolDir).filter((f) => f.includes(".ndjson"));

  assert.ok(allSpoolFiles.length > 0, "at least one spool file should be created");
  assert.ok(
    allSpoolFiles.some((f) => f.includes(String(process.pid))),
    `spool filename should contain current PID (${process.pid}); got: ${allSpoolFiles.join(", ")}`,
  );
});

test("writes lifecycle-ordered NDJSON records: session → turn → llm-message", async () => {
  const root = makeTempRoot();
  process.env.XDG_DATA_HOME = join(root, "data");

  const writer = createCliAnalyticsWriter();

  const sessionResult = await writer.recordSession({
    harnessId: "pi",
    harnessSessionId: "ordered-session",
    startedAt: 1_000,
  });

  const turnResult = await writer.recordTurn({
    harnessId: "pi",
    sessionId: sessionResult.id,
    harnessTurnId: "ordered-session:t0",
    turnIndex: 0,
    startedAt: 2_000,
  });

  await writer.recordLlmMessage({
    harnessId: "pi",
    sessionId: sessionResult.id,
    turnId: turnResult.id,
    harnessMessageId: "ordered-session:t0:m0",
    ts: 3_000,
    inputTokens: 100,
    outputTokens: 50,
  });

  await writer.close();

  const spoolDir = join(root, "data", "token-tally", "spool");
  const closedFiles = readdirSync(spoolDir).filter((f) =>
    f.endsWith(".ndjson.closed"),
  );
  assert.equal(closedFiles.length, 1);

  const content = readFileSync(join(spoolDir, closedFiles[0]!), "utf8");
  const records = content
    .trim()
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as { type: string; payload: unknown });

  assert.equal(records.length, 3);
  assert.equal(records[0]!.type, "session", "session record must come first");
  assert.equal(records[1]!.type, "turn", "turn record must come second");
  assert.equal(records[2]!.type, "llm-message", "message record must come third");
});

test("record calls after close() are silently dropped and do not corrupt the closed file", async () => {
  const root = makeTempRoot();
  process.env.XDG_DATA_HOME = join(root, "data");

  const writer = createCliAnalyticsWriter();
  await writer.recordSession({
    harnessId: "pi",
    harnessSessionId: "pre-close-session",
    startedAt: 1_000,
  });

  // Rotate the spool file.
  await writer.close();

  // These should return synthetic IDs (best-effort) and not throw, but must
  // not write to the already-rotated file.
  const lateResult = await writer.recordSession({
    harnessId: "pi",
    harnessSessionId: "post-close-session",
    startedAt: 2_000,
  });
  assert.ok(
    lateResult.id.length > 0,
    "a synthetic ID should still be returned after close()",
  );

  const spoolDir = join(root, "data", "token-tally", "spool");
  const closedFiles = readdirSync(spoolDir).filter((f) =>
    f.endsWith(".ndjson.closed"),
  );
  assert.equal(closedFiles.length, 1, "still exactly one closed file");

  const content = readFileSync(join(spoolDir, closedFiles[0]!), "utf8");
  const records = content
    .trim()
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as { type: string });

  // Only the one pre-close session record should be present.
  assert.equal(records.length, 1, "only pre-close records should be in the file");
  assert.equal(records[0]!.type, "session");
});

test("no closed file created when writer is closed without any writes", async () => {
  const root = makeTempRoot();
  process.env.XDG_DATA_HOME = join(root, "data");

  const writer = createCliAnalyticsWriter();
  await writer.close();

  const spoolDir = join(root, "data", "token-tally", "spool");
  // Directory may not exist at all, or exist but be empty.
  const files = readdirSync(spoolDir).filter((f) => f.includes(".ndjson"));
  assert.equal(
    files.length,
    0,
    "no spool files should remain when nothing was written",
  );
});

test("closed file contains valid NDJSON records with correct payload fields", async () => {
  const root = makeTempRoot();
  process.env.XDG_DATA_HOME = join(root, "data");

  const writer = createCliAnalyticsWriter();

  await writer.recordHarness({ name: "pi", displayName: "Pi", version: "1.0.0" });
  const sessionResult = await writer.recordSession({
    harnessId: "pi",
    harnessSessionId: "payload-check-session",
    startedAt: 1_000,
  });
  const turnResult = await writer.recordTurn({
    harnessId: "pi",
    sessionId: sessionResult.id,
    harnessTurnId: "payload-check-session:t0",
    turnIndex: 0,
    startedAt: 2_000,
  });
  await writer.recordToolCall({
    harnessId: "pi",
    sessionId: sessionResult.id,
    turnId: turnResult.id,
    harnessToolCallId: "tool-call-abc",
    toolName: "read",
    startedAt: 3_000,
    endedAt: 3_100,
    isError: false,
  });

  await writer.close();

  const spoolDir = join(root, "data", "token-tally", "spool");
  const closedFiles = readdirSync(spoolDir).filter((f) =>
    f.endsWith(".ndjson.closed"),
  );
  const content = readFileSync(join(spoolDir, closedFiles[0]!), "utf8");
  const records = content
    .trim()
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as { type: string; payload: Record<string, unknown> });

  assert.equal(records.length, 4);

  const [harness, session, turn, toolCall] = records;

  assert.equal(harness!.type, "harness");
  assert.equal(harness!.payload["name"], "pi");

  assert.equal(session!.type, "session");
  assert.equal(session!.payload["harnessId"], "pi");
  assert.equal(session!.payload["harnessSessionId"], "payload-check-session");
  assert.equal(session!.payload["startedAt"], 1_000);

  assert.equal(turn!.type, "turn");
  assert.equal(turn!.payload["sessionId"], "spool:pi:payload-check-session");
  assert.equal(turn!.payload["harnessTurnId"], "payload-check-session:t0");

  assert.equal(toolCall!.type, "tool-call");
  assert.equal(toolCall!.payload["harnessToolCallId"], "tool-call-abc");
  assert.equal(toolCall!.payload["toolName"], "read");
});
