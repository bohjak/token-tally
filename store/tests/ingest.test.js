// @ts-check
/**
 * Tests: ingest failure-routing, writer status, migration concurrency,
 * llm_messages COALESCE upsert semantics, and token/cost validation.
 *
 * Covers criteria added by the 2026-06-12 architectural review:
 *
 *   criterion-1: withDbOrSpool only spools on retryable errors; non-retryable
 *                errors propagate and cause the file to be quarantined via ingest.
 *   criterion-2: ingest reports error (not success) when the DB is not writable.
 *   criterion-3: writer exposes open/writable status.
 *   criterion-4: migrations use IMMEDIATE transaction with in-transaction
 *                version re-check (concurrent idempotency).
 *   criterion-5: llm_messages upsert preserves turn_id / ts on replay.
 *   criterion-6: negative and float cost/token values are validated.
 */
"use strict";

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const { AnalyticsWriter } = require("../dist/src/index");
const { ingestFile, ingestDir } = require("../dist/src/ingest");
const { runMigrations } = require("../dist/src/index");
const { makeTempDir, openDb, countRows, seedMinimalData } = require("./helpers");

// ---------------------------------------------------------------------------
// Helper: fresh isolated writer
// ---------------------------------------------------------------------------

/**
 * @param {string} dir
 * @param {string} name
 */
async function freshWriter(dir, name) {
  const dbPath = path.join(dir, `${name}.db`);
  const spoolDir = path.join(dir, `${name}-spool`);
  const writer = await AnalyticsWriter.open({ dbPath, spoolDir, harnessName: "pi" });
  return { writer, dbPath, spoolDir };
}

// ---------------------------------------------------------------------------
// criterion-3: writer.status exposes writable state
// ---------------------------------------------------------------------------

describe("AnalyticsWriter.status", () => {
  /** @type {{ dir: string; cleanup: () => void }} */
  let tmp;
  before(() => { tmp = makeTempDir(); });
  after(() => { tmp.cleanup(); });

  test("status.writable = true for a normal DB-backed writer", async () => {
    const { writer } = await freshWriter(tmp.dir, "status-ok");
    assert.equal(writer.status.writable, true);
    assert.equal(writer.status.reason, undefined);
    await writer.close();
  });

  test("status.writable = false with a reason when DB file is corrupt", async () => {
    // Write a non-SQLite file so better-sqlite3 cannot open it.
    const dbPath = path.join(tmp.dir, "corrupt-status.db");
    fs.writeFileSync(dbPath, "not a sqlite database\n", "utf8");
    const spoolDir = path.join(tmp.dir, "corrupt-status-spool");

    const writer = await AnalyticsWriter.open({ dbPath, spoolDir, harnessName: "pi" });
    assert.equal(writer.status.writable, false, "corrupt DB must result in spool-only mode");
    assert.ok(
      typeof writer.status.reason === "string" && writer.status.reason.length > 0,
      `reason must be a non-empty string, got: ${writer.status.reason}`
    );
    await writer.close();
  });
});

// ---------------------------------------------------------------------------
// criterion-1 + criterion-2: ingest failure routing
// ---------------------------------------------------------------------------

