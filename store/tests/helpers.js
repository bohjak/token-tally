// @ts-check
/**
 * Shared test helpers for the @token-tally/store test suite.
 *
 * Keeps test files focused on assertions by centralising:
 *   - temp-directory creation / cleanup
 *   - minimal legacy Pi DB factory
 *   - writer open/close wrappers
 *   - row-count helpers
 */

"use strict";

const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const Database = require("better-sqlite3");

// ---------------------------------------------------------------------------
// Temp directory
// ---------------------------------------------------------------------------

/**
 * Creates a uniquely-named temp directory and registers a cleanup callback.
 * Returns the directory path. Call `cleanup()` in afterEach/after blocks.
 *
 * @returns {{ dir: string; cleanup: () => void }}
 */
function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "tt-test-"));
  return {
    dir,
    cleanup() {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; don't fail tests on teardown errors.
      }
    },
  };
}

// ---------------------------------------------------------------------------
// SQLite helpers
// ---------------------------------------------------------------------------

/**
 * Opens a plain better-sqlite3 connection with FK enforcement.
 * Useful for asserting row counts without going through AnalyticsWriter.
 *
 * @param {string} dbPath
 * @returns {import("better-sqlite3").Database}
 */
function openDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  return db;
}

/**
 * Returns the count of rows in `table`.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} table
 * @returns {number}
 */
function countRows(db, table) {
  const row = /** @type {{ n: number }} */ (
    db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get()
  );
  return row.n;
}

/**
 * Reads the schema_metadata.schema_version value, or 0 if absent.
 *
 * @param {import("better-sqlite3").Database} db
 * @returns {number}
 */
function readSchemaVersion(db) {
  const tableExists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_metadata'"
    )
    .get();
  if (tableExists == null) return 0;

  const row = /** @type {{ value: string } | undefined} */ (
    db.prepare("SELECT value FROM schema_metadata WHERE key='schema_version'").get()
  );
  return row != null ? parseInt(row.value, 10) : 0;
}

// ---------------------------------------------------------------------------
// Legacy Pi DB factory
// ---------------------------------------------------------------------------

/**
 * Creates a minimal legacy Pi analytics SQLite database at `dbPath` with the
 * exact schema the importer expects. Populates one row per relevant table.
 *
 * @param {string} dbPath
 * @param {{ sessions?: number; turns?: number; messages?: number; toolCalls?: number }} opts
 */
function makeLegacyDb(dbPath, opts = {}) {
  const sessionCount = opts.sessions ?? 1;
  const turnCount = opts.turns ?? 1;
  const messageCount = opts.messages ?? 1;
  const toolCallCount = opts.toolCalls ?? 1;

  mkdirSync(require("node:path").dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL DEFAULT '',
      repo_remote TEXT,
      repo_owner TEXT,
      repo_name TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      pi_version TEXT NOT NULL DEFAULT 'unknown'
    );
    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      idx INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      model_id TEXT,
      provider TEXT
    );
    CREATE TABLE IF NOT EXISTS llm_messages (
      id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'assistant',
      ts INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost_input REAL NOT NULL DEFAULT 0,
      cost_output REAL NOT NULL DEFAULT 0,
      cost_cache_read REAL NOT NULL DEFAULT 0,
      cost_cache_write REAL NOT NULL DEFAULT 0,
      cost_total REAL NOT NULL DEFAULT 0,
      model_id TEXT,
      provider TEXT
    );
    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      name TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER NOT NULL,
      is_error INTEGER NOT NULL DEFAULT 0
    );
  `);

  const now = Date.now();

  const insertSession = db.prepare(
    `INSERT INTO sessions (id, cwd, repo_owner, repo_name, started_at, ended_at, pi_version)
     VALUES (?, '/tmp/project', 'owner', 'repo', ?, ?, '1.0.0')`
  );
  const insertTurn = db.prepare(
    `INSERT INTO turns (id, session_id, idx, started_at, ended_at, model_id, provider)
     VALUES (?, ?, ?, ?, ?, 'claude', 'anthropic')`
  );
  const insertMsg = db.prepare(
    `INSERT INTO llm_messages
       (id, turn_id, session_id, role, ts,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total,
        model_id, provider)
     VALUES (?, ?, ?, 'assistant', ?,
             10, 20, 3, 4,
             0.001, 0.002, 0.0001, 0.0002, 0.0033,
             'claude', 'anthropic')`
  );
  const insertTool = db.prepare(
    `INSERT INTO tool_calls (id, turn_id, session_id, name, started_at, ended_at, is_error)
     VALUES (?, ?, ?, 'read', ?, ?, 0)`
  );

  db.transaction(() => {
    for (let s = 0; s < sessionCount; s++) {
      const sid = `legacy-sess-${s}`;
      insertSession.run(sid, now - 10_000 * (s + 1), now - 1_000 * (s + 1));

      for (let t = 0; t < turnCount; t++) {
        const tid = `legacy-turn-${s}-${t}`;
        insertTurn.run(tid, sid, t, now - 9_000, now - 8_000);

        for (let m = 0; m < messageCount; m++) {
          insertMsg.run(`legacy-msg-${s}-${t}-${m}`, tid, sid, now - 8_500);
        }
        for (let c = 0; c < toolCallCount; c++) {
          insertTool.run(`legacy-tc-${s}-${t}-${c}`, tid, sid, now - 7_000, now - 6_000);
        }
      }
    }
  })();

  db.close();
}

// ---------------------------------------------------------------------------
// Writer helpers
// ---------------------------------------------------------------------------

/**
 * Seeds a minimal valid harness + session + turn + llm_message into a writer.
 * Returns the created IDs.
 *
 * @param {import("../dist/src/index").AnalyticsWriter} writer
 * @param {{ harness?: string; sessionSuffix?: string }} [opts]
 * @returns {Promise<{ sessionId: string; turnId: string; messageId: string }>}
 */
async function seedMinimalData(writer, opts = {}) {
  const harness = opts.harness ?? "pi";
  const suffix = opts.sessionSuffix ?? "1";

  await writer.recordHarness({
    name: harness,
    displayName: harness === "pi" ? "Pi" : harness,
    version: "1.0.0",
    integrationVersion: "0.1.0",
  });

  const { id: sessionId } = await writer.recordSession({
    harnessId: harness,
    harnessSessionId: `sess-${suffix}`,
    cwd: "/tmp/project",
    repoOwner: "owner",
    repoName: "repo",
    startedAt: Date.now() - 5_000,
  });

  const { id: turnId } = await writer.recordTurn({
    harnessId: harness,
    sessionId,
    harnessTurnId: `turn-${suffix}`,
    turnIndex: 0,
    startedAt: Date.now() - 4_000,
    provider: "anthropic",
    modelId: "claude-3",
  });

  const messageId = `msg-${harness}-${suffix}`;
  await writer.recordLlmMessage({
    harnessId: harness,
    sessionId,
    turnId,
    harnessMessageId: messageId,
    ts: Date.now() - 3_000,
    provider: "anthropic",
    modelId: "claude-3",
    inputTokens: 100,
    outputTokens: 50,
    costInputMicros: 1_500,
    costOutputMicros: 3_000,
    costSource: "writer",
  });

  return { sessionId, turnId, messageId };
}

module.exports = {
  makeTempDir,
  openDb,
  countRows,
  readSchemaVersion,
  makeLegacyDb,
  seedMinimalData,
};
