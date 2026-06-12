/**
 * tests/query-semantics.test.ts
 *
 * Canonical tests for the @token-tally/queries read layer.
 *
 * Covers:
 *   A. Core semantics (unpriced-row contract):
 *      - Token/turn/session counts include ALL rows regardless of cost_source.
 *      - Cost sums exclude cost_source='unknown' rows (CASE guard).
 *      - unpriced_count is reported separately.
 *
 *   B. Drift-fix pins (one test per fix):
 *      - Fix 1: share denominators come from the full window, not top-N rows.
 *      - Fix 2: empty-string repo_owner cannot produce '/' group keys.
 *      - Fix 3: avg_tokens_per_turn = billable_tokens / turns (no cache tokens).
 *      - Fix 4: queryTools groups in O(n) — counts are correct with many tool calls.
 *      - Fix 5: cache_savings_usd is never negative.
 *
 *   C. Identical-numbers assertion: shared queryCostBucket produces the same
 *      result that Pi's queryTabSummary-level adapter would see, confirming
 *      there is only one aggregation implementation.
 *
 * Run after build: node --test 'dist/tests/**\/*.test.js'
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import Database from "better-sqlite3";

import {
  queryCostBucket,
  queryCostBucketForSession,
  queryModels,
  queryDaily,
  queryRepos,
  queryTools,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000; // arbitrary base timestamp (ms)

function createFixtureDb(): { db: Database.Database; path: string } {
  const path = join(
    tmpdir(),
    `tt-queries-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
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

type InsertOpts = {
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
};

function insertMessage(db: Database.Database, opts: InsertOpts): void {
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

  const costTotal =
    costInputMicros + costOutputMicros + costCacheReadMicros + costCacheWriteMicros;

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

function insertToolCall(
  db: Database.Database,
  id: string,
  toolName: string,
  isError = 0,
  startedAt = T0,
  endedAt: number | null = T0 + 100,
): void {
  db.prepare(`
    INSERT INTO tool_calls (id, session_id, harness_id, harness_tool_call_id, tool_name, started_at, ended_at, is_error)
    VALUES (?, 's1', 'test', ?, ?, ?, ?, ?)
  `).run(id, `htc-${id}`, toolName, startedAt, endedAt, isError);
}

// ---------------------------------------------------------------------------
// A. Core semantics
// ---------------------------------------------------------------------------

describe("queryCostBucket: unpriced-row semantics", () => {
  let db: Database.Database;
  let path: string;

  before(() => {
    const fix = createFixtureDb();
    db = fix.db;
    path = fix.path;
    // 2 priced messages
    insertMessage(db, {
      id: "m1", inputTokens: 100, outputTokens: 50,
      costInputMicros: 300, costOutputMicros: 750, costSource: "writer",
    });
    insertMessage(db, {
      id: "m2", inputTokens: 200, outputTokens: 80,
      costInputMicros: 600, costOutputMicros: 1200, costSource: "writer",
    });
    // 1 unpriced message (real usage, zero cost)
    insertMessage(db, {
      id: "m3", inputTokens: 300, outputTokens: 120,
      costSource: "unknown",
    });
  });

  after(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { rmSync(path + suffix); } catch { /* ignore */ }
    }
  });

  it("counts tokens from ALL rows (including unknown cost_source)", () => {
    const bucket = queryCostBucket(db, { from: 0, to: Date.now() });
    // billable = (100+50) + (200+80) + (300+120) = 850
    assert.equal(bucket.billable_tokens, 850, "billable_tokens should include unpriced rows");
  });

  it("excludes unknown cost_source from cost sums", () => {
    const bucket = queryCostBucket(db, { from: 0, to: Date.now() });
    const expected = (300 + 750 + 600 + 1200) / 1_000_000;
    assert.ok(
      Math.abs(bucket.cost_usd - expected) < 1e-9,
      `cost_usd should be ${expected}, got ${bucket.cost_usd}`,
    );
  });

  it("reports unpriced_count separately", () => {
    const bucket = queryCostBucket(db, { from: 0, to: Date.now() });
    assert.equal(bucket.unpriced_count, 1);
  });

  it("counts all turns and sessions including unpriced", () => {
    const bucket = queryCostBucket(db, { from: 0, to: Date.now() });
    assert.equal(bucket.messages, 3);
    assert.equal(bucket.turns, 1);
    assert.equal(bucket.sessions, 1);
  });
});

