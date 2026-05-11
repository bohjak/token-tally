// @ts-check
/**
 * Tests: schema version compatibility checks
 *
 * Covers:
 *   - readSchemaCompatibility returns "ok" for version 1
 *   - returns "needs_migration" on empty DB (version 0)
 *   - returns "degraded" for versions just above MAX_KNOWN but within window
 *   - returns "too_new" for versions beyond the forward window
 *   - AnalyticsWriter.open() throws on too_new schema
 *   - AnalyticsWriter.open() falls back to spool on degraded schema
 */

"use strict";

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { join } = require("node:path");
const Database = require("better-sqlite3");
const {
  AnalyticsWriter,
  readSchemaCompatibility,
  runMigrations,
  MAX_KNOWN_SCHEMA_VERSION,
  SCHEMA_FORWARD_WINDOW,
} = require("../dist/src/index");
const { makeTempDir } = require("./helpers");

/**
 * Creates a DB at dbPath, runs migrations, then manually sets schema_version.
 *
 * @param {string} dbPath
 * @param {number} version
 * @returns {void}
 */
function makeDbAtVersion(dbPath, version) {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare(
    "INSERT OR REPLACE INTO schema_metadata (key, value) VALUES ('schema_version', ?)"
  ).run(String(version));
  db.close();
}

describe("schema compatibility", () => {
  /** @type {{ dir: string; cleanup: () => void }} */
  let tmp;

  before(() => {
    tmp = makeTempDir();
  });

  after(() => {
    tmp.cleanup();
  });

  test("readSchemaCompatibility returns ok for version 1 (MAX_KNOWN)", () => {
    const dbPath = join(tmp.dir, "compat-ok.db");
    makeDbAtVersion(dbPath, MAX_KNOWN_SCHEMA_VERSION);

    const db = new Database(dbPath);
    const result = readSchemaCompatibility(db);
    db.close();

    assert.equal(result.status, "ok");
    assert.equal(result.version, MAX_KNOWN_SCHEMA_VERSION);
  });

  test("readSchemaCompatibility returns needs_migration on fresh empty DB", () => {
    const dbPath = join(tmp.dir, "compat-fresh.db");
    // No migration run — schema_metadata table doesn't exist.
    const db = new Database(dbPath);
    const result = readSchemaCompatibility(db);
    db.close();

    assert.equal(result.status, "needs_migration");
    assert.equal(result.version, 0);
  });

  test("readSchemaCompatibility returns degraded for version MAX_KNOWN+1", () => {
    const dbPath = join(tmp.dir, "compat-degraded.db");
    makeDbAtVersion(dbPath, MAX_KNOWN_SCHEMA_VERSION + 1);

    const db = new Database(dbPath);
    const result = readSchemaCompatibility(db);
    db.close();

    assert.equal(result.status, "degraded");
    assert.equal(result.version, MAX_KNOWN_SCHEMA_VERSION + 1);
  });

  test("readSchemaCompatibility returns degraded for version MAX_KNOWN+WINDOW", () => {
    // MAX_KNOWN + SCHEMA_FORWARD_WINDOW is the last version in the degraded range.
    const dbPath = join(tmp.dir, "compat-degraded-max.db");
    makeDbAtVersion(dbPath, MAX_KNOWN_SCHEMA_VERSION + SCHEMA_FORWARD_WINDOW);

    const db = new Database(dbPath);
    const result = readSchemaCompatibility(db);
    db.close();

    assert.equal(result.status, "degraded");
  });

  test("readSchemaCompatibility returns too_new for version MAX_KNOWN+WINDOW+1", () => {
    const dbPath = join(tmp.dir, "compat-too-new.db");
    makeDbAtVersion(dbPath, MAX_KNOWN_SCHEMA_VERSION + SCHEMA_FORWARD_WINDOW + 1);

    const db = new Database(dbPath);
    const result = readSchemaCompatibility(db);
    db.close();

    assert.equal(result.status, "too_new");
    assert.equal(result.version, MAX_KNOWN_SCHEMA_VERSION + SCHEMA_FORWARD_WINDOW + 1);
  });

  test("AnalyticsWriter.open() throws when schema is too_new", async () => {
    const dbPath = join(tmp.dir, "writer-too-new.db");
    const spoolDir = join(tmp.dir, "spool-too-new");
    makeDbAtVersion(dbPath, MAX_KNOWN_SCHEMA_VERSION + SCHEMA_FORWARD_WINDOW + 1);

    await assert.rejects(
      () => AnalyticsWriter.open({ dbPath, spoolDir, harnessName: "test" }),
      /too new/i,
      "AnalyticsWriter.open() must throw when schema version is past the forward window"
    );
  });

  test("AnalyticsWriter.open() falls back to spool when schema is degraded", async () => {
    // When schema is in degraded range, the writer should not throw but should
    // write events to the spool instead of the DB.
    const dbPath = join(tmp.dir, "writer-degraded.db");
    const spoolDir = join(tmp.dir, "spool-degraded");
    makeDbAtVersion(dbPath, MAX_KNOWN_SCHEMA_VERSION + 1);

    // Should open successfully (not throw) and enter spool-only mode.
    const writer = await AnalyticsWriter.open({ dbPath, spoolDir, harnessName: "test" });
    await writer.recordHarness({ name: "test", displayName: "Test" });
    const { id: sessionId } = await writer.recordSession({
      harnessId: "test",
      harnessSessionId: "s-degraded",
      startedAt: Date.now(),
    });
    await writer.close();

    // The spool file should exist because the writer could not write to the DB.
    const { readdirSync, existsSync } = require("node:fs");
    assert.ok(existsSync(spoolDir), "spool directory should exist");
    const closedFiles = readdirSync(spoolDir).filter(
      (/** @type {string} */ f) => f.endsWith(".ndjson.closed")
    );
    assert.ok(closedFiles.length > 0, "should have produced spool closed files");

    // The DB row count for sessions should still be at the pre-existing state
    // (no writes were attempted on the too-advanced schema).
    const db = new Database(dbPath, { readonly: true });
    const n = db.prepare("SELECT COUNT(*) AS n FROM sessions").get();
    db.close();
    assert.equal(/** @type {{ n: number }} */ (n).n, 0);
  });
});
