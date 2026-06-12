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
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const Database = require("better-sqlite3");
const { compareSessionLogs, repairDoctorFindings, repairPiCanonicalIds, runDoctor, runMigrations } = require("../dist/src/index");
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
      (id, harness_id, harness_session_id, session_file, cwd, started_at, ended_at)
    VALUES
      ('session-a', 'pi', 'session-a', '/tmp/session-a.jsonl', '/tmp/project', 1000, 5000),
      ('session-b', 'pi', 'session-b', '/tmp/session-b.jsonl', '/tmp/project', 1000, 5000);

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

  test("doctor flags Pi replay duplicate LLM message rows with synthesized IDs", () => {
    const dbPath = join(tmp.dir, "doctor-pi-replay-dupes.db");
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
        ('message-real', 'session-a', 'turn-a', 'pi', 'msg_real_provider_id', 4000,
         'anthropic', 'claude', 10, 20, 30, 40,
         100, 200, 300, 400, 1000, 'harness'),
        ('message-replay', 'session-a', 'turn-a', 'pi', '/tmp/session-a.jsonl:t0:m0', 4500,
         'anthropic', 'claude', 10, 20, 30, 40,
         100, 200, 300, 400, 1000, 'harness');
    `);
    db.close();

    const report = runDoctor(dbPath);
    const finding = findFinding(report, "duplicate_pi_replay_llm_messages");

    assert.equal(report.status, "ok", "duplicate warnings should not make doctor fail");
    assert.equal(findFinding(report, "duplicate_llm_messages_ok")?.severity, "ok");
    assert.equal(finding?.severity, "warning");
    assert.equal(finding?.detail?.duplicateCount, 1);
    assert.equal(finding?.detail?.groupCount, 1);
  });

  test("doctor does not flag repeated real provider rows as Pi replay duplicates", () => {
    const dbPath = join(tmp.dir, "doctor-pi-replay-legit-repeat.db");
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
        ('message-real-a', 'session-a', 'turn-a', 'pi', 'msg_real_a', 4000,
         'anthropic', 'claude', 10, 20, 30, 40,
         100, 200, 300, 400, 1000, 'harness'),
        ('message-real-b', 'session-a', 'turn-a', 'pi', 'msg_real_b', 4500,
         'anthropic', 'claude', 10, 20, 30, 40,
         100, 200, 300, 400, 1000, 'harness');
    `);
    db.close();

    const report = runDoctor(dbPath);

    assert.equal(findFinding(report, "duplicate_pi_replay_llm_messages_ok")?.severity, "ok");
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

  test("repair dry-run reports duplicate rows without changing data", () => {
    const dbPath = join(tmp.dir, "doctor-repair-dry-run.db");
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

    const repair = repairDoctorFindings(dbPath, false);
    const verifyDb = new Database(dbPath);
    const row = /** @type {{ n: number }} */ (
      verifyDb.prepare("SELECT COUNT(*) AS n FROM tool_calls").get()
    );
    verifyDb.close();

    assert.equal(repair.status, "ok");
    assert.equal(repair.applied, false);
    assert.equal(
      repair.actions.find((a) => a.code === "repair_duplicate_tool_calls")?.affectedRows,
      1,
    );
    assert.equal(row.n, 2, "dry-run must not delete rows");
  });

  test("repair apply removes Pi replay duplicates and keeps provider ID rows", () => {
    const dbPath = join(tmp.dir, "doctor-repair-pi-replay.db");
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
        ('message-real', 'session-a', 'turn-a', 'pi', 'msg_real_provider_id', 4000,
         'anthropic', 'claude', 10, 20, 30, 40,
         100, 200, 300, 400, 1000, 'harness'),
        ('message-replay', 'session-a', 'turn-a', 'pi', '/tmp/session-a.jsonl:t0:m0', 4500,
         'anthropic', 'claude', 10, 20, 30, 40,
         100, 200, 300, 400, 1000, 'harness');
    `);
    db.close();

    const repair = repairDoctorFindings(dbPath, true);
    const verifyDb = new Database(dbPath);
    const rows = verifyDb
      .prepare("SELECT harness_message_id FROM llm_messages ORDER BY harness_message_id")
      .all();
    verifyDb.close();

    assert.equal(repair.status, "ok");
    assert.equal(
      repair.actions.find((a) => a.code === "repair_duplicate_pi_replay_llm_messages")?.affectedRows,
      1,
    );
    assert.deepEqual(rows, [{ harness_message_id: "msg_real_provider_id" }]);
  });

  test("Pi session compare reports DB versus log drift for bounded window", () => {
    const dbPath = join(tmp.dir, "doctor-pi-compare.db");
    const sessionsRoot = join(tmp.dir, "pi-sessions");
    const slugDir = join(sessionsRoot, "--tmp-project--");
    const sessionFile = join(slugDir, "2026-06-12T00-00-00-000Z_session-a.jsonl");
    mkdirSync(slugDir, { recursive: true });

    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "session", id: "pi-session-a", timestamp: "2026-06-12T00:00:00.000Z", cwd: "/tmp/project" }),
        JSON.stringify({ type: "message", id: "u1", timestamp: "2026-06-12T00:00:01.000Z", message: { role: "user" } }),
        JSON.stringify({
          type: "message",
          id: "a1",
          timestamp: "2026-06-12T00:00:02.000Z",
          message: {
            role: "assistant",
            provider: "anthropic",
            model: "claude",
            responseId: "msg_in_both",
            timestamp: Date.parse("2026-06-12T00:00:02.000Z"),
            usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: { input: 0.0001, output: 0.0002, cacheRead: 0.0003, cacheWrite: 0.0004, total: 0.001 } },
          },
        }),
        JSON.stringify({
          type: "message",
          id: "a2",
          timestamp: "2026-06-12T00:00:03.000Z",
          message: {
            role: "assistant",
            provider: "anthropic",
            model: "claude",
            responseId: "msg_missing_in_db",
            timestamp: Date.parse("2026-06-12T00:00:03.000Z"),
            usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { input: 0.00001, output: 0.00002, cacheRead: 0.00003, cacheWrite: 0.00004, total: 0.0001 } },
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    db.exec(`
      INSERT INTO harnesses
        (name, display_name, version, integration_version, first_seen_at, last_seen_at)
      VALUES
        ('pi', 'Pi', '1.0.0', '0.1.0', 1000, 1000);

      INSERT INTO sessions
        (id, harness_id, harness_session_id, session_file, cwd, started_at, ended_at)
      VALUES
        ('session-a', 'pi', '${sessionFile}', '${sessionFile}', '/tmp/project', 1000, 5000);

      INSERT INTO turns
        (id, session_id, harness_id, harness_turn_id, turn_index, started_at, ended_at)
      VALUES
        ('turn-a', 'session-a', 'pi', 'turn-a', 0, 2000, 3000);

      INSERT INTO llm_messages
        (id, session_id, turn_id, harness_id, harness_message_id, ts,
         provider, model_id, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens,
         cost_input_micros, cost_output_micros, cost_cache_read_micros,
         cost_cache_write_micros, cost_total_micros, cost_source)
      VALUES
        ('message-both', 'session-a', 'turn-a', 'pi', 'msg_in_both', 1781222402000,
         'anthropic', 'claude', 10, 20, 30, 40,
         100, 200, 300, 400, 1000, 'harness'),
        ('message-extra', 'session-a', 'turn-a', 'pi', 'msg_extra_in_db', 1781222404000,
         'anthropic', 'claude', 5, 6, 7, 8,
         50, 60, 70, 80, 260, 'harness');
    `);
    db.close();

    const report = compareSessionLogs({
      dbPath,
      piSessionsPath: sessionsRoot,
      harnesses: ["pi"],
      from: "2026-06-12",
      to: "2026-06-13",
    });
    const piReport = report.reports[0];

    assert.equal(report.status, "warning");
    assert.equal(report.harnessesCompared[0], "pi");
    assert.equal(piReport?.db.messages, 2);
    assert.equal(piReport?.logs.messages, 2);
    assert.equal(piReport?.missingInDb.count, 1);
    assert.equal(piReport?.missingInDb.sample[0]?.harnessMessageId, "msg_missing_in_db");
    assert.equal(piReport?.extraInDb.count, 1);
    assert.equal(piReport?.extraInDb.sample[0]?.harnessMessageId, "msg_extra_in_db");
  });

  test("canonical-ID repair matches synthesized DB rows to provider-ID log rows", () => {
    const dbPath = join(tmp.dir, "doctor-pi-canonical-repair.db");
    const sessionsRoot = join(tmp.dir, "pi-canonical-sessions");
    const slugDir = join(sessionsRoot, "--tmp-project--");
    const sessionFile = join(slugDir, "2026-06-12T00-00-00-000Z_session-a.jsonl");
    mkdirSync(slugDir, { recursive: true });

    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "session", id: "pi-session-a", timestamp: "2026-06-12T00:00:00.000Z", cwd: "/tmp/project" }),
        JSON.stringify({ type: "message", id: "u1", timestamp: "2026-06-12T00:00:01.000Z", message: { role: "user" } }),
        JSON.stringify({
          type: "message",
          id: "a1",
          timestamp: "2026-06-12T00:00:02.000Z",
          message: {
            role: "assistant",
            provider: "anthropic",
            model: "claude",
            responseId: "msg_canonical_target",
            timestamp: Date.parse("2026-06-12T00:00:02.000Z"),
            usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: { input: 0.0001, output: 0.0002, cacheRead: 0.0003, cacheWrite: 0.0004, total: 0.001 } },
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    // Live-writer row for the same call: synthesized ID, ts +7s like the
    // message_end hook stamp, identical payload.
    db.exec(`
      INSERT INTO harnesses
        (name, display_name, version, integration_version, first_seen_at, last_seen_at)
      VALUES
        ('pi', 'Pi', '1.0.0', '0.1.0', 1000, 1000);

      INSERT INTO sessions
        (id, harness_id, harness_session_id, session_file, cwd, started_at, ended_at)
      VALUES
        ('session-a', 'pi', '${sessionFile}', '${sessionFile}', '/tmp/project', 1000, 5000);

      INSERT INTO turns
        (id, session_id, harness_id, harness_turn_id, turn_index, started_at, ended_at)
      VALUES
        ('turn-a', 'session-a', 'pi', 'turn-a', 0, 2000, 3000);

      INSERT INTO llm_messages
        (id, session_id, turn_id, harness_id, harness_message_id, ts,
         provider, model_id, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens,
         cost_input_micros, cost_output_micros, cost_cache_read_micros,
         cost_cache_write_micros, cost_total_micros, cost_source)
      VALUES
        ('message-synth', 'session-a', 'turn-a', 'pi', '${sessionFile}:t0:m0', ${Date.parse("2026-06-12T00:00:09.000Z")},
         'anthropic', 'claude', 10, 20, 30, 40,
         100, 200, 300, 400, 1000, 'harness');
    `);
    db.close();

    // Dry-run: reports the match but does not modify the DB.
    const dryRun = repairPiCanonicalIds({
      dbPath,
      sessionsPath: sessionsRoot,
      from: "2026-06-12",
      to: "2026-06-13",
    });

    assert.equal(dryRun.status, "ok");
    assert.equal(dryRun.applied, false);
    assert.equal(dryRun.matched, 1);
    assert.equal(dryRun.updated, 0);
    assert.equal(dryRun.sample[0]?.fromHarnessMessageId, `${sessionFile}:t0:m0`);
    assert.equal(dryRun.sample[0]?.toHarnessMessageId, "msg_canonical_target");
    assert.equal(dryRun.sample[0]?.tsOffsetMs, 7000);

    const dbAfterDry = new Database(dbPath, { readonly: true });
    const dryRow = /** @type {{ harness_message_id: string }} */ (
      dbAfterDry.prepare("SELECT harness_message_id FROM llm_messages WHERE id = 'message-synth'").get()
    );
    dbAfterDry.close();
    assert.equal(dryRow.harness_message_id, `${sessionFile}:t0:m0`, "dry-run must not modify rows");

    // Apply: updates the synthesized ID in place.
    const applied = repairPiCanonicalIds({
      dbPath,
      sessionsPath: sessionsRoot,
      from: "2026-06-12",
      to: "2026-06-13",
      apply: true,
    });

    assert.equal(applied.status, "ok");
    assert.equal(applied.applied, true);
    assert.equal(applied.matched, 1);
    assert.equal(applied.updated, 1);
    assert.equal(applied.conflicts, 0);

    const verifyDb = new Database(dbPath, { readonly: true });
    const row = /** @type {{ harness_message_id: string, session_id: string }} */ (
      verifyDb.prepare("SELECT harness_message_id, session_id FROM llm_messages WHERE id = 'message-synth'").get()
    );
    const count = /** @type {{ n: number }} */ (
      verifyDb.prepare("SELECT COUNT(*) AS n FROM llm_messages").get()
    );
    verifyDb.close();

    assert.equal(row.harness_message_id, "msg_canonical_target");
    assert.equal(row.session_id, "session-a", "attribution preserved");
    assert.equal(count.n, 1, "update in place — no new rows");

    // Idempotent: a second run finds nothing left to repair.
    const again = repairPiCanonicalIds({
      dbPath,
      sessionsPath: sessionsRoot,
      from: "2026-06-12",
      to: "2026-06-13",
      apply: true,
    });
    assert.equal(again.matched, 0);
    assert.equal(again.updated, 0);
  });

  test("repair apply removes duplicates and closes stale sessions", () => {
    const dbPath = join(tmp.dir, "doctor-repair-apply.db");
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

      INSERT INTO tool_calls
        (id, session_id, turn_id, harness_id, harness_tool_call_id,
         tool_name, started_at, ended_at, is_error)
      VALUES
        ('tool-a', 'session-a', 'turn-a', 'pi', 'tool-a', 'bash', 4500, 4600, 0),
        ('tool-b', 'session-b', 'turn-b', 'pi', 'tool-b', 'bash', 4500, 4600, 0);

      UPDATE sessions SET ended_at = NULL, started_at = 1000;
    `);
    db.close();

    const repair = repairDoctorFindings(dbPath, true);
    const verifyDb = new Database(dbPath);
    const messages = /** @type {{ n: number }} */ (
      verifyDb.prepare("SELECT COUNT(*) AS n FROM llm_messages").get()
    );
    const tools = /** @type {{ n: number }} */ (
      verifyDb.prepare("SELECT COUNT(*) AS n FROM tool_calls").get()
    );
    const openSessions = /** @type {{ n: number }} */ (
      verifyDb.prepare("SELECT COUNT(*) AS n FROM sessions WHERE ended_at IS NULL").get()
    );
    verifyDb.close();

    assert.equal(repair.status, "ok");
    assert.equal(repair.applied, true);
    assert.equal(messages.n, 1);
    assert.equal(tools.n, 1);
    assert.equal(openSessions.n, 0);
  });
});