describe("ingest failure routing", () => {
  /** @type {{ dir: string; cleanup: () => void }} */
  let tmp;
  before(() => { tmp = makeTempDir(); });
  after(() => { tmp.cleanup(); });

  test("ingestDir with FK-violating record quarantines the file; no re-spool; ingested=0", async () => {
    const dbPath = path.join(tmp.dir, "fk-quarantine.db");
    const spoolDir = path.join(tmp.dir, "fk-spool");
    const failedDir = path.join(tmp.dir, "fk-failed");
    fs.mkdirSync(spoolDir, { recursive: true });

    // Seed a migrated DB with the harness row so FK on harness_id passes, but
    // the session_id we will use in the bad record does not exist.
    const setup = await AnalyticsWriter.open({ dbPath, spoolDir, harnessName: "pi" });
    await setup.recordHarness({ name: "pi", displayName: "Pi" });
    await setup.close();

    // A spool record referencing a non-existent session UUID — FK violation.
    const badSpoolFile = path.join(spoolDir, "pi-999-1234.ndjson.closed");
    fs.writeFileSync(
      badSpoolFile,
      JSON.stringify({
        type: "llm-message",
        payload: {
          harnessId: "pi",
          sessionId: "00000000-0000-0000-0000-000000000000", // does not exist
          harnessMessageId: "bad-msg-fk-1",
          ts: Date.now(),
          inputTokens: 10,
          outputTokens: 5,
          costInputMicros: 100,
          costOutputMicros: 50,
          costSource: "writer",
        },
      }) + "\n",
      "utf8"
    );

    const result = await ingestDir(spoolDir, { dbPath, spoolDir, failedDir });

    // The file must be quarantined — NOT counted as ingested, NOT re-spooled.
    assert.equal(result.ingested, 0, "bad record must not be counted as ingested");
    assert.equal(result.quarantined, 1, "bad file must be quarantined");
    assert.equal(fs.existsSync(badSpoolFile), false, "spool file must be moved out of spool dir");
    // The failed dir must contain the quarantined file + metadata sidecar.
    const failedFiles = fs.existsSync(failedDir) ? fs.readdirSync(failedDir) : [];
    assert.ok(failedFiles.length >= 1, `failed dir must have quarantined file, got: ${JSON.stringify(failedFiles)}`);
    // No new .ndjson.closed files should have been written (no re-spool).
    const spoolAfter = fs.readdirSync(spoolDir).filter(f => f.endsWith(".ndjson.closed"));
    assert.equal(spoolAfter.length, 0, `no closed spool files should remain or be written; found: ${JSON.stringify(spoolAfter)}`);
  });

  test("ingestDir with unavailable DB reports error; ingested=0; spool files untouched", async () => {
    // A non-SQLite file forces spool-only mode.
    const dbPath = path.join(tmp.dir, "corrupt-ingest.db");
    fs.writeFileSync(dbPath, "not sqlite\n", "utf8");

    const spoolDir = path.join(tmp.dir, "corrupt-spool");
    fs.mkdirSync(spoolDir, { recursive: true });

    const spoolFile = path.join(spoolDir, "pi-1-99.ndjson.closed");
    fs.writeFileSync(
      spoolFile,
      JSON.stringify({ type: "harness", payload: { name: "pi", displayName: "Pi" } }) + "\n",
      "utf8"
    );

    const result = await ingestDir(spoolDir, { dbPath, spoolDir });

    assert.equal(result.ingested, 0, "ingested must be 0 when DB unavailable");
    assert.ok(result.errors.length >= 1, "must report at least one error");
    assert.match(
      result.errors[0].message,
      /not writable|writable/i,
      `error must mention writable state, got: "${result.errors[0].message}"`
    );
    // The spool file must still be present — not consumed or deleted.
    assert.equal(
      fs.existsSync(spoolFile),
      true,
      "spool file must remain when DB is unavailable"
    );
  });

  test("ingestFile with unavailable DB reports error; ingested=0; file untouched", async () => {
    const dbPath = path.join(tmp.dir, "corrupt-ingest2.db");
    fs.writeFileSync(dbPath, "not sqlite\n", "utf8");

    const spoolDir = path.join(tmp.dir, "corrupt-spool2");
    fs.mkdirSync(spoolDir, { recursive: true });

    const spoolFile = path.join(spoolDir, "pi-2-99.ndjson.closed");
    fs.writeFileSync(
      spoolFile,
      JSON.stringify({ type: "harness", payload: { name: "pi", displayName: "Pi" } }) + "\n",
      "utf8"
    );

    const result = await ingestFile(spoolFile, { dbPath, spoolDir });

    assert.equal(result.ingested, 0, "ingested must be 0 when DB unavailable");
    assert.ok(result.errors.length >= 1, "must report at least one error");
    assert.equal(fs.existsSync(spoolFile), true, "spool file must remain when DB is unavailable");
  });
});

