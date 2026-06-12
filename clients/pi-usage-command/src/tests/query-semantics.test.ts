/**
 * src/tests/query-semantics.test.ts
 *
 * Thin integration test for the Pi usage-command query wiring.
 *
 * Full query-semantics tests (unpriced-row contract, drift fixes) now live in
 * @token-tally/queries/tests/query-semantics.test.ts. This file verifies:
 *   1. Tab wrapper functions are reachable and return the expected top-level shape
 *      (wiring check — confirms the delegation to @token-tally/queries works).
 *   2. The schema compatibility window enforcement in openReadOnly works
 *      as expected for the Pi client (client-specific behaviour stays here).
 *
 * Runs via: node --experimental-strip-types --test 'src/tests/**\/*.test.ts'
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";

import { queryTabSummary, queryTabModels, queryTabDaily } from "../queries.ts";
import { openReadOnly } from "../db.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const T0 = Date.now();

function createMinimalDb(): { db: BetterSqlite3.Database; path: string } {
  const path = join(tmpdir(), `tt-pi-wire-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE harnesses (name TEXT PRIMARY KEY, display_name TEXT NOT NULL, version TEXT, integration_version TEXT, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, harness_id TEXT NOT NULL, harness_session_id TEXT NOT NULL, session_file TEXT, cwd TEXT, repo_owner TEXT, repo_name TEXT, repo_remote TEXT, started_at INTEGER NOT NULL, ended_at INTEGER, FOREIGN KEY (harness_id) REFERENCES harnesses(name));
    CREATE TABLE turns (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, harness_id TEXT NOT NULL, harness_turn_id TEXT NOT NULL, turn_index INTEGER, started_at INTEGER NOT NULL, ended_at INTEGER, provider TEXT, model_id TEXT, FOREIGN KEY (session_id) REFERENCES sessions(id), FOREIGN KEY (harness_id) REFERENCES harnesses(name));
    CREATE TABLE tool_calls (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT, harness_id TEXT NOT NULL, harness_tool_call_id TEXT NOT NULL, tool_name TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, is_error INTEGER NOT NULL DEFAULT 0, FOREIGN KEY (session_id) REFERENCES sessions(id), FOREIGN KEY (harness_id) REFERENCES harnesses(name));
    CREATE TABLE llm_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT, harness_id TEXT NOT NULL, harness_message_id TEXT NOT NULL, ts INTEGER NOT NULL, provider TEXT, model_id TEXT, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0, cost_input_micros INTEGER NOT NULL DEFAULT 0, cost_output_micros INTEGER NOT NULL DEFAULT 0, cost_cache_read_micros INTEGER NOT NULL DEFAULT 0, cost_cache_write_micros INTEGER NOT NULL DEFAULT 0, cost_total_micros INTEGER NOT NULL DEFAULT 0, cost_currency TEXT NOT NULL DEFAULT 'USD', cost_source TEXT NOT NULL DEFAULT 'unknown' CHECK (cost_source IN ('harness','writer','subscription_covered','unknown')), subscription_id TEXT, FOREIGN KEY (session_id) REFERENCES sessions(id), FOREIGN KEY (harness_id) REFERENCES harnesses(name), CHECK (cost_total_micros = cost_input_micros + cost_output_micros + cost_cache_read_micros + cost_cache_write_micros));
    INSERT INTO schema_metadata VALUES ('schema_version','1');
    INSERT INTO harnesses VALUES ('test','Test',NULL,NULL,${T0},${T0});
    INSERT INTO sessions VALUES ('s1','test','hs1',NULL,NULL,NULL,NULL,NULL,${T0},${T0 + 3600000});
    INSERT INTO turns VALUES ('t1','s1','test','ht1',0,${T0},${T0 + 1000},'anthropic','claude-opus-4');
  `);
  // Insert one priced and one unpriced message so tab functions have data.
  // Use ? placeholders for all values to avoid better-sqlite3 misinterpreting
  // literal integers that start with '$' as named parameter placeholders.
  db.prepare(`INSERT INTO llm_messages (id,session_id,turn_id,harness_id,harness_message_id,ts,model_id,input_tokens,output_tokens,cost_input_micros,cost_output_micros,cost_cache_read_micros,cost_cache_write_micros,cost_total_micros,cost_source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('m1','s1','t1','test','hm1',T0,'claude-opus-4',100,50,300,750,0,0,1050,'writer');
  db.prepare(`INSERT INTO llm_messages (id,session_id,turn_id,harness_id,harness_message_id,ts,model_id,input_tokens,output_tokens,cost_input_micros,cost_output_micros,cost_cache_read_micros,cost_cache_write_micros,cost_total_micros,cost_source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('m2','s1','t1','test','hm2',T0,'claude-opus-4',300,120,0,0,0,0,0,'unknown');
  return { db, path };
}

function createVersionedDb(path: string, version: number): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO schema_metadata VALUES ('schema_version', '${version}');
  `);
  db.close();
}

// ---------------------------------------------------------------------------
// Wiring tests
// ---------------------------------------------------------------------------

describe("queryTabSummary wiring: returns expected shape", () => {
  let db: BetterSqlite3.Database;
  let path: string;

  before(() => {
    const fix = createMinimalDb();
    db = fix.db;
    path = fix.path;
  });
  after(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { rmSync(path + suffix); } catch { /* ignore */ }
    }
  });

  it("returns today/week/month/session buckets with unpriced_count", () => {
    const data = queryTabSummary(db, "all") as {
      today: { billable_tokens: number; unpriced_count: number };
      week:  { billable_tokens: number };
      month: { billable_tokens: number };
      session: { billable_tokens: number };
    };
    // Both messages are within 'all' window; billable = (100+50) + (300+120) = 570
    assert.equal(data.today.billable_tokens, 570, "summary.today.billable_tokens");
    assert.equal(data.today.unpriced_count, 1, "summary.today.unpriced_count");
    assert.ok("week"  in data, "summary has week bucket");
    assert.ok("month" in data, "summary has month bucket");
  });
});

