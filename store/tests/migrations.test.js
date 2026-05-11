// @ts-check
/**
 * Tests: schema migrations
 *
 * Covers:
 *   - Migration from empty DB creates schema_version = 1
 *   - Re-running migration is safe (idempotent)
 *   - All required tables exist after migration
 *   - schema_metadata contains expected keys
 *   - runMigrations is exposed from the public API
 */

"use strict";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { join } = require("node:path");
const Database = require("better-sqlite3");
const { runMigrations } = require("../dist/src/index");
const { makeTempDir, openDb, readSchemaVersion, countRows } = require("./helpers");

describe("migrations", () => {
  /** @type {{ dir: string; cleanup: () => void }} */
  let tmp;

  before(() => {
    tmp = makeTempDir();
  });

  after(() => {
    tmp.cleanup();
  });

  test("fresh DB starts at schema version 0", () => {
    const dbPath = join(tmp.dir, "fresh.db");
    const db = openDb(dbPath);
    const version = readSchemaVersion(db);
    db.close();
    assert.equal(version, 0);
  });

  test("runMigrations creates schema_version = 1 on empty DB", () => {
    const dbPath = join(tmp.dir, "migrated.db");
    const db = new Database(dbPath);
    db.pragma("foreign_keys = ON");

    runMigrations(db);

    const version = readSchemaVersion(db);
    db.close();

    assert.equal(version, 1, "expected schema_version to be 1 after migration");
  });

  test("all required tables exist after migration", () => {
    const dbPath = join(tmp.dir, "tables.db");
    const db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((/** @type {{ name: string }} */ r) => r.name);

    db.close();

    const required = [
      "harnesses",
      "llm_messages",
      "raw_events",
      "schema_metadata",
      "sessions",
      "subscriptions",
      "tool_calls",
      "turns",
    ];
    for (const table of required) {
      assert.ok(tables.includes(table), `table '${table}' missing after migration`);
    }
  });

  test("schema_metadata contains created_at and last_migrated_at", () => {
    const dbPath = join(tmp.dir, "meta.db");
    const db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    /** @type {(key: string) => string | undefined} */
    const getMeta = (key) => {
      const row = /** @type {{ value: string } | undefined} */ (
        db.prepare("SELECT value FROM schema_metadata WHERE key = ?").get(key)
      );
      return row?.value;
    };

    const createdAt = getMeta("created_at");
    const lastMigratedAt = getMeta("last_migrated_at");
    db.close();

    assert.ok(createdAt != null && createdAt !== "", "created_at must be set");
    assert.ok(lastMigratedAt != null && lastMigratedAt !== "", "last_migrated_at must be set");
  });

  test("required indexes exist after migration", () => {
    const dbPath = join(tmp.dir, "indexed.db");
    const db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
      .all()
      .map((/** @type {{ name: string }} */ r) => r.name);

    db.close();

    const required = [
      "idx_llm_messages_ts",
      "idx_llm_messages_harness_ts",
      "idx_llm_messages_session",
      "idx_llm_messages_subscription",
      "idx_turns_session",
      "idx_tool_calls_session",
      "idx_raw_events_harness_ts",
    ];
    for (const idx of required) {
      assert.ok(indexes.includes(idx), `index '${idx}' missing after migration`);
    }
  });

  test("running migrations twice is idempotent (schema_version stays 1)", () => {
    const dbPath = join(tmp.dir, "idempotent.db");
    const db = new Database(dbPath);
    db.pragma("foreign_keys = ON");

    runMigrations(db);
    // Second run must not throw and must leave schema_version = 1.
    runMigrations(db);

    const version = readSchemaVersion(db);
    db.close();

    assert.equal(version, 1);
  });

  test("tables are empty after migration (no seed data)", () => {
    const dbPath = join(tmp.dir, "empty-tables.db");
    const db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    // These tables should have zero rows — migrations must not insert data.
    for (const table of ["harnesses", "sessions", "turns", "llm_messages"]) {
      assert.equal(countRows(db, table), 0, `${table} should be empty after migration`);
    }

    db.close();
  });

  test("AnalyticsWriter.open() also migrates a fresh DB", async () => {
    const dbPath = join(tmp.dir, "writer-migrated.db");
    const spoolDir = join(tmp.dir, "spool-mig");
    const { AnalyticsWriter } = require("../dist/src/index");

    const writer = await AnalyticsWriter.open({ dbPath, spoolDir, harnessName: "pi" });
    await writer.close();

    const db = openDb(dbPath);
    const version = readSchemaVersion(db);
    db.close();

    assert.equal(version, 1);
  });
});