// ---------------------------------------------------------------------------
// criterion-4: migration concurrent idempotency
// ---------------------------------------------------------------------------

describe("migration concurrent-race idempotency", () => {
  /** @type {{ dir: string; cleanup: () => void }} */
  let tmp;
  before(() => { tmp = makeTempDir(); });
  after(() => { tmp.cleanup(); });

  test("two concurrent connections both calling runMigrations leave schema_version=1", () => {
    const dbPath = path.join(tmp.dir, "concurrent-mig.db");

    // Two separate better-sqlite3 connections to the same file simulate two
    // writer processes racing to run the first migration.
    const db1 = new Database(dbPath);
    db1.pragma("foreign_keys = ON");
    const db2 = new Database(dbPath);
    db2.pragma("foreign_keys = ON");

    // Both run sequentially in this process (no true parallelism), but the
    // BEGIN IMMEDIATE + in-tx version re-check ensures the second call is a
    // no-op even when both entered runMigrations seeing version=0.
    runMigrations(db1);
    runMigrations(db2); // must not throw "table already exists" or "duplicate column"

    const versionRow = /** @type {{ value: string } | undefined} */ (
      db1
        .prepare("SELECT value FROM schema_metadata WHERE key='schema_version'")
        .get()
    );

    db1.close();
    db2.close();

    assert.equal(String(versionRow?.value), "1", "schema_version must be 1 after concurrent runs");
  });

  test("runMigrations on an already-migrated DB is a no-op (idempotency)", () => {
    const dbPath = path.join(tmp.dir, "already-migrated.db");
    const db = new Database(dbPath);
    db.pragma("foreign_keys = ON");

    runMigrations(db); // first run — applies v1
    runMigrations(db); // second run — must skip without error

    const versionRow = /** @type {{ value: string } | undefined} */ (
      db
        .prepare("SELECT value FROM schema_metadata WHERE key='schema_version'")
        .get()
    );
    db.close();
    assert.equal(String(versionRow?.value), "1");
  });
});

// ---------------------------------------------------------------------------
// criterion-5: llm_messages COALESCE upsert semantics
// ---------------------------------------------------------------------------