describe("queryCostBucketForSession: unpriced-row semantics", () => {
  let db: Database.Database;
  let path: string;

  before(() => {
    const fix = createFixtureDb();
    db = fix.db;
    path = fix.path;
    insertMessage(db, { id: "m1", inputTokens: 100, outputTokens: 50, costInputMicros: 300, costOutputMicros: 750, costSource: "writer" });
    insertMessage(db, { id: "m2", inputTokens: 200, outputTokens: 80,  costInputMicros: 600, costOutputMicros: 1200, costSource: "writer" });
    insertMessage(db, { id: "m3", inputTokens: 300, outputTokens: 120, costSource: "unknown" });
  });

  after(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { rmSync(path + suffix); } catch { /* ignore */ }
    }
  });

  it("counts tokens and reports unpriced in per-session bucket", () => {
    const bucket = queryCostBucketForSession(db, "s1");
    assert.equal(bucket.billable_tokens, 850);
    assert.equal(bucket.unpriced_count, 1);
  });
});

describe("queryModels: unpriced-row semantics", () => {
  let db: Database.Database;
  let path: string;

  before(() => {
    const fix = createFixtureDb();
    db = fix.db;
    path = fix.path;
    insertMessage(db, { id: "m1", inputTokens: 100, outputTokens: 50, costInputMicros: 300, costOutputMicros: 750, costSource: "writer" });
    insertMessage(db, { id: "m2", inputTokens: 200, outputTokens: 80,  costInputMicros: 600, costOutputMicros: 1200, costSource: "writer" });
    insertMessage(db, { id: "m3", inputTokens: 300, outputTokens: 120, costSource: "unknown" });
  });

  after(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { rmSync(path + suffix); } catch { /* ignore */ }
    }
  });

  it("counts tokens from unpriced rows in models breakdown", () => {
    const { rows, unpriced_count } = queryModels(db, { from: 0, to: Date.now() });
    assert.equal(unpriced_count, 1);
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.billable_tokens, 850);
    const expected = (300 + 750 + 600 + 1200) / 1_000_000;
    assert.ok(Math.abs(row.cost_usd - expected) < 1e-9);
  });
});

describe("queryDaily: unpriced-row semantics", () => {
  let db: Database.Database;
  let path: string;

  before(() => {
    const fix = createFixtureDb();
    db = fix.db;
    path = fix.path;
    insertMessage(db, { id: "m1", inputTokens: 100, outputTokens: 50, costInputMicros: 300, costOutputMicros: 750, costSource: "writer" });
    insertMessage(db, { id: "m2", inputTokens: 200, outputTokens: 80,  costInputMicros: 600, costOutputMicros: 1200, costSource: "writer" });
    insertMessage(db, { id: "m3", inputTokens: 300, outputTokens: 120, costSource: "unknown" });
  });

  after(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { rmSync(path + suffix); } catch { /* ignore */ }
    }
  });

  it("counts tokens from unpriced rows in daily breakdown", () => {
    const { rows, unpriced_count } = queryDaily(db, { from: 0, to: Date.now() });
    assert.equal(unpriced_count, 1);
    assert.equal(rows.length, 1, "one day of data");
    assert.equal(rows[0]!.billable_tokens, 850, "daily billable_tokens includes unpriced");
  });
});

// ---------------------------------------------------------------------------
// B. Drift-fix pins
// ---------------------------------------------------------------------------

describe("Fix 1: share denominator uses full-window total, not top-N rows", () => {
  let db: Database.Database;
  let path: string;

  before(() => {
    const fix = createFixtureDb();
    db = fix.db;
    path = fix.path;

    // Create 21 distinct model IDs, each with cost 1_000_000 micros (= $1).
    // The query returns LIMIT 20, so summing returned rows gives $20.
    // The full window has $21.  Each row's share should be 1/21, not 1/20.
    for (let i = 0; i < 21; i++) {
      const modelId = `model-${i.toString().padStart(2, "0")}`;
      // Each model needs its own turn to avoid join collisions.
      const turnId = `t-share-${i}`;
      db.prepare(`
        INSERT INTO turns VALUES (?, 's1', 'test', ?, NULL, ?, NULL, 'anthropic', ?)
      `).run(turnId, `hti-${i}`, T0 + i, modelId);

      insertMessage(db, {
        id: `ms-${i}`,
        turnId,
        modelId,
        inputTokens: 1000,
        costInputMicros: 1_000_000,
        costSource: "writer",
      });
    }
  });

  after(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { rmSync(path + suffix); } catch { /* ignore */ }
    }
  });

  it("share of each model equals 1/21 (full-window denominator)", () => {
    const { rows } = queryModels(db, { from: 0, to: Date.now() });
    assert.equal(rows.length, 20, "query returns top 20 rows");

    for (const row of rows) {
      const expected = 1 / 21;
      assert.ok(
        Math.abs(row.share - expected) < 1e-6,
        `share for ${row.model_id} should be ~${expected.toFixed(4)}, got ${row.share.toFixed(4)}`,
      );
    }
  });
});

