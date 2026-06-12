/**
 * server/tests/query-semantics.test.ts
 *
 * Thin integration test for the web-explorer query wiring.
 *
 * Full query-semantics tests (unpriced-row contract, drift fixes) now live in
 * @token-tally/queries/tests/query-semantics.test.ts. This file verifies:
 *   1. The re-exported query functions are callable through the local paths
 *      that server/index.ts uses (wiring check).
 *   2. The schema compatibility window enforcement in openReadOnly works
 *      as expected (client-specific behaviour that stays here).
 *
 * Runs from compiled ESM at dist/server/tests/query-semantics.test.js.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import Database from "better-sqlite3";

import { queryCostBucket } from "../queries/analytics.js";
import { openReadOnly } from "../db.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createVersionedDb(path: string, version: number): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO schema_metadata VALUES ('schema_version', '${version}');
  `);
  db.close();
}

// ---------------------------------------------------------------------------
// Wiring test — queryCostBucket reachable via re-export path
// ---------------------------------------------------------------------------

describe("query re-export wiring", () => {
  let tmpPath: string;
  let tmpDb: Database.Database;

  after(() => {
    if (tmpDb && tmpDb.open) tmpDb.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { rmSync(tmpPath + suffix); } catch { /* ignore */ }
    }
  });

  it("queryCostBucket from re-export path returns zero bucket on empty DB", () => {
    tmpPath = join(tmpdir(), `tt-we-wiring-${Date.now()}.db`);
    tmpDb = new Database(tmpPath);
    tmpDb.exec(`
      CREATE TABLE schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE harnesses (name TEXT PRIMARY KEY, display_name TEXT NOT NULL, version TEXT, integration_version TEXT, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, harness_id TEXT NOT NULL, harness_session_id TEXT NOT NULL, session_file TEXT, cwd TEXT, repo_owner TEXT, repo_name TEXT, repo_remote TEXT, started_at INTEGER NOT NULL, ended_at INTEGER, FOREIGN KEY (harness_id) REFERENCES harnesses(name));
      CREATE TABLE turns (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, harness_id TEXT NOT NULL, harness_turn_id TEXT NOT NULL, turn_index INTEGER, started_at INTEGER NOT NULL, ended_at INTEGER, provider TEXT, model_id TEXT, FOREIGN KEY (session_id) REFERENCES sessions(id), FOREIGN KEY (harness_id) REFERENCES harnesses(name));
      CREATE TABLE llm_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT, harness_id TEXT NOT NULL, harness_message_id TEXT NOT NULL, ts INTEGER NOT NULL, provider TEXT, model_id TEXT, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0, cost_input_micros INTEGER NOT NULL DEFAULT 0, cost_output_micros INTEGER NOT NULL DEFAULT 0, cost_cache_read_micros INTEGER NOT NULL DEFAULT 0, cost_cache_write_micros INTEGER NOT NULL DEFAULT 0, cost_total_micros INTEGER NOT NULL DEFAULT 0, cost_currency TEXT NOT NULL DEFAULT 'USD', cost_source TEXT NOT NULL DEFAULT 'unknown', subscription_id TEXT, FOREIGN KEY (session_id) REFERENCES sessions(id), FOREIGN KEY (harness_id) REFERENCES harnesses(name));
      INSERT INTO schema_metadata VALUES ('schema_version', '1');
    `);
    const bucket = queryCostBucket(tmpDb, { from: 0, to: Date.now() });
    assert.equal(bucket.cost_usd, 0);
    assert.equal(bucket.messages, 0);
  });
});

// ---------------------------------------------------------------------------
// Schema compatibility window tests (client-specific)
// ---------------------------------------------------------------------------

describe("openReadOnly: schema compatibility window", () => {
  const paths: string[] = [];

  after(() => {
    for (const p of paths) {
      for (const suffix of ["", "-wal", "-shm"]) {
        try { rmSync(p + suffix); } catch { /* ignore */ }
      }
    }
  });

  function tempPath(): string {
    const p = join(tmpdir(), `tt-schema-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    paths.push(p);
    return p;
  }

  it("returns ok: false for schema version 0 (needs migration)", () => {
    const p = tempPath();
    createVersionedDb(p, 0);
    const result = openReadOnly(p);
    assert.ok(!result.ok, "should fail for version 0");
    assert.ok(result.reason.includes("token-tally migrate"), `reason should mention migrate: ${result.reason}`);
  });

  it("returns ok: true for current schema version 1", () => {
    const p = tempPath();
    createVersionedDb(p, 1);
    const result = openReadOnly(p);
    assert.ok(result.ok, `should succeed for version 1: ${!result.ok ? result.reason : ""}`);
    if (result.ok) {
      assert.equal(result.schemaStatus, "ok");
      result.close();
    }
  });

  it("returns ok: true with schemaStatus=degraded for version MAX+1 (within window)", () => {
    const p = tempPath();
    createVersionedDb(p, 2); // MAX_KNOWN=1, WINDOW=2 → 2 is degraded-ok
    const result = openReadOnly(p);
    assert.ok(result.ok, `should succeed for version 2 (degraded): ${!result.ok ? result.reason : ""}`);
    if (result.ok) {
      assert.equal(result.schemaStatus, "degraded");
      result.close();
    }
  });

  it("returns ok: false for version MAX+3 (too new, outside window)", () => {
    const p = tempPath();
    createVersionedDb(p, 4); // MAX_KNOWN=1+WINDOW=2 → 4 > 3, too new
    const result = openReadOnly(p);
    assert.ok(!result.ok, "should fail for version 4 (too new)");
    if (!result.ok) {
      assert.ok(
        result.reason.includes("too new") || result.reason.includes("update"),
        `reason should mention update: ${result.reason}`,
      );
    }
  });
});