describe("llm_messages COALESCE upsert semantics", () => {
  /** @type {{ dir: string; cleanup: () => void }} */
  let tmp;
  before(() => { tmp = makeTempDir(); });
  after(() => { tmp.cleanup(); });

  test("backfill with null turn_id preserves the stored turn_id", async () => {
    const { writer, dbPath } = await freshWriter(tmp.dir, "coalesce-turn");
    const { sessionId, turnId } = await seedMinimalData(writer, { sessionSuffix: "coalesce1" });

    // Initial write: full attribution with a real turn_id.
    await writer.recordLlmMessage({
      harnessId: "pi",
      sessionId,
      turnId,
      harnessMessageId: "msg-coalesce-1",
      ts: 1_700_000_000_000,
      inputTokens: 10,
      outputTokens: 5,
      costInputMicros: 100,
      costOutputMicros: 50,
      costSource: "writer",
    });

    // Backfill: same message id, NO turn_id — simulates a replay that only
    // updates token counts but does not re-resolve turn linkage.
    await writer.recordLlmMessage({
      harnessId: "pi",
      sessionId,
      turnId: undefined,  // must NOT overwrite the stored turn_id
      harnessMessageId: "msg-coalesce-1",
      ts: 1_700_000_000_000,
      inputTokens: 20,    // updated
      outputTokens: 10,   // updated
      costInputMicros: 200,
      costOutputMicros: 100,
      costSource: "writer",
    });

    await writer.close();

    const db = openDb(dbPath);
    const row = /** @type {{ turn_id: string | null; input_tokens: number }} */ (
      db
        .prepare("SELECT turn_id, input_tokens FROM llm_messages WHERE harness_message_id='msg-coalesce-1'")
        .get()
    );
    db.close();

    assert.equal(row.turn_id, turnId, "turn_id must be preserved when backfill sends null");
    assert.equal(row.input_tokens, 20, "input_tokens must be updated by the backfill");
  });

  test("ts=0 sentinel preserves the stored ts on replay", async () => {
    const { writer, dbPath } = await freshWriter(tmp.dir, "coalesce-ts");
    const { sessionId, turnId } = await seedMinimalData(writer, { sessionSuffix: "coalesce2" });

    const realTs = 1_700_000_000_000;

    // Initial write with a real timestamp.
    await writer.recordLlmMessage({
      harnessId: "pi",
      sessionId,
      turnId,
      harnessMessageId: "msg-ts-sentinel",
      ts: realTs,
      inputTokens: 10,
      costInputMicros: 100,
      costSource: "writer",
    });

    // Replay with ts=0 (sentinel meaning "do not change timestamp").
    await writer.recordLlmMessage({
      harnessId: "pi",
      sessionId,
      turnId,
      harnessMessageId: "msg-ts-sentinel",
      ts: 0,              // sentinel — must NOT overwrite realTs
      inputTokens: 20,    // updated
      costInputMicros: 200,
      costSource: "writer",
    });

    await writer.close();

    const db = openDb(dbPath);
    const row = /** @type {{ ts: number; input_tokens: number }} */ (
      db
        .prepare("SELECT ts, input_tokens FROM llm_messages WHERE harness_message_id='msg-ts-sentinel'")
        .get()
    );
    db.close();

    assert.equal(row.ts, realTs, "ts must not be overwritten when ts=0 sentinel is sent");
    assert.equal(row.input_tokens, 20, "input_tokens must be updated by the replay");
  });

  test("non-null turn_id on replay overwrites a null-turn-id row (attribution upgrade)", async () => {
    const { writer, dbPath } = await freshWriter(tmp.dir, "coalesce-upgrade");
    const { sessionId, turnId } = await seedMinimalData(writer, { sessionSuffix: "coalesce3" });

    // First write: placeholder with no turn_id.
    await writer.recordLlmMessage({
      harnessId: "pi",
      sessionId,
      harnessMessageId: "msg-upgrade-1",
      ts: 1_700_000_000_000,
      inputTokens: 10,
      costInputMicros: 100,
      costSource: "unknown",
    });

    // Backfill: now we know the turn_id — must be written.
    await writer.recordLlmMessage({
      harnessId: "pi",
      sessionId,
      turnId,
      harnessMessageId: "msg-upgrade-1",
      ts: 1_700_000_000_000,
      inputTokens: 20,
      costInputMicros: 200,
      costSource: "writer",
    });

    await writer.close();

    const db = openDb(dbPath);
    const row = /** @type {{ turn_id: string | null; cost_source: string }} */ (
      db
        .prepare("SELECT turn_id, cost_source FROM llm_messages WHERE harness_message_id='msg-upgrade-1'")
        .get()
    );
    db.close();

    assert.equal(row.turn_id, turnId, "non-null turn_id must overwrite a null placeholder");
    assert.equal(row.cost_source, "writer", "cost_source must be updatable by backfill");
  });
});

// ---------------------------------------------------------------------------
// criterion-6: token/cost validation
// ---------------------------------------------------------------------------