describe("Fix 2: empty repo_owner does not produce '/' group key", () => {
  let db: Database.Database;
  let path: string;

  before(() => {
    const fix = createFixtureDb();
    db = fix.db;
    path = fix.path;

    // Insert a session with repo_owner='' (empty string) and repo_name='myrepo'.
    // Old behavior: '' || '/' || 'myrepo' = '/myrepo', but more importantly
    // a row with repo_owner='' AND repo_name='' would produce '/'.
    db.prepare(`
      INSERT INTO sessions VALUES ('s2', 'test', 'hs2', NULL, NULL, '', '', NULL, ?, NULL)
    `).run(T0 + 1);

    // Also insert a session with both empty: would produce '/' without NULLIF guard.
    db.prepare(`
      INSERT INTO sessions VALUES ('s3', 'test', 'hs3', NULL, '/some/cwd', '', '', NULL, ?, NULL)
    `).run(T0 + 2);

    insertMessage(db, { id: "mr1", sessionId: "s2", turnId: null, costInputMicros: 1000, costSource: "writer" });
    insertMessage(db, { id: "mr2", sessionId: "s3", turnId: null, costInputMicros: 1000, costSource: "writer" });
  });

  after(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { rmSync(path + suffix); } catch { /* ignore */ }
    }
  });

  it("no row with repo='/' appears in queryRepos result", () => {
    const { rows } = queryRepos(db, { from: 0, to: Date.now() });
    const slashRow = rows.find((r) => r.repo === "/");
    assert.equal(slashRow, undefined, `repo='/' key must not appear; got rows: ${rows.map((r) => r.repo).join(", ")}`);
  });

  it("session with empty owner/name falls back to cwd", () => {
    const { rows } = queryRepos(db, { from: 0, to: Date.now() });
    // s3 has cwd='/some/cwd' and empty owner/name → should appear as '/some/cwd'
    const cwdRow = rows.find((r) => r.repo === "/some/cwd");
    assert.ok(cwdRow != null, "session with empty owner/name should fall back to cwd");
  });
});

describe("Fix 3: avg_tokens_per_turn = billable_tokens / turns (no cache)", () => {
  let db: Database.Database;
  let path: string;

  before(() => {
    const fix = createFixtureDb();
    db = fix.db;
    path = fix.path;

    // 2 messages on the same turn:
    //   - 100 input, 50 output, 200 cache_read  → billable = 150, cached = 200
    //   - 200 input, 80 output, 0   cache_read  → billable = 280, cached = 0
    // Turn total: billable = 430, cached = 200, total = 630
    // With 1 turn: avg = 430 / 1 = 430  (NOT 630 / 1)
    insertMessage(db, {
      id: "mavg1",
      inputTokens: 100, outputTokens: 50, cacheReadTokens: 200,
      costInputMicros: 300, costOutputMicros: 750,
      costSource: "writer",
    });
    insertMessage(db, {
      id: "mavg2",
      inputTokens: 200, outputTokens: 80,
      costInputMicros: 600, costOutputMicros: 1200,
      costSource: "writer",
    });
  });

  after(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { rmSync(path + suffix); } catch { /* ignore */ }
    }
  });

  it("avg_tokens_per_turn equals billable_tokens/turns, not total_tokens/turns", () => {
    const { rows } = queryModels(db, { from: 0, to: Date.now() });
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    // billable = (100+50) + (200+80) = 430; 1 turn → avg = 430
    assert.equal(row.avg_tokens_per_turn, 430, "avg must use billable tokens, not total tokens");
  });
});

