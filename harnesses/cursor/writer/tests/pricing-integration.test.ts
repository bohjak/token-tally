/**
 * tests/pricing-integration.test.ts — Integration tests for the stop handler's
 * backfill + pricing logic.
 *
 * Tests the `runBackfill` function exported from stop.ts using:
 *   - A real AnalyticsWriter against a temp SQLite DB.
 *   - Transcript files written to a temp directory.
 *   - A fake XDG_CONFIG_HOME for subscription config.
 *
 * Verifies:
 *   1. Placeholder row is upgraded to cost_source='writer' with correct micros
 *      when transcript has a known model and non-zero token counts.
 *   2. Placeholder row stays cost_source='unknown' for an unknown model.
 *   3. Subscription-covered rows get cost_source='subscription_covered' with
 *      list-price cost columns still populated.
 *   4. No data → placeholder unchanged (cost_source='unknown', zero tokens).
 *   5. Idempotency — calling backfill twice produces the same row, no duplicates.
 *   6. DB cost integrity constraint (total = sum of breakdown) never violated.
 *
 * Import paths use .js extension — these run from dist/tests/.
 */

import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { AnalyticsWriter } from "@token-tally/store";

import { runBackfill } from "../src/hooks/stop.js";

// ---------------------------------------------------------------------------
// Known pricing constants for assertions
//
// claude-sonnet-4-20250514 resolves (via alias "claude-sonnet-4") to:
//   claude-sonnet-4-5  inputPerMTokUSD=3, outputPerMTokUSD=15
//
// tokensToMicros(n, rate) = Math.round(n * rate)
//   1000 input  × 3  = 3_000  micros
//    500 output × 15 = 7_500  micros
// ---------------------------------------------------------------------------

const KNOWN_MODEL = "claude-sonnet-4-20250514";
const UNKNOWN_MODEL = "future-ai-model-xyz-9999";
const EXPECTED_INPUT_MICROS = 3_000;   // 1000 tokens × $3/MTok
const EXPECTED_OUTPUT_MICROS = 7_500;  //  500 tokens × $15/MTok

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create an isolated temp directory and return XDG env paths + DB path. */
function makeIsolatedEnv(): {
  tmpDir: string;
  xdgDataHome: string;
  xdgStateHome: string;
  xdgConfigHome: string;
  dbPath: string;
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-pricing-"));
  const xdgDataHome = path.join(tmpDir, "data");
  const xdgStateHome = path.join(tmpDir, "state");
  const xdgConfigHome = path.join(tmpDir, "config");
  fs.mkdirSync(xdgDataHome, { recursive: true });
  fs.mkdirSync(xdgStateHome, { recursive: true });
  fs.mkdirSync(xdgConfigHome, { recursive: true });
  return {
    tmpDir,
    xdgDataHome,
    xdgStateHome,
    xdgConfigHome,
    dbPath: path.join(xdgDataHome, "token-tally", "events.db"),
  };
}

/** Open an AnalyticsWriter against the given XDG_DATA_HOME. */
async function openWriter(xdgDataHome: string): Promise<AnalyticsWriter> {
  const old = process.env["XDG_DATA_HOME"];
  process.env["XDG_DATA_HOME"] = xdgDataHome;
  const writer = await AnalyticsWriter.open({ harnessName: "cursor" });
  if (old === undefined) delete process.env["XDG_DATA_HOME"];
  else process.env["XDG_DATA_HOME"] = old;
  return writer;
}

/**
 * Seed the DB with:
 *   - harness row for "cursor"
 *   - session row keyed by harnessSessionId (= conversationId)
 *   - one placeholder llm_message (zero tokens, cost_source='unknown')
 *
 * Returns the ToTally session UUID (sessions.id) and the harness_message_id.
 */
async function seedPlaceholder(
  writer: AnalyticsWriter,
  conversationId: string,
  generationId: string,
): Promise<{ centralSessionId: string; harnessMessageId: string }> {
  await writer.recordHarness({ name: "cursor", displayName: "Cursor" });

  const sessionResult = await writer.recordSession({
    harnessId: "cursor",
    harnessSessionId: conversationId,
    startedAt: Date.now(),
  });

  const harnessMessageId = `cursor:${conversationId}:${generationId}:assistant`;

  await writer.recordLlmMessage({
    sessionId: sessionResult.id,
    harnessId: "cursor",
    harnessMessageId,
    ts: Date.now(),
    inputTokens: 0,
    outputTokens: 0,
    costSource: "unknown",
  });

  return { centralSessionId: sessionResult.id, harnessMessageId };
}