describe("token/cost field validation", () => {
  /** @type {{ dir: string; cleanup: () => void }} */
  let tmp;
  before(() => { tmp = makeTempDir(); });
  after(() => { tmp.cleanup(); });

  async function writerWithSession(name) {
    const dbPath = path.join(tmp.dir, `${name}.db`);
    const spoolDir = path.join(tmp.dir, `${name}-spool`);
    const writer = await AnalyticsWriter.open({ dbPath, spoolDir, harnessName: "pi" });
    await writer.recordHarness({ name: "pi", displayName: "Pi" });
    const { id: sessionId } = await writer.recordSession({
      harnessId: "pi",
      harnessSessionId: `${name}-sess`,
      startedAt: Date.now(),
    });
    return { writer, dbPath, sessionId };
  }

  test("float cost values are rounded to the nearest integer", async () => {
    const { writer, dbPath, sessionId } = await writerWithSession("coerce-float");

    await writer.recordLlmMessage({
      harnessId: "pi",
      sessionId,
      harnessMessageId: "coerce-float-msg-1",
      ts: Date.now(),
      costInputMicros: 1234.7,   // rounds to 1235
      costOutputMicros: 100.4,   // rounds to 100
      costSource: "writer",
    });

    await writer.close();

    const db = openDb(dbPath);
    const row = /** @type {{ cost_input_micros: number; cost_output_micros: number; cost_total_micros: number }} */ (
      db
        .prepare("SELECT cost_input_micros, cost_output_micros, cost_total_micros FROM llm_messages WHERE harness_message_id='coerce-float-msg-1'")
        .get()
    );
    db.close();

    assert.equal(row.cost_input_micros, 1235, "1234.7 must round to 1235");
    assert.equal(row.cost_output_micros, 100, "100.4 must round to 100");
    assert.equal(row.cost_total_micros, 1335, "total must equal sum of rounded parts");
  });

  test("negative cost value throws RangeError", async () => {
    const { writer, sessionId } = await writerWithSession("reject-neg-cost");

    await assert.rejects(
      () => writer.recordLlmMessage({
        harnessId: "pi",
        sessionId,
        harnessMessageId: "neg-cost-msg-1",
        ts: Date.now(),
        costInputMicros: -100,
        costSource: "writer",
      }),
      (err) => {
        assert.ok(err instanceof RangeError, `expected RangeError, got ${err}`);
        assert.match(String(err.message), /non-negative|negative/i);
        return true;
      }
    );

    await writer.close();
  });

  test("negative token count throws RangeError", async () => {
    const { writer, sessionId } = await writerWithSession("reject-neg-tokens");

    await assert.rejects(
      () => writer.recordLlmMessage({
        harnessId: "pi",
        sessionId,
        harnessMessageId: "neg-tok-msg-1",
        ts: Date.now(),
        inputTokens: -1,
        costSource: "writer",
      }),
      (err) => {
        assert.ok(err instanceof RangeError, `expected RangeError, got ${err}`);
        assert.match(String(err.message), /non-negative|negative/i);
        return true;
      }
    );

    await writer.close();
  });

  test("NaN cost value throws RangeError", async () => {
    const { writer, sessionId } = await writerWithSession("reject-nan");

    await assert.rejects(
      () => writer.recordLlmMessage({
        harnessId: "pi",
        sessionId,
        harnessMessageId: "nan-msg-1",
        ts: Date.now(),
        costInputMicros: NaN,
        costSource: "writer",
      }),
      (err) => {
        assert.ok(err instanceof RangeError, `expected RangeError, got ${err}`);
        return true;
      }
    );

    await writer.close();
  });

  test("float token count is rounded", async () => {
    const { writer, dbPath, sessionId } = await writerWithSession("coerce-tok-float");

    await writer.recordLlmMessage({
      harnessId: "pi",
      sessionId,
      harnessMessageId: "float-tok-msg-1",
      ts: Date.now(),
      inputTokens: 99.9,   // rounds to 100
      outputTokens: 0.5,   // rounds to 1 (0.5 rounds up)
      costSource: "unknown",
    });

    await writer.close();

    const db = openDb(dbPath);
    const row = /** @type {{ input_tokens: number; output_tokens: number }} */ (
      db
        .prepare("SELECT input_tokens, output_tokens FROM llm_messages WHERE harness_message_id='float-tok-msg-1'")
        .get()
    );
    db.close();

    assert.equal(row.input_tokens, 100, "99.9 tokens must round to 100");
    assert.equal(row.output_tokens, 1, "0.5 tokens must round to 1");
  });
});