describe("queryTabModels wiring: returns rows array", () => {
  let db: BetterSqlite3.Database;
  let path: string;

  before(() => {
    const fix = createMinimalDb();
    db = fix.db;
    path = fix.path;
  });
  after(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { rmSync(path + suffix); } catch { /* ignore */ }
    }
  });

  it("returns rows with model_id and unpriced_count", () => {
    const data = queryTabModels(db, "all") as {
      rows: Array<{ model_id: string; billable_tokens: number }>;
      unpriced_count: number;
    };
    assert.equal(data.unpriced_count, 1);
    assert.ok(data.rows.length > 0, "should have model rows");
    assert.equal(data.rows[0]!.billable_tokens, 570);
  });
});

describe("queryTabDaily wiring: returns rows array", () => {
  let db: BetterSqlite3.Database;
  let path: string;

  before(() => {
    const fix = createMinimalDb();
    db = fix.db;
    path = fix.path;
  });
  after(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { rmSync(path + suffix); } catch { /* ignore */ }
    }
  });

  it("returns daily rows and unpriced_count", () => {
    const data = queryTabDaily(db, "all") as {
      rows: Array<{ date: string; billable_tokens: number }>;
      unpriced_count: number;
    };
    assert.equal(data.unpriced_count, 1);
    assert.equal(data.rows.length, 1, "one day of data");
    assert.equal(data.rows[0]!.billable_tokens, 570);
  });
});

// ---------------------------------------------------------------------------
// Schema compatibility window (Pi-specific openReadOnly behavior)
// ---------------------------------------------------------------------------

describe("openReadOnly: schema compatibility window", () => {
  const tmpPaths: string[] = [];

  after(() => {
    for (const p of tmpPaths) {
      for (const suffix of ["", "-wal", "-shm"]) {
        try { rmSync(p + suffix); } catch { /* ignore */ }
      }
    }
  });

  function tempPath(): string {
    const p = join(tmpdir(), `tt-pi-schema-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    tmpPaths.push(p);
    return p;
  }

  it("returns ok: false for schema version 0 (needs migration)", () => {
    const p = tempPath();
    createVersionedDb(p, 0);
    const result = openReadOnly(p);
    assert.ok(!result.ok, "should refuse version 0");
    assert.ok(result.reason.includes("token-tally migrate"), `reason must mention migrate: ${result.reason}`);
  });

  it("returns ok: true for current schema version 1", () => {
    const p = tempPath();
    createVersionedDb(p, 1);
    const result = openReadOnly(p);
    assert.ok(result.ok, `should accept version 1: ${!result.ok ? result.reason : ""}`);
    if (result.ok) result.close();
  });

  it("returns ok: true with schemaWarning for version 2 (degraded, within window)", () => {
    const p = tempPath();
    createVersionedDb(p, 2); // MAX_KNOWN=1, WINDOW=2 → 2 is ok-degraded
    const result = openReadOnly(p);
    if (!result.ok) {
      assert.fail(`should accept version 2 in degraded mode, got: ${result.reason}`);
    }
    assert.ok(
      typeof result.schemaWarning === "string",
      "schemaWarning should be a string for degraded mode",
    );
    assert.ok(
      result.schemaWarning.includes("degraded"),
      `schemaWarning should mention degraded: ${result.schemaWarning}`,
    );
    result.close();
  });

  it("returns ok: false for version 4 (too new, outside window)", () => {
    const p = tempPath();
    createVersionedDb(p, 4); // MAX_KNOWN=1+WINDOW=2=3 < 4 → too new
    const result = openReadOnly(p);
    assert.ok(!result.ok, "should refuse version 4");
    if (!result.ok) {
      assert.ok(result.reason.toLowerCase().includes("update"), `reason must mention update: ${result.reason}`);
    }
  });
});
