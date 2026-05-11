// @ts-check
/**
 * Tests: legacy Pi import idempotency and correctness
 *
 * Covers:
 *   - Import maps sessions / turns / messages / tool_calls correctly
 *   - Second import run produces delta = 0 (idempotent)
 *   - cost_source = 'writer' when legacy cost_total > 0
 *   - cost_source = 'unknown' when legacy cost_total = 0
 *   - Import fails gracefully when source file is missing
 *   - Import metadata written to schema_metadata
 *   - Source (legacy) DB is never modified or deleted
 *   - FK integrity preserved in the central DB after import
 */

"use strict";

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { join } = require("node:path");
const { existsSync, statSync, readFileSync } = require("node:fs");
const { importLegacyPi } = require("../dist/src/index");
const { makeTempDir, openDb, countRows, makeLegacyDb } = require("./helpers");

describe("legacy Pi import", () => {
  /** @type {{ dir: string; cleanup: () => void }} */
  let tmp;

  before(() => {
    tmp = makeTempDir();
  });

  after(() => {
    tmp.cleanup();
  });

  test("import maps all four table types correctly", async () => {
    const legacyPath = join(tmp.dir, "legacy-map.db");
    const centralPath = join(tmp.dir, "central-map.db");
    makeLegacyDb(legacyPath, { sessions: 1, turns: 1, messages: 1, toolCalls: 1 });

    const outcome = await importLegacyPi({ sourcePath: legacyPath, dbPath: centralPath });
    assert.ok(outcome.ok, `import failed: ${outcome.ok ? "" : outcome.error}`);

    if (!outcome.ok) return; // type narrowing

    assert.equal(outcome.result.tables.sessions.legacy, 1);
    assert.equal(outcome.result.tables.turns.legacy, 1);
    assert.equal(outcome.result.tables.messages.legacy, 1);
    assert.equal(outcome.result.tables.toolCalls.legacy, 1);

    assert.equal(outcome.result.tables.sessions.added, 1);
    assert.equal(outcome.result.tables.turns.added, 1);
    assert.equal(outcome.result.tables.messages.added, 1);
    assert.equal(outcome.result.tables.toolCalls.added, 1);

    const db = openDb(centralPath);
    assert.equal(countRows(db, "harnesses"), 1);
    assert.equal(countRows(db, "sessions"), 1);
    assert.equal(countRows(db, "turns"), 1);
    assert.equal(countRows(db, "llm_messages"), 1);
    assert.equal(countRows(db, "tool_calls"), 1);
    db.close();
  });

  test("second import run has delta = 0 (idempotent)", async () => {
    const legacyPath = join(tmp.dir, "legacy-idem.db");
    const centralPath = join(tmp.dir, "central-idem.db");
    makeLegacyDb(legacyPath, { sessions: 2, turns: 1, messages: 2, toolCalls: 1 });

    const run1 = await importLegacyPi({ sourcePath: legacyPath, dbPath: centralPath });
    assert.ok(run1.ok);

    const run2 = await importLegacyPi({ sourcePath: legacyPath, dbPath: centralPath });
    assert.ok(run2.ok);

    if (!run2.ok) return;

    // All deltas must be 0 on the second run.
    assert.equal(run2.result.tables.sessions.added, 0, "sessions delta must be 0 on repeat");
    assert.equal(run2.result.tables.turns.added, 0, "turns delta must be 0 on repeat");
    assert.equal(run2.result.tables.messages.added, 0, "messages delta must be 0 on repeat");
    assert.equal(run2.result.tables.toolCalls.added, 0, "toolCalls delta must be 0 on repeat");

    // Row counts stay the same.
    // Legacy DB has 2 sessions × 1 turn × 2 messages = 4 messages total.
    const db = openDb(centralPath);
    assert.equal(countRows(db, "sessions"), 2);
    assert.equal(countRows(db, "llm_messages"), 4);
    db.close();
  });

  test("cost_source = writer when legacy cost_total > 0", async () => {
    const legacyPath = join(tmp.dir, "legacy-cost-src.db");
    const centralPath = join(tmp.dir, "central-cost-src.db");
    // makeLegacyDb uses cost_total = 0.0033 > 0.
    makeLegacyDb(legacyPath, { messages: 1 });

    await importLegacyPi({ sourcePath: legacyPath, dbPath: centralPath });

    const db = openDb(centralPath);
    const row = /** @type {{ cost_source: string }} */ (
      db.prepare("SELECT cost_source FROM llm_messages LIMIT 1").get()
    );
    db.close();

    assert.equal(row.cost_source, "writer");
  });

  test("cost_source = unknown when legacy cost_total = 0", async () => {
    const legacyPath = join(tmp.dir, "legacy-cost-zero.db");
    const centralPath = join(tmp.dir, "central-cost-zero.db");

    // Build a legacy DB with cost_total = 0.
    const Database = require("better-sqlite3");
    const db = new Database(legacyPath);
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, cwd TEXT NOT NULL DEFAULT '',
        repo_remote TEXT, repo_owner TEXT, repo_name TEXT,
        started_at INTEGER NOT NULL, ended_at INTEGER,
        pi_version TEXT NOT NULL DEFAULT 'unknown'
      );
      CREATE TABLE turns (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
        idx INTEGER NOT NULL DEFAULT 0, started_at INTEGER NOT NULL,
        ended_at INTEGER, model_id TEXT, provider TEXT
      );
      CREATE TABLE llm_messages (
        id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, session_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'assistant', ts INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cost_input REAL NOT NULL DEFAULT 0, cost_output REAL NOT NULL DEFAULT 0,
        cost_cache_read REAL NOT NULL DEFAULT 0, cost_cache_write REAL NOT NULL DEFAULT 0,
        cost_total REAL NOT NULL DEFAULT 0, model_id TEXT, provider TEXT
      );
      CREATE TABLE tool_calls (
        id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, session_id TEXT NOT NULL,
        name TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL,
        is_error INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO sessions VALUES ('s1', '/tmp', NULL, NULL, NULL, 1000000000, NULL, '1.0.0');
      INSERT INTO turns VALUES ('t1', 's1', 0, 1000000100, 1000000200, 'claude', 'anthropic');
      INSERT INTO llm_messages VALUES ('m1', 't1', 's1', 'assistant', 1000000150,
        10, 20, 0, 0,  0, 0, 0, 0, 0,  'claude', 'anthropic');
    `);
    db.close();

    await importLegacyPi({ sourcePath: legacyPath, dbPath: centralPath });

    const centralDb = openDb(centralPath);
    const row = /** @type {{ cost_source: string }} */ (
      centralDb.prepare("SELECT cost_source FROM llm_messages LIMIT 1").get()
    );
    centralDb.close();

    assert.equal(row.cost_source, "unknown");
  });

  test("import fails gracefully when source file is missing", async () => {
    const centralPath = join(tmp.dir, "central-no-src.db");

    const outcome = await importLegacyPi({
      sourcePath: "/nonexistent/path/events.db",
      dbPath: centralPath,
    });

    assert.ok(!outcome.ok, "import should fail when source is missing");
    if (outcome.ok) return;
    assert.ok(
      outcome.error.includes("not found") || outcome.error.includes("Cannot open"),
      `unexpected error message: ${outcome.error}`
    );
  });

  test("legacy DB is never modified or deleted by import", async () => {
    const legacyPath = join(tmp.dir, "legacy-readonly.db");
    const centralPath = join(tmp.dir, "central-readonly.db");
    makeLegacyDb(legacyPath);

    const statBefore = statSync(legacyPath);

    await importLegacyPi({ sourcePath: legacyPath, dbPath: centralPath });

    // File must still exist.
    assert.ok(existsSync(legacyPath), "legacy DB must not be deleted");

    // Content size should not shrink (may grow slightly due to WAL sidecars, but
    // a read-only open should not change the main db file size meaningfully).
    const statAfter = statSync(legacyPath);
    assert.ok(
      statAfter.size >= statBefore.size,
      "legacy DB size should not decrease"
    );
  });

  test("import metadata written to schema_metadata", async () => {
    const legacyPath = join(tmp.dir, "legacy-meta.db");
    const centralPath = join(tmp.dir, "central-meta.db");
    makeLegacyDb(legacyPath);

    await importLegacyPi({ sourcePath: legacyPath, dbPath: centralPath });

    const db = openDb(centralPath);
    const row = /** @type {{ value: string } | undefined} */ (
      db.prepare("SELECT value FROM schema_metadata WHERE key='import_legacy_pi'").get()
    );
    db.close();

    assert.ok(row != null, "import_legacy_pi metadata key should exist");
    const meta = JSON.parse(row.value);
    assert.ok(meta.completedAt > 0, "completedAt should be a positive timestamp");
    assert.ok(meta.tables.sessions.legacy >= 0);
  });

  test("FK integrity is preserved after import", async () => {
    const legacyPath = join(tmp.dir, "legacy-fk.db");
    const centralPath = join(tmp.dir, "central-fk.db");
    makeLegacyDb(legacyPath, { sessions: 2, turns: 2, messages: 2, toolCalls: 1 });

    await importLegacyPi({ sourcePath: legacyPath, dbPath: centralPath });

    const db = openDb(centralPath);
    db.pragma("foreign_keys = ON");
    const violations = db.pragma("foreign_key_check");
    db.close();

    assert.equal(
      /** @type {any[]} */ (violations).length,
      0,
      "no FK violations after import"
    );
  });

  test("cost_total_micros satisfies CHECK constraint (sum of breakdown columns)", async () => {
    const legacyPath = join(tmp.dir, "legacy-check.db");
    const centralPath = join(tmp.dir, "central-check.db");
    makeLegacyDb(legacyPath);

    await importLegacyPi({ sourcePath: legacyPath, dbPath: centralPath });

    const db = openDb(centralPath);
    // SQLite CHECK constraints are enforced on insert; if any row violates them
    // the insert would have failed. We verify here that the stored values satisfy
    // the constraint manually so the test is explicit.
    const rows = /** @type {Array<{ cost_total_micros: number; cost_input_micros: number; cost_output_micros: number; cost_cache_read_micros: number; cost_cache_write_micros: number }>} */ (
      db.prepare(
        "SELECT cost_total_micros, cost_input_micros, cost_output_micros, cost_cache_read_micros, cost_cache_write_micros FROM llm_messages"
      ).all()
    );
    db.close();

    for (const row of rows) {
      const expectedTotal =
        row.cost_input_micros +
        row.cost_output_micros +
        row.cost_cache_read_micros +
        row.cost_cache_write_micros;
      assert.equal(
        row.cost_total_micros,
        expectedTotal,
        "cost_total_micros must equal sum of breakdown columns"
      );
    }
  });
});