/** Query a single llm_messages row by harness_message_id. */
function readMessageRow(dbPath: string, harnessMessageId: string): {
  cost_source: string;
  cost_input_micros: number;
  cost_output_micros: number;
  cost_total_micros: number;
  input_tokens: number;
  output_tokens: number;
  model_id: string | null;
  subscription_id: string | null;
} | null {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA query_only = 1");
  const row = db
    .prepare(
      `SELECT cost_source, cost_input_micros, cost_output_micros, cost_total_micros,
              input_tokens, output_tokens, model_id, subscription_id
       FROM llm_messages WHERE harness_message_id = ?`,
    )
    .get(harnessMessageId) as {
    cost_source: string;
    cost_input_micros: number;
    cost_output_micros: number;
    cost_total_micros: number;
    input_tokens: number;
    output_tokens: number;
    model_id: string | null;
    subscription_id: string | null;
  } | null;
  db.close();
  return row;
}

/** Write a JSONL transcript file with the given entries. */
async function writeTranscript(filePath: string, entries: object[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await writeFile(filePath, content, "utf8");
}

// ---------------------------------------------------------------------------
// T8-1: Known model → cost_source = 'writer' with correct micros
// ---------------------------------------------------------------------------

describe("runBackfill — known model from transcript", () => {
  let tmpDir = "";
  let dbPath = "";
  let writer: AnalyticsWriter | null = null;
  let centralSessionId = "";
  let harnessMessageId = "";
  const convId = randomUUID();
  const genId = randomUUID();

  before(async () => {
    const env = makeIsolatedEnv();
    tmpDir = env.tmpDir;
    dbPath = env.dbPath;
    writer = await openWriter(env.xdgDataHome);
    ({ centralSessionId, harnessMessageId } = await seedPlaceholder(writer, convId, genId));
  });

  after(async () => {
    await writer?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("upgrades placeholder to writer cost for known model", async () => {
    assert.ok(writer !== null);

    const transcriptPath = path.join(tmpDir, "transcript.jsonl");
    await writeTranscript(transcriptPath, [
      {
        role: "assistant",
        id: genId,
        model: KNOWN_MODEL,
        usage: { input_tokens: 1000, output_tokens: 500 },
      },
    ]);

    await runBackfill(writer, convId, centralSessionId, {
      transcript_path: transcriptPath,
      conversation_id: convId,
    });

    const row = readMessageRow(dbPath, harnessMessageId);
    assert.ok(row !== null, "llm_message row must exist");
    assert.equal(row?.cost_source, "writer", "should be upgraded to writer");
    assert.equal(row?.input_tokens, 1000, "input tokens backfilled");
    assert.equal(row?.output_tokens, 500, "output tokens backfilled");
    assert.equal(row?.cost_input_micros, EXPECTED_INPUT_MICROS, "input micros correct");
    assert.equal(row?.cost_output_micros, EXPECTED_OUTPUT_MICROS, "output micros correct");
    assert.equal(
      row?.cost_total_micros,
      EXPECTED_INPUT_MICROS + EXPECTED_OUTPUT_MICROS,
      "total = sum of breakdown",
    );
    assert.equal(row?.model_id, KNOWN_MODEL, "model_id stored");
  });
});

// ---------------------------------------------------------------------------
// T8-2: Unknown model → cost_source stays 'unknown', tokens still backfilled
// ---------------------------------------------------------------------------

describe("runBackfill — unknown model from transcript", () => {
  let tmpDir = "";
  let dbPath = "";
  let writer: AnalyticsWriter | null = null;
  let centralSessionId = "";
  let harnessMessageId = "";
  const convId = randomUUID();
  const genId = randomUUID();

  before(async () => {
    const env = makeIsolatedEnv();
    tmpDir = env.tmpDir;
    dbPath = env.dbPath;
    writer = await openWriter(env.xdgDataHome);
    ({ centralSessionId, harnessMessageId } = await seedPlaceholder(writer, convId, genId));
  });

  after(async () => {
    await writer?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("keeps cost_source=unknown for unrecognised model", async () => {
    assert.ok(writer !== null);

    const transcriptPath = path.join(tmpDir, "transcript.jsonl");
    await writeTranscript(transcriptPath, [
      {
        role: "assistant",
        id: genId,
        model: UNKNOWN_MODEL,
        usage: { input_tokens: 2000, output_tokens: 800 },
      },
    ]);

    await runBackfill(writer, convId, centralSessionId, {
      transcript_path: transcriptPath,
      conversation_id: convId,
    });

    const row = readMessageRow(dbPath, harnessMessageId);
    assert.ok(row !== null, "row must exist");
    assert.equal(row?.cost_source, "unknown", "unknown model → cost_source=unknown");
    // Tokens are still backfilled even though pricing is unknown.
    assert.equal(row?.input_tokens, 2000, "input tokens backfilled");
    assert.equal(row?.output_tokens, 800, "output tokens backfilled");
    // Cost columns must remain zero (can't price an unknown model).
    assert.equal(row?.cost_input_micros, 0, "zero input micros for unknown model");
    assert.equal(row?.cost_output_micros, 0, "zero output micros for unknown model");
    assert.equal(row?.cost_total_micros, 0, "zero total micros for unknown model");
  });
});

// ---------------------------------------------------------------------------
// T8-3: Subscription configured → cost_source = 'subscription_covered'
//        with list-price cost columns preserved
// ---------------------------------------------------------------------------

describe("runBackfill — subscription_covered", () => {
  let tmpDir = "";
  let dbPath = "";
  let writer: AnalyticsWriter | null = null;
  let centralSessionId = "";
  let harnessMessageId = "";
  const convId = randomUUID();
  const genId = randomUUID();
  let savedConfigHome: string | undefined;

  before(async () => {
    const env = makeIsolatedEnv();
    tmpDir = env.tmpDir;
    dbPath = env.dbPath;

    // Write a cursor-pro subscription config.
    const configDir = path.join(env.xdgConfigHome, "token-tally");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({
        harnesses: {
          cursor: {
            subscription: "cursor-pro",
            subscriptionFixedCostUSD: 20,
            subscriptionStartDay: 1,
          },
        },
      }),
      "utf8",
    );

    // Override XDG_CONFIG_HOME so loadCursorSubscriptionConfig finds the config.
    savedConfigHome = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = env.xdgConfigHome;

    writer = await openWriter(env.xdgDataHome);
    ({ centralSessionId, harnessMessageId } = await seedPlaceholder(writer, convId, genId));
  });

  after(async () => {
    // Restore XDG_CONFIG_HOME.
    if (savedConfigHome === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = savedConfigHome;
    await writer?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("subscription_covered rows still carry list-price costs", async () => {
    assert.ok(writer !== null);

    const transcriptPath = path.join(tmpDir, "transcript.jsonl");
    await writeTranscript(transcriptPath, [
      {
        role: "assistant",
        id: genId,
        model: KNOWN_MODEL,
        usage: { input_tokens: 1000, output_tokens: 500 },
      },
    ]);

    await runBackfill(writer, convId, centralSessionId, {
      transcript_path: transcriptPath,
      conversation_id: convId,
    });

    const row = readMessageRow(dbPath, harnessMessageId);
    assert.ok(row !== null, "row must exist");
    assert.equal(row?.cost_source, "subscription_covered", "cost_source=subscription_covered");
    // List-price equivalent must be stored (schema contract: always hold PAYG).
    assert.equal(row?.cost_input_micros, EXPECTED_INPUT_MICROS, "list-price input preserved");
    assert.equal(row?.cost_output_micros, EXPECTED_OUTPUT_MICROS, "list-price output preserved");
    assert.equal(
      row?.cost_total_micros,
      EXPECTED_INPUT_MICROS + EXPECTED_OUTPUT_MICROS,
      "total = sum of breakdown",
    );
    // subscription_id FK must be set.
    assert.ok(
      row?.subscription_id !== null && row.subscription_id !== undefined,
      "subscription_id must be non-null",
    );
  });
});

// ---------------------------------------------------------------------------
// T8-4: No backfill data → placeholder row unchanged
// ---------------------------------------------------------------------------

describe("runBackfill — no backfill data", () => {
  let tmpDir = "";
  let dbPath = "";
  let writer: AnalyticsWriter | null = null;
  let centralSessionId = "";
  let harnessMessageId = "";
  const convId = randomUUID();
  const genId = randomUUID();

  before(async () => {
    const env = makeIsolatedEnv();
    tmpDir = env.tmpDir;
    dbPath = env.dbPath;
    writer = await openWriter(env.xdgDataHome);
    ({ centralSessionId, harnessMessageId } = await seedPlaceholder(writer, convId, genId));
  });

  after(async () => {
    await writer?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("placeholder unchanged when transcript is absent and no SQLite data", async () => {
    assert.ok(writer !== null);

    // No transcript_path, no SQLite data for this convId → no records.
    await runBackfill(writer, convId, centralSessionId, {
      transcript_path: null,
      conversation_id: convId,
    });

    const row = readMessageRow(dbPath, harnessMessageId);
    assert.ok(row !== null, "row must still exist");
    assert.equal(row?.cost_source, "unknown", "should remain unknown");
    assert.equal(row?.input_tokens, 0, "tokens remain 0");
    assert.equal(row?.cost_total_micros, 0, "cost remains 0");
  });
});

// ---------------------------------------------------------------------------
// T8-5: Idempotency — second backfill produces no new rows, values unchanged
// ---------------------------------------------------------------------------

describe("runBackfill — idempotency", () => {
  let tmpDir = "";
  let dbPath = "";
  let writer: AnalyticsWriter | null = null;
  let centralSessionId = "";
  let harnessMessageId = "";
  const convId = randomUUID();
  const genId = randomUUID();

  before(async () => {
    const env = makeIsolatedEnv();
    tmpDir = env.tmpDir;
    dbPath = env.dbPath;
    writer = await openWriter(env.xdgDataHome);
    ({ centralSessionId, harnessMessageId } = await seedPlaceholder(writer, convId, genId));
  });

  after(async () => {
    await writer?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("second backfill does not duplicate rows or change values", async () => {
    assert.ok(writer !== null);

    const transcriptPath = path.join(tmpDir, "transcript.jsonl");
    await writeTranscript(transcriptPath, [
      {
        role: "assistant",
        id: genId,
        model: KNOWN_MODEL,
        usage: { input_tokens: 1000, output_tokens: 500 },
      },
    ]);

    const backfillArgs = {
      transcript_path: transcriptPath,
      conversation_id: convId,
    } as const;

    // First backfill.
    await runBackfill(writer, convId, centralSessionId, backfillArgs);

    // Snapshot row count before second run.
    const db1 = new DatabaseSync(dbPath);
    db1.exec("PRAGMA query_only = 1");
    const countBefore = (
      db1
        .prepare("SELECT count(*) as n FROM llm_messages WHERE harness_id='cursor'")
        .get() as { n: number }
    ).n;
    db1.close();

    // Second backfill — must be idempotent.
    await runBackfill(writer, convId, centralSessionId, backfillArgs);

    const db2 = new DatabaseSync(dbPath);
    db2.exec("PRAGMA query_only = 1");
    const countAfter = (
      db2
        .prepare("SELECT count(*) as n FROM llm_messages WHERE harness_id='cursor'")
        .get() as { n: number }
    ).n;
    db2.close();

    assert.equal(countAfter, countBefore, "no new rows created by second backfill");

    const row = readMessageRow(dbPath, harnessMessageId);
    assert.equal(row?.cost_source, "writer", "cost_source unchanged");
    assert.equal(row?.cost_input_micros, EXPECTED_INPUT_MICROS, "cost unchanged");
  });
});

// ---------------------------------------------------------------------------
// T8-6: DB cost integrity — total_micros = sum of four breakdown columns
// ---------------------------------------------------------------------------

describe("runBackfill — cost integrity constraint", () => {
  let tmpDir = "";
  let dbPath = "";
  let writer: AnalyticsWriter | null = null;
  let centralSessionId = "";
  const convId = randomUUID();
  const genId = randomUUID();

  before(async () => {
    const env = makeIsolatedEnv();
    tmpDir = env.tmpDir;
    dbPath = env.dbPath;
    writer = await openWriter(env.xdgDataHome);
    ({ centralSessionId } = await seedPlaceholder(writer, convId, genId));
  });

  after(async () => {
    await writer?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("no llm_message violates cost_total = sum(breakdown) after backfill", async () => {
    assert.ok(writer !== null);

    const transcriptPath = path.join(tmpDir, "transcript.jsonl");
    await writeTranscript(transcriptPath, [
      {
        role: "assistant",
        id: genId,
        model: KNOWN_MODEL,
        usage: { input_tokens: 500, output_tokens: 300 },
      },
    ]);

    await runBackfill(writer, convId, centralSessionId, {
      transcript_path: transcriptPath,
      conversation_id: convId,
    });

    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA query_only = 1");
    const bad = db
      .prepare(
        `SELECT count(*) as n FROM llm_messages
         WHERE cost_total_micros !=
           cost_input_micros + cost_output_micros +
           cost_cache_read_micros + cost_cache_write_micros`,
      )
      .get() as { n: number };
    db.close();

    assert.equal(bad.n, 0, "all rows must satisfy cost_total = sum(breakdown)");
  });
});
