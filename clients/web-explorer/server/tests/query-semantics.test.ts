/**
 * server/tests/query-semantics.test.ts
 *
 * Tests for the query-layer contract:
 *   1. Token/turn/session counts include ALL rows regardless of cost_source.
 *   2. Cost sums exclude cost_source='unknown' rows (CASE guard).
 *   3. unpriced_count is reported separately.
 *   4. Schema compatibility window enforcement in openReadOnly.
 *
 * Runs from compiled ESM at dist/server/tests/query-semantics.test.js.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import Database from "better-sqlite3";

import { queryCostBucket, queryCostBucketForSession, queryModels, queryDaily } from "../queries/analytics.js";
import { openReadOnly } from "../db.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000; // arbitrary base timestamp (ms)

function createFixtureDb(): { db: Database.Database; path: string } {
  const path = join(
    tmpdir(),
    `tt-query-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE harnesses (
      name TEXT PRIMARY KEY, display_name TEXT NOT NULL,
      version TEXT, integration_version TEXT,
      first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, harness_id TEXT NOT NULL,
      harness_session_id TEXT NOT NULL, session_file TEXT,
      cwd TEXT, repo_owner TEXT, repo_name TEXT, repo_remote TEXT,
      started_at INTEGER NOT NULL, ended_at INTEGER,
      FOREIGN KEY (harness_id) REFERENCES harnesses(name)
    );
    CREATE TABLE turns (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      harness_id TEXT NOT NULL, harness_turn_id TEXT NOT NULL,
      turn_index INTEGER, started_at INTEGER NOT NULL, ended_at INTEGER,
      provider TEXT, model_id TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id),
      FOREIGN KEY (harness_id) REFERENCES harnesses(name)
    );
    CREATE TABLE llm_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL, turn_id TEXT,
      harness_id TEXT NOT NULL, harness_message_id TEXT NOT NULL,
      ts INTEGER NOT NULL, provider TEXT, model_id TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost_input_micros INTEGER NOT NULL DEFAULT 0,
      cost_output_micros INTEGER NOT NULL DEFAULT 0,
      cost_cache_read_micros INTEGER NOT NULL DEFAULT 0,
      cost_cache_write_micros INTEGER NOT NULL DEFAULT 0,
      cost_total_micros INTEGER NOT NULL DEFAULT 0,
      cost_currency TEXT NOT NULL DEFAULT 'USD',
      cost_source TEXT NOT NULL DEFAULT 'unknown'
        CHECK (cost_source IN ('harness','writer','subscription_covered','unknown')),
      subscription_id TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id),
      FOREIGN KEY (harness_id) REFERENCES harnesses(name),
      CHECK (cost_total_micros = cost_input_micros + cost_output_micros
             + cost_cache_read_micros + cost_cache_write_micros)
    );
    INSERT INTO schema_metadata VALUES ('schema_version','1');
    INSERT INTO harnesses VALUES ('test','Test',NULL,NULL,${T0},${T0});
    INSERT INTO sessions VALUES ('s1','test','hs1',NULL,NULL,NULL,NULL,NULL,${T0},${T0 + 3600000});
    INSERT INTO turns VALUES ('t1','s1','test','ht1',0,${T0},${T0 + 1000},'anthropic','claude-opus-4');
  `);

  return { db, path };
}

function insertMessage(
  db: Database.Database,
  opts: {
    id: string;
    sessionId?: string;
    turnId?: string | null;
    ts?: number;
    modelId?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    costInputMicros?: number;
    costOutputMicros?: number;
    costCacheReadMicros?: number;
    costCacheWriteMicros?: number;
    costSource: "writer" | "harness" | "subscription_covered" | "unknown";
  },
): void {
  const {
    id,
    sessionId = "s1",
    turnId = "t1",
    ts = T0,
    modelId = "claude-opus-4",
    inputTokens = 0,
    outputTokens = 0,
    cacheReadTokens = 0,
    cacheWriteTokens = 0,
    costInputMicros = 0,
    costOutputMicros = 0,
    costCacheReadMicros = 0,
    costCacheWriteMicros = 0,
    costSource,
  } = opts;

  const costTotal = costInputMicros + costOutputMicros + costCacheReadMicros + costCacheWriteMicros;

  db.prepare(`
    INSERT INTO llm_messages (
      id, session_id, turn_id, harness_id, harness_message_id,
      ts, model_id,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      cost_input_micros, cost_output_micros,
      cost_cache_read_micros, cost_cache_write_micros,
      cost_total_micros, cost_source
    ) VALUES (?, ?, ?, 'test', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, sessionId, turnId, `hm-${id}`,
    ts, modelId,
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
    costInputMicros, costOutputMicros, costCacheReadMicros, costCacheWriteMicros,
    costTotal, costSource,
  );
}

// ---------------------------------------------------------------------------
// Schema-window test helper: creates a one-file DB with a given schema version
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
// Fixtures shared across token-semantics tests
// ---------------------------------------------------------------------------

let fixDb: Database.Database;
let fixPath: string;

before(() => {
  const fix = createFixtureDb();
  fixDb = fix.db;
  fixPath = fix.path;

  // 2 priced messages
  insertMessage(fixDb, {
    id: "m1", inputTokens: 100, outputTokens: 50,
    costInputMicros: 300, costOutputMicros: 750,
    costSource: "writer",
  });
  insertMessage(fixDb, {
    id: "m2", inputTokens: 200, outputTokens: 80,
    costInputMicros: 600, costOutputMicros: 1200,
    costSource: "writer",
  });

  // 1 unpriced message (tokens real, cost zero)
  insertMessage(fixDb, {
    id: "m3", inputTokens: 300, outputTokens: 120,
    costInputMicros: 0, costOutputMicros: 0,
    costSource: "unknown",
  });

  fixDb.close();
});

after(() => {
  try { rmSync(fixPath); } catch { /* ignore */ }
  // Also clean up WAL sidecars
  try { rmSync(fixPath + "-wal"); } catch { /* ignore */ }
  try { rmSync(fixPath + "-shm"); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Token-semantics tests
// ---------------------------------------------------------------------------

describe("queryCostBucket: unpriced-row semantics", () => {
  it("counts tokens from ALL rows (including unknown cost_source)", () => {
    const result = openReadOnly(fixPath);
    assert.ok(result.ok, `Expected ok: ${!result.ok ? result.reason : "n/a"}`);
    const { db, close } = result;
    try {
      const bucket = queryCostBucket(db, { from: 0, to: Date.now() });
      // billable_tokens = input + output for all 3 messages
      // priced: (100+50) + (200+80) = 430
      // unpriced: 300+120 = 420
      // total: 850
      assert.equal(bucket.billable_tokens, 850, "billable_tokens should include unpriced rows");
    } finally {
      close();
    }
  });

  it("excludes unknown cost_source from cost sums", () => {
    const result = openReadOnly(fixPath);
    assert.ok(result.ok);
    const { db, close } = result;
    try {
      const bucket = queryCostBucket(db, { from: 0, to: Date.now() });
      // cost from m1: (300+750)/1e6 = 0.001050
      // cost from m2: (600+1200)/1e6 = 0.001800
      // m3 excluded (unknown)
      const expectedCost = (300 + 750 + 600 + 1200) / 1_000_000;
      assert.ok(
        Math.abs(bucket.cost_usd - expectedCost) < 1e-9,
        `cost_usd should be ${expectedCost}, got ${bucket.cost_usd}`,
      );
    } finally {
      close();
    }
  });

  it("reports unpriced_count separately", () => {
    const result = openReadOnly(fixPath);
    assert.ok(result.ok);
    const { db, close } = result;
    try {
      const bucket = queryCostBucket(db, { from: 0, to: Date.now() });
      assert.equal(bucket.unpriced_count, 1, "unpriced_count should be 1");
    } finally {
      close();
    }
  });

  it("includes unpriced messages in COUNT turns and sessions", () => {
    const result = openReadOnly(fixPath);
    assert.ok(result.ok);
    const { db, close } = result;
    try {
      const bucket = queryCostBucket(db, { from: 0, to: Date.now() });
      assert.equal(bucket.messages, 3, "messages should count all 3 rows");
      assert.equal(bucket.turns, 1, "turns should count all turns (1 distinct turn_id)");
      assert.equal(bucket.sessions, 1, "sessions should count all sessions (1 distinct session_id)");
    } finally {
      close();
    }
  });
});

describe("queryCostBucketForSession: unpriced-row semantics", () => {
  it("counts tokens from unpriced rows in per-session bucket", () => {
    const result = openReadOnly(fixPath);
    assert.ok(result.ok);
    const { db, close } = result;
    try {
      const bucket = queryCostBucketForSession(db, "s1");
      assert.equal(bucket.billable_tokens, 850);
      assert.equal(bucket.unpriced_count, 1);
    } finally {
      close();
    }
  });
});

describe("queryModels: unpriced-row semantics", () => {
  it("counts tokens from unpriced rows in models breakdown", () => {
    const result = openReadOnly(fixPath);
    assert.ok(result.ok);
    const { db, close } = result;
    try {
      const { rows, unpriced_count } = queryModels(db, { from: 0, to: Date.now() });
      assert.equal(unpriced_count, 1);
      // All rows have model_id='claude-opus-4', so one group
      assert.equal(rows.length, 1);
      const row = rows[0]!;
      // billable_tokens for the model group = all 3 messages
      assert.equal(row.billable_tokens, 850);
      // cost excludes unknown
      const expectedCost = (300 + 750 + 600 + 1200) / 1_000_000;
      assert.ok(Math.abs(row.cost_usd - expectedCost) < 1e-9);
    } finally {
      close();
    }
  });
});

describe("queryDaily: unpriced-row semantics", () => {
  it("counts tokens from unpriced rows in daily breakdown", () => {
    const result = openReadOnly(fixPath);
    assert.ok(result.ok);
    const { db, close } = result;
    try {
      const { rows, unpriced_count } = queryDaily(db, { from: 0, to: Date.now() });
      assert.equal(unpriced_count, 1);
      assert.equal(rows.length, 1, "one day of data");
      const row = rows[0]!;
      assert.equal(row.billable_tokens, 850, "daily billable_tokens includes unpriced");
    } finally {
      close();
    }
  });
});

// ---------------------------------------------------------------------------
// Schema compatibility window tests
// ---------------------------------------------------------------------------

describe("openReadOnly: schema compatibility window", () => {
  const paths: string[] = [];

  after(() => {
    for (const p of paths) {
      try { rmSync(p); } catch { /* ignore */ }
      try { rmSync(p + "-wal"); } catch { /* ignore */ }
      try { rmSync(p + "-shm"); } catch { /* ignore */ }
    }
  });

  function tempPath(): string {
    const p = join(
      tmpdir(),
      `tt-schema-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
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
    createVersionedDb(p, 2); // MAX_KNOWN=1, so 2 is within window of 2
    const result = openReadOnly(p);
    assert.ok(result.ok, `should succeed for version 2 (degraded): ${!result.ok ? result.reason : ""}`);
    if (result.ok) {
      assert.equal(result.schemaStatus, "degraded");
      result.close();
    }
  });

  it("returns ok: false for version MAX+3 (too new, outside window)", () => {
    const p = tempPath();
    createVersionedDb(p, 4); // MAX_KNOWN=1+WINDOW=2, so 4 > 1+2=3 is too new
    const result = openReadOnly(p);
    assert.ok(!result.ok, "should fail for version 4 (too new)");
    if (!result.ok) {
      assert.ok(result.reason.includes("too new") || result.reason.includes("update"), `reason should mention update: ${result.reason}`);
    }
  });
});
