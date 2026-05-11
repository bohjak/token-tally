// @ts-check
/**
 * CLI helper: create a minimal legacy Pi analytics database at a given path.
 *
 * Used for testing the legacy import path and for manual exploration.
 *
 * Usage:
 *   node fixtures/store/make-legacy-db.js --out /tmp/legacy.db [--sessions 5]
 *
 * The generated DB matches the schema that importLegacyPi expects:
 *   sessions, turns, llm_messages (role='assistant'), tool_calls
 */

"use strict";

const Database = require("better-sqlite3");
const { mkdirSync } = require("node:fs");
const { dirname } = require("node:path");

/**
 * Creates a legacy Pi DB at `outPath` with `sessionCount` sessions,
 * one turn per session, and one assistant message + one tool call per turn.
 *
 * @param {string} outPath
 * @param {{ sessions?: number }} opts
 */
function makeLegacyDb(outPath, opts = {}) {
  const sessionCount = opts.sessions ?? 3;

  mkdirSync(dirname(outPath), { recursive: true });
  const db = new Database(outPath);

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

  const insSession = db.prepare(
    `INSERT INTO sessions (id, cwd, repo_owner, repo_name, started_at, ended_at, pi_version)
     VALUES (?, '/Users/me/project', 'acme', 'my-project', ?, ?, '1.0.0')`
  );
  const insTurn = db.prepare(
    `INSERT INTO turns (id, session_id, idx, started_at, ended_at, model_id, provider)
     VALUES (?, ?, 0, ?, ?, 'claude-3-opus-20240229', 'anthropic')`
  );
  const insMsg = db.prepare(
    `INSERT INTO llm_messages
       (id, turn_id, session_id, role, ts,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total,
        model_id, provider)
     VALUES (?, ?, ?, 'assistant', ?,
             1234, 567, 89, 23,
             0.0037, 0.0085, 0.00044, 0.00023, 0.01287,
             'claude-3-opus-20240229', 'anthropic')`
  );
  const insTool = db.prepare(
    `INSERT INTO tool_calls (id, turn_id, session_id, name, started_at, ended_at, is_error)
     VALUES (?, ?, ?, 'read_file', ?, ?, 0)`
  );

  db.transaction(() => {
    for (let i = 0; i < sessionCount; i++) {
      const sid = `legacy-session-${i}`;
      const tStart = now - (sessionCount - i) * 3_600_000;
      insSession.run(sid, tStart, tStart + 60_000);

      const tid = `legacy-turn-${i}`;
      insTurn.run(tid, sid, tStart + 1_000, tStart + 55_000);
      insMsg.run(`legacy-msg-${i}`, tid, sid, tStart + 30_000);
      insTool.run(`legacy-tc-${i}`, tid, sid, tStart + 10_000, tStart + 11_000);
    }
  })();

  db.close();
  console.log(`Legacy Pi DB created: ${outPath} (${sessionCount} sessions)`);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);

  /** @type {string | undefined} */
  let outPath;
  let sessions = 3;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out" && args[i + 1]) {
      outPath = args[++i];
    } else if (args[i] === "--sessions" && args[i + 1]) {
      sessions = parseInt(args[++i], 10);
    }
  }

  if (outPath == null) {
    console.error("Usage: node fixtures/store/make-legacy-db.js --out <path> [--sessions N]");
    process.exit(1);
  }

  makeLegacyDb(outPath, { sessions });
}

main();
