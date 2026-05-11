// @ts-check
/**
 * Tests: spool fallback and drain
 *
 * Covers:
 *   - Writer falls back to spool when DB path is unavailable
 *   - Spool drain on next successful open restores rows to the DB
 *   - Active spool file is NOT drained (only .ndjson.closed)
 *   - SpoolWriter.rotate() produces a .ndjson.closed file
 *   - Drain is idempotent: re-opening after a successful drain sees same rows
 */

"use strict";

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { join } = require("node:path");
const { existsSync, readdirSync } = require("node:fs");
const { AnalyticsWriter, SpoolWriter } = require("../dist/src/index");
const { makeTempDir, openDb, countRows, seedMinimalData } = require("./helpers");

// A path that can never be a valid DB (writing to /dev/null sub-path fails).
const UNREACHABLE_DB = "/dev/null/token-tally.db";

describe("spool fallback and drain", () => {
  /** @type {{ dir: string; cleanup: () => void }} */
  let tmp;

  before(() => {
    tmp = makeTempDir();
  });

  after(() => {
    tmp.cleanup();
  });

  test("writer falls back to spool when DB is unavailable", async () => {
    const spoolDir = join(tmp.dir, "spool-fallback");

    const writer = await AnalyticsWriter.open({
      dbPath: UNREACHABLE_DB,
      spoolDir,
      harnessName: "pi",
    });

    await writer.recordHarness({ name: "pi", displayName: "Pi" });
    await writer.recordSession({
      harnessId: "pi",
      harnessSessionId: "spool-sess-1",
      startedAt: Date.now(),
    });
    await writer.close();

    // A .ndjson.closed file should exist; the DB write was skipped.
    assert.ok(existsSync(spoolDir), "spool dir should exist");
    const closedFiles = readdirSync(spoolDir).filter(
      (/** @type {string} */ f) => f.endsWith(".ndjson.closed")
    );
    assert.ok(closedFiles.length > 0, "should have at least one .ndjson.closed file");
  });

  test("drain on next open restores rows to the DB from spool", async () => {
    const spoolDir = join(tmp.dir, "spool-drain");
    const goodDb = join(tmp.dir, "good-drain.db");

    // --- Phase 1: write to spool (bad DB path) ---
    const w1 = await AnalyticsWriter.open({
      dbPath: UNREACHABLE_DB,
      spoolDir,
      harnessName: "pi",
    });
    await w1.recordHarness({ name: "pi", displayName: "Pi" });
    const { id: spoolSessionId } = await w1.recordSession({
      harnessId: "pi",
      harnessSessionId: "drain-sess-1",
      startedAt: 1_000_000,
    });
    const { id: spoolTurnId } = await w1.recordTurn({
      harnessId: "pi",
      sessionId: spoolSessionId,
      harnessTurnId: "drain-turn-1",
      startedAt: 1_100_000,
    });
    await w1.recordLlmMessage({
      harnessId: "pi",
      sessionId: spoolSessionId,
      turnId: spoolTurnId,
      harnessMessageId: "drain-msg-1",
      ts: 1_200_000,
      inputTokens: 50,
      costInputMicros: 500,
      costSource: "writer",
    });
    await w1.close();

    // Confirm rows are NOT in the good DB yet.
    const db0 = openDb(goodDb);
    // goodDb doesn't even exist yet at this point — AnalyticsWriter.open will
    // create and migrate it during phase 2.
    db0.close();

    // --- Phase 2: open the good DB — drain should replay spool ---
    const w2 = await AnalyticsWriter.open({ dbPath: goodDb, spoolDir, harnessName: "pi" });
    await w2.close();

    const db = openDb(goodDb);
    assert.equal(countRows(db, "harnesses"), 1, "harness should be drained");
    assert.equal(countRows(db, "sessions"), 1, "session should be drained");
    assert.equal(countRows(db, "turns"), 1, "turn should be drained");
    assert.equal(countRows(db, "llm_messages"), 1, "llm_message should be drained");
    db.close();

    // Spool dir should now be empty (files deleted after successful drain).
    const remaining = readdirSync(spoolDir).filter(
      (/** @type {string} */ f) => f.endsWith(".ndjson.closed")
    );
    assert.equal(remaining.length, 0, "closed spool files should be deleted after drain");
  });

  test("active .ndjson files are not drained", async () => {
    const spoolDir = join(tmp.dir, "spool-active-guard");
    const goodDb = join(tmp.dir, "good-active.db");

    // Create an active spool file manually (simulate a live writer).
    const { mkdirSync, writeFileSync } = require("node:fs");
    mkdirSync(spoolDir, { recursive: true });
    const activeFile = join(spoolDir, "pi-99999.ndjson");
    writeFileSync(activeFile, '{"type":"harness","payload":{"name":"pi","displayName":"Pi"}}\n');

    // Open the good DB. The active file should NOT be drained.
    const writer = await AnalyticsWriter.open({ dbPath: goodDb, spoolDir, harnessName: "pi" });
    await writer.close();

    assert.ok(existsSync(activeFile), "active spool file must not be touched by drain");

    const db = openDb(goodDb);
    // harnesses should be empty because the active file was NOT drained.
    assert.equal(countRows(db, "harnesses"), 0);
    db.close();
  });

  test("SpoolWriter.rotate() produces a .ndjson.closed file from an active file", () => {
    const spoolDir = join(tmp.dir, "spool-rotate");
    const sw = new SpoolWriter(spoolDir, "pi");

    // Write one record to create the active file.
    sw.write({ type: "harness", payload: { name: "pi", displayName: "Pi" } });

    const before = readdirSync(spoolDir);
    assert.ok(
      before.some((/** @type {string} */ f) => f.endsWith(".ndjson") && !f.endsWith(".ndjson.closed")),
      "should have an active .ndjson file before rotation"
    );

    sw.rotate();

    const after = readdirSync(spoolDir);
    assert.ok(
      after.some((/** @type {string} */ f) => f.endsWith(".ndjson.closed")),
      "should have a .ndjson.closed file after rotation"
    );
    assert.ok(
      !after.some((/** @type {string} */ f) => f.endsWith(".ndjson") && !f.endsWith(".ndjson.closed")),
      "active .ndjson file should be gone after rotation"
    );
  });

  test("empty active spool file is cleaned up on rotate (no closed file)", () => {
    const spoolDir = join(tmp.dir, "spool-empty-rotate");
    const sw = new SpoolWriter(spoolDir, "pi");

    // Do NOT write anything — active file was never created.
    sw.rotate(); // no-op, should not throw

    // Even if the directory was created, no .ndjson.closed should exist.
    if (existsSync(spoolDir)) {
      const files = readdirSync(spoolDir);
      assert.equal(files.length, 0, "no files should exist when nothing was written");
    }
  });

  test("drain is idempotent: re-opening after full drain produces same row counts", async () => {
    const spoolDir = join(tmp.dir, "spool-idem-drain");
    const goodDb = join(tmp.dir, "good-idem.db");

    // Phase 1: spool.
    const w1 = await AnalyticsWriter.open({
      dbPath: UNREACHABLE_DB,
      spoolDir,
      harnessName: "pi",
    });
    await w1.recordHarness({ name: "pi", displayName: "Pi" });
    await w1.recordSession({ harnessId: "pi", harnessSessionId: "idem-s1", startedAt: 1 });
    await w1.close();

    // Phase 2: drain into goodDb.
    const w2 = await AnalyticsWriter.open({ dbPath: goodDb, spoolDir, harnessName: "pi" });
    await w2.close();

    // Phase 3: open again — no spool files left, row counts unchanged.
    const w3 = await AnalyticsWriter.open({ dbPath: goodDb, spoolDir, harnessName: "pi" });
    await w3.close();

    const db = openDb(goodDb);
    assert.equal(countRows(db, "harnesses"), 1);
    assert.equal(countRows(db, "sessions"), 1);
    db.close();
  });
});