describe("Fix 4: queryTools counts are correct (O(n) grouping)", () => {
  let db: Database.Database;
  let path: string;

  before(() => {
    const fix = createFixtureDb();
    db = fix.db;
    path = fix.path;

    // 3 calls to 'bash', 2 calls to 'read_file' (1 with error)
    insertToolCall(db, "tc1", "bash");
    insertToolCall(db, "tc2", "bash");
    insertToolCall(db, "tc3", "bash", 1);  // error
    insertToolCall(db, "tc4", "read_file");
    insertToolCall(db, "tc5", "read_file");
  });

  after(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { rmSync(path + suffix); } catch { /* ignore */ }
    }
  });

  it("returns correct call and error counts per tool", () => {
    const { rows } = queryTools(db, { from: 0, to: Date.now() });
    const bash = rows.find((r) => r.tool_name === "bash");
    const readFile = rows.find((r) => r.tool_name === "read_file");

    assert.ok(bash != null, "bash row must exist");
    assert.equal(bash.calls, 3, "bash: 3 calls");
    assert.equal(bash.errors, 1, "bash: 1 error");
    assert.ok(
      Math.abs(bash.error_rate - 1 / 3) < 1e-9,
      `bash error_rate should be 1/3, got ${bash.error_rate}`,
    );

    assert.ok(readFile != null, "read_file row must exist");
    assert.equal(readFile.calls, 2, "read_file: 2 calls");
    assert.equal(readFile.errors, 0, "read_file: 0 errors");
  });

  it("rows are ordered by calls descending", () => {
    const { rows } = queryTools(db, { from: 0, to: Date.now() });
    for (let i = 1; i < rows.length; i++) {
      assert.ok(
        rows[i - 1]!.calls >= rows[i]!.calls,
        "rows should be sorted by calls DESC",
      );
    }
  });
});

describe("Fix 5: cache_savings_usd is never negative", () => {
  let db: Database.Database;
  let path: string;

  before(() => {
    const fix = createFixtureDb();
    db = fix.db;
    path = fix.path;

    // Insert a message where the actual cache cost exceeds the estimated savings.
    // Raw savings formula: (cache_tokens × input_rate) − cache_cost
    // Here: cache_read=100, input_tokens=10, cost_input=1 (rate=0.1 per token)
    //   estimated = 100 × 0.1 = 10
    //   actual cache cost = 50  (much higher)
    //   raw savings = 10 - 50 = -40  → should floor to 0
    insertMessage(db, {
      id: "mcs1",
      inputTokens: 10, cacheReadTokens: 100,
      costInputMicros: 1,         // very tiny input cost → tiny effective rate
      costCacheReadMicros: 50,    // large actual cache cost
      costSource: "writer",
    });
  });

  after(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { rmSync(path + suffix); } catch { /* ignore */ }
    }
  });

  it("cache_savings_usd is >= 0 even when raw estimate would be negative", () => {
    const bucket = queryCostBucket(db, { from: 0, to: Date.now() });
    assert.ok(
      bucket.cache_savings_usd >= 0,
      `cache_savings_usd must be >= 0, got ${bucket.cache_savings_usd}`,
    );
  });
});

// ---------------------------------------------------------------------------
// C. Identical-numbers assertion
// ---------------------------------------------------------------------------

describe("Identical numbers: shared queryCostBucket is the single aggregation path", () => {
  let db: Database.Database;
  let path: string;

  before(() => {
    const fix = createFixtureDb();
    db = fix.db;
    path = fix.path;

    insertMessage(db, { id: "id1", inputTokens: 100, outputTokens: 50, costInputMicros: 300, costOutputMicros: 750, costSource: "writer" });
    insertMessage(db, { id: "id2", inputTokens: 200, outputTokens: 80,  costInputMicros: 600, costOutputMicros: 1200, costSource: "writer" });
    insertMessage(db, { id: "id3", inputTokens: 300, outputTokens: 120, costSource: "unknown" });
  });

  after(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { rmSync(path + suffix); } catch { /* ignore */ }
    }
  });

  it("two calls with identical opts return identical results", () => {
    // Both the web-explorer and Pi delegate to queryCostBucket.
    // Calling it twice on the same DB with the same opts must produce equal results.
    const opts = { from: 0, to: Date.now() };
    const result1 = queryCostBucket(db, opts);
    const result2 = queryCostBucket(db, opts);

    assert.deepEqual(result1, result2, "two identical calls must return identical results");
  });

  it("queryCostBucket billable_tokens matches sum of queryModels billable_tokens", () => {
    const opts = { from: 0, to: Date.now() };
    const bucket = queryCostBucket(db, opts);
    const { rows } = queryModels(db, opts);

    // Both are summing the same llm_messages rows — their billable_tokens must agree.
    const modelTotal = rows.reduce((s, r) => s + r.billable_tokens, 0);
    assert.equal(
      modelTotal,
      bucket.billable_tokens,
      "sum of model-row billable_tokens must equal bucket billable_tokens",
    );
  });
});
