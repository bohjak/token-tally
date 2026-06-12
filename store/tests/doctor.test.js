// @ts-check
/**
 * Tests: doctor diagnostics
 *
 * Covers:
 *   - Healthy migrated DB reports no semantic duplicates
 *   - LLM message duplicate check flags same-payload rows with distinct IDs
 *   - Tool-call duplicate check flags same-payload rows with distinct IDs
 */

"use strict";

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { join } = require("node:path");
const Database = require("better-sqlite3");
const { runDoctor, runMigrations } = require("../dist/src/index");
const { makeTempDir } = require("./helpers");

/**
 * @param {import("../dist/src/doctor").DoctorReport} report
 * @param {string} code
 */
function findFinding(report, code) {
  return report.findings.find((f) => f.code === code);
}

/**
 * Creates a migrated DB with one harness and two valid sessions sharing cwd.
 * Duplicate tests insert same-payload child rows under the two sessions.
 *
 * @param {string} dbPath
 * @returns {void}
 */
function seedDuplicateParents(dbPath) {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  runMigrations(db);

  db.exec(`
    INSERT INTO harnesses
      (name, display_name, version, integration_version, first_seen_at, last_seen_at)
    VALUES
      ('pi', 'Pi', '1.0.0', '0.1.0', 1000, 1000);

    INSERT INTO sessions
      (id, harness_id, harness_session_id, cwd, started_at, ended_at)
    VALUES
      ('session-a', 'pi', 'session-a', '/tmp/project', 1000, 5000),
      ('session-b', 'pi', 'session-b', '/tmp/project', 1000, 5000);

    INSERT INTO turns
      (id, session_id, harness_id, harness_turn_id, turn_index, started_at, ended_at)
    VALUES
      ('turn-a', 'session-a', 'pi', 'turn-a', 0, 2000, 3000),
      ('turn-b', 'session-b', 'pi', 'turn-b', 0, 2000, 3000);
  `);

  db.close();
}

describe("doctor diagnostics", () => {
  /** @type {{ dir: string; cleanup: () => void }} */
  let tmp;

  before(() => {
    tmp = makeTempDir();
  });

  after(() => {
    tmp.cleanup();
  });

  test("healthy migrated DB reports no semantic duplicates", () => {
    const dbPath = join(tmp.dir, "doctor-healthy.db");
    const db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    db.close();

    const report = runDoctor(dbPath);

    assert.equal(report.status, "ok");
    assert.equal(findFinding(report, "duplicate_llm_messages_ok")?.severity, "ok");
    assert.equal(findFinding(report, "duplicate_tool_calls_ok")?.severity, "ok");
  });

  test("doctor flags likely duplicate LLM message rows", () => {
    const dbPath = join(tmp.dir, "doctor-llm-dupes.db");
    seedDuplicateParents(dbPath);

    const db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    db.exec(`
      INSERT INTO llm_messages
        (id, session_id, turn_id, harness_id, harness_message_id, ts,
         provider, model_id, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens,
         cost_input_micros, cost_output_micros, cost_cache_read_micros,
         cost_cache_write_micros, cost_total_micros, cost_source)
      VALUES
        ('message-a', 'session-a', 'turn-a', 'pi', 'message-a', 4000,
         'anthropic', 'claude', 10, 20, 30, 40,
         100, 200, 300, 400, 1000, 'writer'),
        ('message-b', 'session-b', 'turn-b', 'pi', 'message-b', 4000,
         'anthropic', 'claude', 10, 20, 30, 40,
         100, 200, 300, 400, 1000, 'writer');
    `);
    db.close();

    const report = runDoctor(dbPath);
    const finding = findFinding(report, "duplicate_llm_messages");

    assert.equal(report.status, "ok", "duplicate warnings should not make doctor fail");
    assert.equal(finding?.severity, "warning");
    assert.equal(finding?.detail?.duplicateCount, 1);
    assert.equal(finding?.detail?.groupCount, 1);
  });

  test("doctor flags likely duplicate tool-call rows", () => {
    const dbPath = join(tmp.dir, "doctor-tool-dupes.db");
    seedDuplicateParents(dbPath);

    const db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    db.exec(`
      INSERT INTO tool_calls
        (id, session_id, turn_id, harness_id, harness_tool_call_id,
         tool_name, started_at, ended_at, is_error)
      VALUES
        ('tool-a', 'session-a', 'turn-a', 'pi', 'tool-a', 'bash', 4500, 4600, 0),
        ('tool-b', 'session-b', 'turn-b', 'pi', 'tool-b', 'bash', 4500, 4600, 0);
    `);
    db.close();

    const report = runDoctor(dbPath);
    const finding = findFinding(report, "duplicate_tool_calls");

    assert.equal(report.status, "ok", "duplicate warnings should not make doctor fail");
    assert.equal(finding?.severity, "warning");
    assert.equal(finding?.detail?.duplicateCount, 1);
    assert.equal(finding?.detail?.groupCount, 1);
  });
});
