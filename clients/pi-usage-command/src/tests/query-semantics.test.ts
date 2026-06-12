/**
 * src/tests/query-semantics.test.ts
 *
 * Tests for pi-usage-command query-layer contract:
 *   1. Token/turn/session counts include ALL rows regardless of cost_source.
 *   2. Cost sums exclude cost_source='unknown' rows (CASE guard).
 *   3. unpriced_count is reported separately.
 *   4. Schema compatibility window enforcement in openReadOnly.
 *
 * Runs via: node --experimental-strip-types --test 'src/tests/**\/*.test.ts'
 *
 * NOTE: pi-usage-command exposes queryTabSummary/queryTabModels/queryTabDaily
 * as the public API; the internal queryCostBucket helper is tested indirectly
 * through those exported functions.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

// Import Database directly — better-sqlite3 is available in this package.
// We create fixture DBs at known paths for tests that need files (schema window).
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";

// Import the public query API and the db helper.
import { queryTabSummary, queryTabModels, queryTabDaily } from "../queries.ts";
import { openReadOnly } from "../db.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const T0 = Date.now(); // current time so rows fall in today/week/month windows

function createFixtureDb(): { db: BetterSqlite3.Database; path: string } {
  const path = join(
    tmpdir(),
    `tt-pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
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
    CREATE TABLE tool_calls (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      turn_id TEXT, harness_id TEXT NOT NULL,
      harness_tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      started_at INTEGER NOT NULL, ended_at INTEGER,
      is_error INTEGER NOT NULL DEFAULT 0,
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
  db: BetterSqlite3.Database,
  opts: {
    id: string;
    sessionId?: string;
    turnId?: string | null;
    ts?: number;
    modelId?: string;
    inputTokens?: number;
    outputTokens?: number;
    costInputMicros?: number;
    costOutputMicros?: number;
    costSource: "writer" | "harness" | "subscription_covered" | "unknown";
  },
): void {
  const {
    id, sessionId = "s1", turnId = "t1", ts = T0,
    modelId = "claude-opus-4",
    inputTokens = 0, outputTokens = 0,
    costInputMicros = 0, costOutputMicros = 0,
    costSource,
  } = opts;
  const costTotal = costInputMicros + costOutputMicros;

  db.prepare(`
    INSERT INTO llm_messages (
      id, session_id, turn_id, harness_id, harness_message_id,
      ts, model_id,
      input_tokens, output_tokens,
      cost_input_micros, cost_output_micros,
      cost_cache_read_micros, cost_cache_write_micros,
      cost_total_micros, cost_source
    ) VALUES (?, ?, ?, 'test', ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
  `).run(
    id, sessionId, turnId, `hm-${id}`,
    ts, modelId,
    inputTokens, outputTokens,
    costInputMicros, costOutputMicros,
    costTotal, costSource,
  );
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
// Shared fixture
// ---------------------------------------------------------------------------

let fixDb: BetterSqlite3.Database;
let fixPath: string;

before(() => {
  const fix = createFixtureDb();
  fixDb = fix.db;
  fixPath = fix.path;

  // 2 priced messages
  insertMessage(fixDb, { id: "m1", inputTokens: 100, outputTokens: 50, costInputMicros: 300, costOutputMicros: 750, costSource: "writer" });
  insertMessage(fixDb, { id: "m2", inputTokens: 200, outputTokens: 80, costInputMicros: 600, costOutputMicros: 1200, costSource: "writer" });
  // 1 unpriced message (real usage, zero cost)
  insertMessage(fixDb, { id: "m3", inputTokens: 300, outputTokens: 120, costInputMicros: 0, costOutputMicros: 0, costSource: "unknown" });

  fixDb.close();
});

after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { rmSync(fixPath + suffix); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// Token semantics via queryTabSummary
// ---------------------------------------------------------------------------

describe("queryTabSummary: unpriced-row semantics", () => {
  it("counts tokens from ALL rows in all time buckets", () => {
    const result = openReadOnly(fixPath);
    assert.ok(result.ok, `openReadOnly failed: ${!result.ok ? result.reason : "n/a"}`);
    const { db, close } = result;
    try {
      const data = queryTabSummary(db) as {
        today: { billable_tokens: number; cost_usd: number; unpriced_count: number };
        week:  { billable_tokens: number; cost_usd: number };
      };

      // All 3 messages are within the "all time" window used by queryTabSummary for today/week
      // (the fixture ts = T0 = 2023-11-14, well within 30-day lookback from now)
      // Expected billable_tokens: (100+50)+(200+80)+(300+120) = 850
      assert.equal(
        data.today.billable_tokens,
        850,
        "today.billable_tokens must include unpriced rows",
      );
      // Expected cost: (300+750+600+1200)/1e6 = 0.00285
      const expectedCost = (300 + 750 + 600 + 1200) / 1_000_000;
      assert.ok(
        Math.abs(data.today.cost_usd - expectedCost) < 1e-9,
        `today.cost_usd should be ${expectedCost}, got ${data.today.cost_usd}`,
      );
      assert.equal(data.today.unpriced_count, 1, "today.unpriced_count must be 1");
    } finally {
      close();
    }
  });
});

// ---------------------------------------------------------------------------
// Token semantics via queryTabModels
// ---------------------------------------------------------------------------

describe("queryTabModels: unpriced-row semantics", () => {
  it("counts tokens from unpriced rows in model breakdown", () => {
    const result = openReadOnly(fixPath);
    assert.ok(result.ok);
    const { db, close } = result;
    try {
      const data = queryTabModels(db, "all") as {
        rows: Array<{ model_id: string; billable_tokens: number; cost_usd: number }>;
        unpriced_count: number;
      };
      assert.equal(data.unpriced_count, 1);
      assert.equal(data.rows.length, 1);
      const row = data.rows[0]!;
      assert.equal(row.billable_tokens, 850, "model billable_tokens must include unpriced");
      const expectedCost = (300 + 750 + 600 + 1200) / 1_000_000;
      assert.ok(Math.abs(row.cost_usd - expectedCost) < 1e-9);
    } finally {
      close();
    }
  });
});

// ---------------------------------------------------------------------------
// Token semantics via queryTabDaily
// ---------------------------------------------------------------------------

describe("queryTabDaily: unpriced-row semantics", () => {
  it("counts tokens from unpriced rows in daily breakdown", () => {
    const result = openReadOnly(fixPath);
    assert.ok(result.ok);
    const { db, close } = result;
    try {
      const data = queryTabDaily(db, "all") as {
        rows: Array<{ date: string; billable_tokens: number; cost_usd: number }>;
        unpriced_count: number;
      };
      assert.equal(data.unpriced_count, 1);
      assert.equal(data.rows.length, 1, "one day of data");
      const row = data.rows[0]!;
      assert.equal(row.billable_tokens, 850, "daily billable_tokens includes unpriced");
    } finally {
      close();
    }
  });
});

// ---------------------------------------------------------------------------
// Schema compatibility window
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
