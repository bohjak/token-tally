// @ts-check
/**
 * Tests: Pi session log importer
 *
 * Covers:
 *   - Parser: ISO timestamps, unknown event types, malformed lines
 *   - Transformer: turn segmentation, float-drift micros, zero-cost skip,
 *     error stop-reason skip, noid synthetic key, tool-call pairing
 *   - Discovery: flat parents + nested subagents, UTC date boundaries
 *   - Fork/replay dedup: first-occurrence-wins on responseId
 *   - Boundary dedup: token-quadruple match (not timestamp equality)
 *   - Boundary tool-call: existing tool calls not re-written
 *   - Idempotency: import twice → identical row counts + attribution
 *   - CHECK constraints exercised against the real schema
 */

"use strict";

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { join, resolve } = require("node:path");
const Database = require("better-sqlite3");
const {
  parsePiSessionFile,
  transformSessionEvents,
  discoverPiSessions,
  isInDateRange,
  dollarToMicros,
  importPiSessionLogs,
} = require("../dist/src/index");
const { makeTempDir, openDb, countRows } = require("./helpers");

// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------

const FIXTURES = join(__dirname, "fixtures");
const F = {
  simple: join(FIXTURES, "pi-session-simple.jsonl"),
  aborted: join(FIXTURES, "pi-session-aborted.jsonl"),
  noidNonzero: join(FIXTURES, "pi-session-noid-nonzero.jsonl"),
  malformed: join(FIXTURES, "pi-session-malformed.jsonl"),
  forkA: join(FIXTURES, "pi-session-fork-a.jsonl"),
  forkB: join(FIXTURES, "pi-session-fork-b.jsonl"),
  tools: join(FIXTURES, "pi-session-tools.jsonl"),
  discoveryRoot: join(FIXTURES, "pi-sessions-root"),
};

// ---------------------------------------------------------------------------
// Parser tests
// ---------------------------------------------------------------------------

describe("pi-session parser", () => {
  test("parses a well-formed file without errors", () => {
    const result = parsePiSessionFile(F.simple);
    assert.equal(result.errors.length, 0, "should have no parse errors");
    // session + 2 user messages + 2 assistant messages
    assert.ok(result.events.length >= 4, "should have at least 4 events");
  });

  test("outer timestamps are ISO-8601 strings (not numbers)", () => {
    const result = parsePiSessionFile(F.simple);
    for (const event of result.events) {
      assert.equal(
        typeof event.timestamp,
        "string",
        `event.timestamp should be a string, got ${typeof event.timestamp}`,
      );
      // Verify it's a parseable ISO timestamp.
      const ms = Date.parse(event.timestamp);
      assert.ok(!isNaN(ms), `timestamp '${event.timestamp}' must be parseable`);
    }
  });

  test("unknown event types are included in events (not errors)", () => {
    const result = parsePiSessionFile(F.malformed);
    // "unknown_future_event" should be in events, not errors.
    const unknownEvents = result.events.filter((e) => e.type === "unknown_future_event");
    assert.equal(unknownEvents.length, 1, "unknown event type should be included");
  });

  test("malformed line produces ParseError with line number, no throw", () => {
    const result = parsePiSessionFile(F.malformed);
    // Should have parse errors for the invalid JSON line + missing-type line.
    assert.ok(result.errors.length >= 1, "should have at least one parse error");
    // Check that line numbers are set.
    for (const err of result.errors) {
      assert.ok(err.line > 0, `line number should be > 0, got ${err.line}`);
      assert.ok(typeof err.reason === "string", "reason should be a string");
    }
    // Non-malformed lines should still parse.
    const validEvents = result.events.filter((e) => e.type === "message" || e.type === "session");
    assert.ok(validEvents.length >= 2, "valid events should still be parsed");
  });

  test("unreadable file produces a line-0 error, not a throw", () => {
    const result = parsePiSessionFile("/nonexistent/path/session.jsonl");
    assert.equal(result.events.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].line, 0);
  });
});

// ---------------------------------------------------------------------------
// Transformer tests
// ---------------------------------------------------------------------------

describe("pi-session transformer", () => {
  test("dollarToMicros rounds per-component correctly (float drift test)", () => {
    // The total 0.052305000000000004 rounds differently from component sum.
    // Component sum: round(0.0003*1e6) + round(0.00375*1e6) + round(0*1e6) + round(0.0633*1e6)
    //              = 300 + 3750 + 0 + 63300 = 67350
    // Independent round(0.0673*1e6) = round(67300) = 67300 (different!)
    const input  = dollarToMicros(0.0003);
    const output = dollarToMicros(0.00375);
    const read   = dollarToMicros(0);
    const write  = dollarToMicros(0.0633);
    const sum    = input + output + read + write;
    const independentTotal = dollarToMicros(0.0673);
    // Verify the sum matches the component-wise approach.
    assert.equal(input, 300);
    assert.equal(output, 3750);
    assert.equal(write, 63300);
    assert.equal(sum, 67350);
    // Independent rounding of total gives a different (wrong) result.
    assert.equal(independentTotal, 67300);
    assert.notEqual(sum, independentTotal, "float drift: sum != independent total");
  });

  test("zero-cost aborted message gets isZeroCostSkip=true", () => {
    const parsed = parsePiSessionFile(F.aborted);
    const session = transformSessionEvents(F.aborted, parsed.events);
    const allMsgs = session.turns.flatMap((t) => t.messages);
    const abortedMsg = allMsgs.find(
      (m) => m.harnessMessageId.includes("noid") &&
             m.harnessMessageId.includes("msg-aborted"),
    );
    assert.ok(abortedMsg != null, "should have a noid aborted message");
    assert.equal(abortedMsg.isZeroCostSkip, true, "aborted message should be zero-cost-skip");
  });

  test("zero-cost error stop-reason gets isZeroCostSkip=true", () => {
    const parsed = parsePiSessionFile(F.aborted);
    const session = transformSessionEvents(F.aborted, parsed.events);
    const allMsgs = session.turns.flatMap((t) => t.messages);
    const errorMsg = allMsgs.find(
      (m) => m.harnessMessageId.includes("noid") &&
             m.harnessMessageId.includes("msg-error"),
    );
    assert.ok(errorMsg != null, "should have a noid error message");
    assert.equal(errorMsg.isZeroCostSkip, true, "error stop-reason should be zero-cost-skip");
  });

  test("nonzero-cost no-responseId message uses :noid: synthetic key", () => {
    const parsed = parsePiSessionFile(F.noidNonzero);
    const session = transformSessionEvents(F.noidNonzero, parsed.events);
    const allMsgs = session.turns.flatMap((t) => t.messages);
    const noidMsg = allMsgs.find((m) => m.harnessMessageId.includes(":noid:"));
    assert.ok(noidMsg != null, "should have a :noid: message");
    assert.equal(noidMsg.isZeroCostSkip, false, "nonzero cost should not be zero-cost-skip");
    assert.ok(
      noidMsg.harnessMessageId.includes(":noid:noid-nonzero-01"),
      `expected :noid: key, got ${noidMsg.harnessMessageId}`,
    );
    assert.ok(noidMsg.costTotalMicros > 0, "cost should be nonzero");
  });

  test("turn segmentation: new turn at each non-toolResult user message", () => {
    const parsed = parsePiSessionFile(F.simple);
    const session = transformSessionEvents(F.simple, parsed.events);
    // simple fixture has: user1 → assistant1 → user2 → assistant2
    assert.equal(session.turns.length, 2, "should have 2 turns");
    assert.equal(session.turns[0].messages.length, 1, "turn 0 should have 1 message");
    assert.equal(session.turns[1].messages.length, 1, "turn 1 should have 1 message");
    assert.equal(session.turns[0].harnessTurnId, `${F.simple}:t0`);
    assert.equal(session.turns[1].harnessTurnId, `${F.simple}:t1`);
  });

  test("tool call is paired with toolResult (endedAtMs set)", () => {
    const parsed = parsePiSessionFile(F.tools);
    const session = transformSessionEvents(F.tools, parsed.events);
    const allMsgs = session.turns.flatMap((t) => t.messages);
    const msgWithTool = allMsgs.find((m) => m.toolCalls.length > 0);
    assert.ok(msgWithTool != null, "should have a message with tool calls");
    assert.equal(msgWithTool.toolCalls.length, 1);
    const tc = msgWithTool.toolCalls[0];
    assert.equal(tc.harnessToolCallId, "call_bash_001");
    assert.equal(tc.toolName, "bash");
    assert.ok(tc.endedAtMs != null, "endedAtMs should be set from toolResult");
    assert.ok(tc.startedAtMs < tc.endedAtMs, "startedAt should be before endedAt");
  });

  test("costSource = harness when costTotalMicros > 0", () => {
    const parsed = parsePiSessionFile(F.simple);
    const session = transformSessionEvents(F.simple, parsed.events);
    const msgs = session.turns.flatMap((t) => t.messages).filter((m) => !m.isZeroCostSkip);
    assert.ok(msgs.length > 0, "should have imported messages");
    for (const m of msgs) {
      assert.equal(m.costSource, "harness", "positive cost → costSource=harness");
    }
  });

  test("costTotalMicros = sum of component micros (CHECK constraint compatible)", () => {
    const parsed = parsePiSessionFile(F.simple);
    const session = transformSessionEvents(F.simple, parsed.events);
    for (const turn of session.turns) {
      for (const msg of turn.messages) {
        if (msg.isZeroCostSkip) continue;
        const expectedTotal =
          msg.costInputMicros +
          msg.costOutputMicros +
          msg.costCacheReadMicros +
          msg.costCacheWriteMicros;
        assert.equal(
          msg.costTotalMicros,
          expectedTotal,
          "costTotalMicros must be sum of components",
        );
      }
    }
  });

  test("deterministic keys: no Date.now() — identical re-runs produce identical keys", () => {
    const parsed = parsePiSessionFile(F.simple);
    const s1 = transformSessionEvents(F.simple, parsed.events);
    const s2 = transformSessionEvents(F.simple, parsed.events);
    // Compare harnessTurnIds and harnessMessageIds.
    for (let i = 0; i < s1.turns.length; i++) {
      assert.equal(s1.turns[i].harnessTurnId, s2.turns[i].harnessTurnId);
      for (let j = 0; j < s1.turns[i].messages.length; j++) {
        assert.equal(
          s1.turns[i].messages[j].harnessMessageId,
          s2.turns[i].messages[j].harnessMessageId,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Discovery tests
// ---------------------------------------------------------------------------

describe("pi-session discovery", () => {
  test("discovers flat parent .jsonl files", () => {
    const files = discoverPiSessions(F.discoveryRoot);
    const parents = files.filter((f) => !f.isSubagent);
    assert.ok(parents.length >= 2, "should find at least 2 parent files");
  });

  test("discovers nested subagent session.jsonl files", () => {
    const files = discoverPiSessions(F.discoveryRoot);
    const subagents = files.filter((f) => f.isSubagent);
    assert.equal(subagents.length, 1, "should find exactly 1 subagent file");
    assert.ok(
      subagents[0].filePath.endsWith("session.jsonl"),
      "subagent should be a session.jsonl file",
    );
  });

  test("files are sorted by sessionStartIso ascending", () => {
    const files = discoverPiSessions(F.discoveryRoot);
    for (let i = 1; i < files.length; i++) {
      assert.ok(
        files[i - 1].sessionStartIso <= files[i].sessionStartIso,
        `file[${i - 1}] (${files[i - 1].sessionStartIso}) should be <= file[${i}] (${files[i].sessionStartIso})`,
      );
    }
  });

  test("isInDateRange: --to is exclusive", () => {
    // Session starting at 2026-06-10T16:00:00 is excluded by --to 2026-06-10
    // because 2026-06-10T16:00:00 >= 2026-06-10T00:00:00Z.
    assert.equal(
      isInDateRange("2026-06-10T16:00:00.000Z", undefined, "2026-06-10"),
      false,
      "session on --to date should be excluded",
    );
    assert.equal(
      isInDateRange("2026-06-10T16:00:00.000Z", undefined, "2026-06-11"),
      true,
      "session before --to date should be included",
    );
  });

  test("UTC date filter excludes sessions outside range", () => {
    const files = discoverPiSessions(F.discoveryRoot, {
      from: "2026-06-09",
      to: "2026-06-10",
    });
    // The 2026-06-10T16: file should be excluded by --to 2026-06-10.
    const outside = files.filter((f) =>
      f.filePath.includes("2026-06-10T16"),
    );
    assert.equal(outside.length, 0, "session on --to date boundary should be excluded");
    // The 2026-06-09 files should be included.
    const inside = files.filter((f) => f.sessionStartIso.startsWith("2026-06-09"));
    assert.ok(inside.length >= 2, "2026-06-09 sessions should be included");
  });

  test("returns empty array for nonexistent sessions root", () => {
    const files = discoverPiSessions("/nonexistent/path/sessions");
    assert.equal(files.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Integration / import tests
// ---------------------------------------------------------------------------

describe("pi-session importer integration", () => {
  /** @type {{ dir: string; cleanup: () => void }} */
  let tmp;

  before(() => {
    tmp = makeTempDir();
  });

  after(() => {
    tmp.cleanup();
  });

  test("basic import: sessions + turns + messages + tool_calls are written", async () => {
    const dbPath = join(tmp.dir, "import-basic.db");
    const result = await importPiSessionLogs({
      sessionsPath: F.discoveryRoot,
      dbPath,
      from: "2026-06-09",
      to: "2026-06-10",
    });
    assert.ok(result.ok, `import failed: ${result.ok ? "" : result.error}`);
    if (!result.ok) return;
    const db = openDb(dbPath);
    assert.equal(countRows(db, "sessions"), 2, "should have 2 sessions (parent + subagent)");
    assert.ok(countRows(db, "turns") >= 2, "should have at least 2 turns");
    assert.ok(countRows(db, "llm_messages") >= 2, "should have at least 2 messages");
    db.close();
  });

  test("accounting identity: imported + skipped classes = total", async () => {
    const dbPath = join(tmp.dir, "import-identity.db");
    const result = await importPiSessionLogs({
      sessionsPath: F.discoveryRoot,
      dbPath,
      from: "2026-06-09",
      to: "2026-06-11",
    });
    assert.ok(result.ok);
    if (!result.ok) return;
    const t = result.result.totals;
    const identityLHS =
      t.imported + t.replaysSkipped + t.zeroCostSkipped + t.boundarySkipped + t.cutoffSkipped;
    assert.equal(
      identityLHS,
      t.totalParsedAssistantUsage,
      `accounting identity failed: ${identityLHS} != ${t.totalParsedAssistantUsage}`,
    );
  });

  test("idempotency: second import run produces no new rows", async () => {
    const dbPath = join(tmp.dir, "import-idem.db");
    const opts = { sessionsPath: F.discoveryRoot, dbPath, from: "2026-06-09", to: "2026-06-10" };
    const run1 = await importPiSessionLogs(opts);
    assert.ok(run1.ok);

    const run2 = await importPiSessionLogs(opts);
    assert.ok(run2.ok);
    if (!run2.ok) return;

    // On the second run, no new messages should be imported.
    // (They are caught by UNIQUE constraint + INSERT OR IGNORE, or by boundary dedup.)
    const db = openDb(dbPath);
    const countAfterRun1 = countRows(db, "llm_messages");
    db.close();

    // Run 3 to confirm stable.
    const run3 = await importPiSessionLogs(opts);
    assert.ok(run3.ok);
    if (!run3.ok) return;
    const db2 = openDb(dbPath);
    const countAfterRun3 = countRows(db2, "llm_messages");
    db2.close();

    assert.equal(countAfterRun1, countAfterRun3, "row count must be stable on repeat runs");
  });

  test("dry-run does not write any rows", async () => {
    const dbPath = join(tmp.dir, "import-dry-run.db");
    const result = await importPiSessionLogs({
      sessionsPath: F.discoveryRoot,
      dbPath,
      from: "2026-06-09",
      to: "2026-06-10",
      dryRun: true,
    });
    assert.ok(result.ok);
    // DB should not exist or have no rows.
    const dbExists = require("node:fs").existsSync(dbPath);
    if (dbExists) {
      const db = openDb(dbPath);
      const msgCount = countRows(db, "llm_messages");
      db.close();
      assert.equal(msgCount, 0, "dry-run should not write any messages");
    } else {
      // DB was never created — that's fine too.
      assert.ok(true, "DB not created in dry-run mode");
    }
  });

  test("dry-run counts importable tool calls without self-marking them as seen", async () => {
    const { mkdirSync, copyFileSync } = require("node:fs");
    const root = join(tmp.dir, "dry-run-tools", "myproject");
    mkdirSync(root, { recursive: true });
    copyFileSync(F.tools, join(root, "2026-06-09T15:00:00.000Z_tools.jsonl"));

    const result = await importPiSessionLogs({
      sessionsPath: join(tmp.dir, "dry-run-tools"),
      dbPath: join(tmp.dir, "dry-run-tools.db"),
      dryRun: true,
    });

    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.result.totals.imported, 2, "dry-run should project both messages");
    assert.equal(result.result.sessions[0].counts.toolCallsImported, 1, "dry-run should project the tool call");
  });

  test("fork/replay dedup: responseId first-occurrence wins regardless of run order", async () => {
    // Both fork-a and fork-b share resp_shared_replay_01.
    // The message should appear exactly once, attributed to fork-a (earlier).
    const dbPath = join(tmp.dir, "import-fork-replay.db");

    // Create a temp sessions-root with both fork files.
    const { mkdirSync, copyFileSync } = require("node:fs");
    const forkRoot = join(tmp.dir, "fork-sessions", "myproject");
    mkdirSync(forkRoot, { recursive: true });
    // fork-a starts at 14:40, fork-b starts at 14:50 — sorted by time, fork-a first.
    copyFileSync(F.forkA, join(forkRoot, "2026-06-09T14:40:00.000Z_fork-a.jsonl"));
    copyFileSync(F.forkB, join(forkRoot, "2026-06-09T14:50:00.000Z_fork-b.jsonl"));

    const result = await importPiSessionLogs({
      sessionsPath: join(tmp.dir, "fork-sessions"),
      dbPath,
    });
    assert.ok(result.ok, `import failed: ${result.ok ? "" : result.error}`);
    if (!result.ok) return;

    // resp_shared_replay_01 should appear exactly once.
    const db = openDb(dbPath);
    const sharedRows = /** @type {any[]} */ (
      db.prepare("SELECT * FROM llm_messages WHERE harness_message_id = ?")
        .all("resp_shared_replay_01")
    );
    db.close();
    assert.equal(sharedRows.length, 1, "shared responseId should appear exactly once");

    // Check that the replay was counted.
    const forkBResult = result.result.sessions.find((s) =>
      s.filePath.includes("fork-b"),
    );
    assert.ok(forkBResult != null, "fork-b session should be in results");
    assert.equal(
      forkBResult.counts.messagesReplaySkipped,
      1,
      "fork-b should report 1 replay_skipped",
    );
  });

  test("boundary-skipped responseId prevents later fork replay import", async () => {
    const dbPath = join(tmp.dir, "import-boundary-replay.db");
    const { mkdirSync, copyFileSync } = require("node:fs");
    const root = join(tmp.dir, "boundary-replay-sessions", "myproject");
    mkdirSync(root, { recursive: true });
    const forkAPath = join(root, "2026-06-09T14:40:00.000Z_fork-a.jsonl");
    const forkBPath = join(root, "2026-06-09T14:50:00.000Z_fork-b.jsonl");
    copyFileSync(F.forkA, forkAPath);
    copyFileSync(F.forkB, forkBPath);

    const { AnalyticsWriter } = require("../dist/src/index");
    const setupWriter = await AnalyticsWriter.open({ dbPath, harnessName: "token-tally-import" });
    await setupWriter.close();

    const db = openDb(dbPath);
    db.prepare(
      "INSERT OR IGNORE INTO harnesses (name, display_name, first_seen_at, last_seen_at) VALUES ('pi', 'Pi', ?, ?)",
    ).run(Date.now(), Date.now());
    const sessionId = require("crypto").randomUUID();
    const turnId = require("crypto").randomUUID();
    db.prepare(
      `INSERT INTO sessions (id, harness_id, harness_session_id, session_file, cwd, started_at)
       VALUES (?, 'pi', ?, ?, ?, ?)`,
    ).run(sessionId, forkAPath, forkAPath, "/home/user/projects/myproject", 1749472800000);
    db.prepare(
      `INSERT INTO turns (id, session_id, harness_id, harness_turn_id, turn_index, started_at)
       VALUES (?, ?, 'pi', ?, 0, ?)`,
    ).run(turnId, sessionId, `${forkAPath}:t0`, 1749472801000);
    db.prepare(
      `INSERT INTO llm_messages (
         id, session_id, turn_id, harness_id, harness_message_id, ts,
         provider, model_id,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         cost_input_micros, cost_output_micros, cost_cache_read_micros, cost_cache_write_micros,
         cost_total_micros, cost_currency, cost_source
       ) VALUES (?, ?, ?, 'pi', ?, ?, 'anthropic', 'claude-opus-4-8',
                 100, 50, 0, 0,
                 300, 3750, 0, 0,
                 4050, 'USD', 'harness')`,
    ).run(require("crypto").randomUUID(), sessionId, turnId, `${forkAPath}:t0:m0`, 1749472815000);
    db.close();

    const result = await importPiSessionLogs({
      sessionsPath: join(tmp.dir, "boundary-replay-sessions"),
      dbPath,
    });
    assert.ok(result.ok, `import failed: ${result.ok ? "" : result.error}`);
    if (!result.ok) return;

    // The pre-existing synthesized live-writer row is canonicalized to the
    // provider responseId in place — exactly one row, same session attribution.
    const db2 = openDb(dbPath);
    const importedShared = /** @type {any[]} */ (
      db2.prepare("SELECT id, session_id FROM llm_messages WHERE harness_message_id = ?")
        .all("resp_shared_replay_01")
    );
    const synthesizedRows = /** @type {any[]} */ (
      db2.prepare("SELECT id FROM llm_messages WHERE harness_message_id = ?")
        .all(`${forkAPath}:t0:m0`)
    );
    db2.close();
    assert.equal(importedShared.length, 1, "shared boundary responseId should map to exactly one row");
    assert.equal(importedShared[0].session_id, sessionId, "canonicalized row keeps live-writer attribution");
    assert.equal(synthesizedRows.length, 0, "synthesized ID should be upgraded in place");

    const forkAResult = result.result.sessions.find((s) => s.filePath.endsWith("fork-a.jsonl"));
    const forkBResult = result.result.sessions.find((s) => s.filePath.endsWith("fork-b.jsonl"));
    assert.ok(forkAResult != null);
    assert.ok(forkBResult != null);
    assert.equal(forkAResult.counts.messagesBoundarySkipped, 1, "fork-a shared row should boundary-skip");
    assert.equal(forkAResult.counts.messagesIdCanonicalized, 1, "fork-a synthesized row should be canonicalized");
    assert.equal(forkBResult.counts.messagesReplaySkipped, 1, "fork-b shared row should replay-skip");
  });

  test("pre-window first occurrence seeds replay dedup for in-window forks", async () => {
    const dbPath = join(tmp.dir, "import-prewindow-replay.db");
    const { mkdirSync, copyFileSync, readFileSync, writeFileSync } = require("node:fs");
    const root = join(tmp.dir, "prewindow-replay-sessions", "myproject");
    mkdirSync(root, { recursive: true });
    const preWindowPath = join(root, "2026-06-08T14:40:00.000Z_fork-a.jsonl");
    const inWindowPath = join(root, "2026-06-09T14:50:00.000Z_fork-b.jsonl");
    const preWindowContent = readFileSync(F.forkA, "utf8")
      .replace('"timestamp":"2026-06-09T14:40:00.000Z"', '"timestamp":"2026-06-08T14:40:00.000Z"');
    writeFileSync(preWindowPath, preWindowContent);
    copyFileSync(F.forkB, inWindowPath);

    const result = await importPiSessionLogs({
      sessionsPath: join(tmp.dir, "prewindow-replay-sessions"),
      dbPath,
      from: "2026-06-09",
      to: "2026-06-10",
    });
    assert.ok(result.ok, `import failed: ${result.ok ? "" : result.error}`);
    if (!result.ok) return;

    assert.equal(result.result.sessions.length, 1, "only in-window session should be imported");
    assert.ok(result.result.sessions[0].filePath.endsWith("fork-b.jsonl"));
    assert.equal(result.result.sessions[0].counts.messagesReplaySkipped, 1);

    const db = openDb(dbPath);
    const sharedRows = /** @type {any[]} */ (
      db.prepare("SELECT id FROM llm_messages WHERE harness_message_id = ?")
        .all("resp_shared_replay_01")
    );
    db.close();
    assert.equal(sharedRows.length, 0, "pre-window replayed responseId should not be imported");
  });

  test("boundary dedup: token-quadruple match (NOT timestamp equality)", async () => {
    // Seed a DB with an existing session + message row that has a DIFFERENT
    // ts value than what the log file reports (simulates live writer hook time).
    const dbPath = join(tmp.dir, "import-boundary.db");

    // Determine the copy path FIRST, so we can seed the DB with the correct key.
    const { mkdirSync: mkdirSync2, copyFileSync: copyFileSync2 } = require("node:fs");
    const bdRoot = join(tmp.dir, "boundary-sessions", "myproject");
    mkdirSync2(bdRoot, { recursive: true });
    const copyPath = join(bdRoot, "2026-06-09T14:05:17.405Z_simpletest.jsonl");
    copyFileSync2(F.simple, copyPath);

    // Use AnalyticsWriter.open() to create and migrate the DB schema.
    const { AnalyticsWriter } = require("../dist/src/index");
    const setupWriter = await AnalyticsWriter.open({ dbPath, harnessName: "token-tally-import" });
    await setupWriter.close();

    // Manually insert a session + message that matches the simple fixture content
    // but with a ts value 5 seconds later (simulating live writer hook time).
    // The harnessSessionId MUST match the copy's absolute path (the importer key).
    const db = openDb(dbPath);
    // Insert the harness row if not present.
    const harnessExists = db.prepare("SELECT name FROM harnesses WHERE name='pi'").get();
    if (harnessExists == null) {
      db.prepare(
        "INSERT INTO harnesses (name, display_name, first_seen_at, last_seen_at) VALUES ('pi', 'Pi', ?, ?)",
      ).run(Date.now(), Date.now());
    }
    const sessionId = require("crypto").randomUUID();
    // Use copyPath as harnessSessionId — this is what the importer will use.
    db.prepare(
      `INSERT INTO sessions (id, harness_id, harness_session_id, session_file, cwd, started_at)
       VALUES (?, 'pi', ?, ?, ?, ?)`,
    ).run(sessionId, copyPath, copyPath, "/home/user/projects/myproject", 1749470737000);

    // Turn row
    const turnId = require("crypto").randomUUID();
    db.prepare(
      `INSERT INTO turns (id, session_id, harness_id, harness_turn_id, turn_index, started_at)
       VALUES (?, ?, 'pi', ?, 0, ?)`,
    ).run(turnId, sessionId, `${copyPath}:t0`, 1749470737000);

    // Message row: matching tokens/cost but ts is +5000ms (live writer hook time).
    // From pi-session-simple.jsonl first assistant message:
    //   input:100, output:50, cacheRead:0, cacheWrite:16880
    //   cost.input:0.0003 → 300 micros
    //   cost.output:0.00375 → 3750 micros
    //   cost.cacheWrite:0.0633 → 63300 micros
    //   sum: 67350 micros
    db.prepare(
      `INSERT INTO llm_messages (
         id, session_id, turn_id, harness_id, harness_message_id, ts,
         provider, model_id,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         cost_input_micros, cost_output_micros, cost_cache_read_micros, cost_cache_write_micros,
         cost_total_micros, cost_currency, cost_source
       ) VALUES (?, ?, ?, 'pi', ?, ?, 'anthropic', 'claude-opus-4-8',
                 100, 50, 0, 16880,
                 300, 3750, 0, 63300,
                 67350, 'USD', 'harness')`,
    ).run(
      require("crypto").randomUUID(),
      sessionId,
      turnId,
      "LIVE_WRITER_resp_simpletest01",  // different harness_message_id (live writer key)
      1749470737000 + 5000,             // +5s: live writer stamp vs log message start
    );
    db.close();

    const result = await importPiSessionLogs({
      sessionsPath: join(tmp.dir, "boundary-sessions"),
      dbPath,
    });
    assert.ok(result.ok, `import failed: ${result.ok ? "" : result.error}`);
    if (!result.ok) return;

    const simpleResult = result.result.sessions.find((s) =>
      s.filePath.endsWith("simpletest.jsonl"),
    );
    assert.ok(simpleResult != null, "simple session should be in results");
    // First message (resp_simpletest01, matching token quadruple) → boundary_skipped.
    assert.ok(
      simpleResult.counts.messagesBoundarySkipped >= 1,
      `expected at least 1 boundary_skipped, got ${simpleResult.counts.messagesBoundarySkipped}`,
    );

    // Verify the existing live-writer row was NOT re-pointed.
    const db2 = openDb(dbPath);
    const liveRow = /** @type {any} */ (
      db2.prepare(
        "SELECT session_id, turn_id FROM llm_messages WHERE harness_message_id = ?",
      ).get("LIVE_WRITER_resp_simpletest01")
    );
    db2.close();
    assert.ok(liveRow != null, "live writer row should still exist");
    assert.equal(liveRow.session_id, sessionId, "live writer row session_id must not change");
    assert.equal(liveRow.turn_id, turnId, "live writer row turn_id must not change");
  });

  test("boundary match canonicalizes synthesized live-writer IDs to the provider responseId", async () => {
    const dbPath = join(tmp.dir, "import-canonicalize.db");
    const { mkdirSync, copyFileSync } = require("node:fs");
    const root = join(tmp.dir, "canonicalize-sessions", "myproject");
    mkdirSync(root, { recursive: true });
    const copyPath = join(root, "2026-06-09T14:05:17.405Z_simpletest.jsonl");
    copyFileSync(F.simple, copyPath);

    const { AnalyticsWriter } = require("../dist/src/index");
    const setupWriter = await AnalyticsWriter.open({ dbPath, harnessName: "token-tally-import" });
    await setupWriter.close();

    // Seed a synthesized live-writer row matching the first fixture message
    // (payload identical, ts +7s like the live writer hook stamp).
    const db = openDb(dbPath);
    db.prepare(
      "INSERT OR IGNORE INTO harnesses (name, display_name, first_seen_at, last_seen_at) VALUES ('pi', 'Pi', ?, ?)",
    ).run(Date.now(), Date.now());
    const sessionId = require("crypto").randomUUID();
    const turnId = require("crypto").randomUUID();
    const liveRowId = require("crypto").randomUUID();
    db.prepare(
      `INSERT INTO sessions (id, harness_id, harness_session_id, session_file, cwd, started_at)
       VALUES (?, 'pi', ?, ?, ?, ?)`,
    ).run(sessionId, copyPath, copyPath, "/home/user/projects/myproject", 1749470737000);
    db.prepare(
      `INSERT INTO turns (id, session_id, harness_id, harness_turn_id, turn_index, started_at)
       VALUES (?, ?, 'pi', ?, 0, ?)`,
    ).run(turnId, sessionId, `${copyPath}:t0`, 1749470737000);
    db.prepare(
      `INSERT INTO llm_messages (
         id, session_id, turn_id, harness_id, harness_message_id, ts,
         provider, model_id,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         cost_input_micros, cost_output_micros, cost_cache_read_micros, cost_cache_write_micros,
         cost_total_micros, cost_currency, cost_source
       ) VALUES (?, ?, ?, 'pi', ?, ?, 'anthropic', 'claude-opus-4-8',
                 100, 50, 0, 16880,
                 300, 3750, 0, 63300,
                 67350, 'USD', 'harness')`,
    ).run(liveRowId, sessionId, turnId, `${copyPath}:t0:m0`, 1749470737000 + 7000);
    db.close();

    // Dry-run first: reports the would-be canonicalization without writing.
    const dryRun = await importPiSessionLogs({
      sessionsPath: join(tmp.dir, "canonicalize-sessions"),
      dbPath,
      dryRun: true,
    });
    assert.ok(dryRun.ok, `dry-run failed: ${dryRun.ok ? "" : dryRun.error}`);
    if (!dryRun.ok) return;
    assert.equal(dryRun.result.totals.idCanonicalized, 1, "dry-run should report 1 would-be canonicalization");

    const dbAfterDry = openDb(dbPath);
    const dryRow = /** @type {any} */ (
      dbAfterDry.prepare("SELECT harness_message_id FROM llm_messages WHERE id = ?").get(liveRowId)
    );
    dbAfterDry.close();
    assert.equal(dryRow.harness_message_id, `${copyPath}:t0:m0`, "dry-run must not modify rows");

    // Real import: upgrades the synthesized ID in place.
    const result = await importPiSessionLogs({
      sessionsPath: join(tmp.dir, "canonicalize-sessions"),
      dbPath,
    });
    assert.ok(result.ok, `import failed: ${result.ok ? "" : result.error}`);
    if (!result.ok) return;

    assert.equal(result.result.totals.idCanonicalized, 1);
    assert.equal(result.result.totals.boundarySkipped, 1);

    const db2 = openDb(dbPath);
    const row = /** @type {any} */ (
      db2.prepare(
        "SELECT harness_message_id, session_id, turn_id FROM llm_messages WHERE id = ?",
      ).get(liveRowId)
    );
    const allIds = /** @type {any[]} */ (
      db2.prepare("SELECT harness_message_id FROM llm_messages ORDER BY ts").all()
    );
    db2.close();

    assert.equal(row.harness_message_id, "resp_simpletest01", "synthesized ID upgraded to responseId");
    assert.equal(row.session_id, sessionId, "canonicalized row keeps session attribution");
    assert.equal(row.turn_id, turnId, "canonicalized row keeps turn attribution");
    // Second fixture message imported normally; exactly two rows, no duplicates.
    assert.deepEqual(
      allIds.map((r) => r.harness_message_id).sort(),
      ["resp_simpletest01", "resp_simpletest02"],
    );
  });

  test("boundary tool-call: tool calls in skipped messages are not inserted", async () => {
    // Seed a session with a tool call row already in DB.
    const dbPath = join(tmp.dir, "import-tc-boundary.db");

    // Use AnalyticsWriter.open() to create and migrate the DB schema.
    const { AnalyticsWriter } = require("../dist/src/index");
    const setupWriter2 = await AnalyticsWriter.open({ dbPath, harnessName: "token-tally-import" });
    await setupWriter2.close();

    const db = openDb(dbPath);
    const harnessExists = db.prepare("SELECT name FROM harnesses WHERE name='pi'").get();
    if (harnessExists == null) {
      db.prepare(
        "INSERT INTO harnesses (name, display_name, first_seen_at, last_seen_at) VALUES ('pi', 'Pi', ?, ?)",
      ).run(Date.now(), Date.now());
    }

    // Create the copy first so we know the path to use as the session key.
    const { mkdirSync: mk, copyFileSync: cp } = require("node:fs");
    const tcRoot = join(tmp.dir, "tc-sessions", "myproject");
    mk(tcRoot, { recursive: true });
    const toolsCopyPath = join(tcRoot, "2026-06-09T15:00:00.000Z_tooltest.jsonl");
    cp(F.tools, toolsCopyPath);

    const sessionId = require("crypto").randomUUID();
    // Use the copy path as harnessSessionId — this is what the importer will use.
    db.prepare(
      `INSERT INTO sessions (id, harness_id, harness_session_id, session_file, cwd, started_at)
       VALUES (?, 'pi', ?, ?, ?, ?)`,
    ).run(sessionId, toolsCopyPath, toolsCopyPath, "/home/user/projects/myproject", 1749474000000);

    const turnId = require("crypto").randomUUID();
    db.prepare(
      `INSERT INTO turns (id, session_id, harness_id, harness_turn_id, turn_index, started_at)
       VALUES (?, ?, 'pi', ?, 0, ?)`,
    ).run(turnId, sessionId, `${toolsCopyPath}:t0`, 1749474010000);

    // Seed the message that matches the tools fixture resp_tools_01.
    // input:100, output:50, cacheRead:0, cacheWrite:0, cost sum: 300+3750+0+0=4050
    db.prepare(
      `INSERT INTO llm_messages (
         id, session_id, turn_id, harness_id, harness_message_id, ts,
         provider, model_id,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         cost_input_micros, cost_output_micros, cost_cache_read_micros, cost_cache_write_micros,
         cost_total_micros, cost_currency, cost_source
       ) VALUES (?, ?, ?, 'pi', ?, ?,
                 'anthropic', 'claude-opus-4-8',
                 100, 50, 0, 0, 300, 3750, 0, 0, 4050, 'USD', 'harness')`,
    ).run(
      require("crypto").randomUUID(),
      sessionId, turnId, "LIVE_resp_tools_01_key",
      1749474010000 + 3000,
    );

    // Seed the existing tool call row with known values.
    db.prepare(
      `INSERT INTO tool_calls
         (id, session_id, turn_id, harness_id, harness_tool_call_id, tool_name, started_at, is_error)
       VALUES (?, ?, ?, 'pi', ?, 'bash', ?, 0)`,
    ).run(
      require("crypto").randomUUID(),
      sessionId, turnId, "call_bash_001", 1749474010000,
    );
    db.close();

    const result = await importPiSessionLogs({
      sessionsPath: join(tmp.dir, "tc-sessions"),
      dbPath,
    });
    assert.ok(result.ok);
    if (!result.ok) return;

    // The tool call row should not have been re-inserted.
    const db2 = openDb(dbPath);
    const tcRows = /** @type {any[]} */ (
      db2.prepare(
        "SELECT * FROM tool_calls WHERE harness_tool_call_id = ? AND harness_id = 'pi'",
      ).all("call_bash_001")
    );
    db2.close();

    // Exactly one row should exist (the original seeded row).
    assert.equal(tcRows.length, 1, "tool call should appear exactly once");
    // The turn_id should not have changed (live writer values preserved).
    assert.equal(tcRows[0].turn_id, turnId, "tool call turn_id must not be re-pointed");
  });

  test("CHECK constraint satisfied: cost_total_micros = sum of breakdown columns", async () => {
    const dbPath = join(tmp.dir, "import-check.db");
    const { mkdirSync: mk2, copyFileSync: cp2 } = require("node:fs");
    const checkRoot = join(tmp.dir, "check-sessions", "myproject");
    mk2(checkRoot, { recursive: true });
    cp2(F.simple, join(checkRoot, "2026-06-09T14:05:17.405Z_checktest.jsonl"));

    await importPiSessionLogs({
      sessionsPath: join(tmp.dir, "check-sessions"),
      dbPath,
    });

    const db = openDb(dbPath);
    const rows = /** @type {Array<{cost_total_micros:number,cost_input_micros:number,cost_output_micros:number,cost_cache_read_micros:number,cost_cache_write_micros:number}>} */ (
      db.prepare(
        `SELECT cost_total_micros, cost_input_micros, cost_output_micros,
                cost_cache_read_micros, cost_cache_write_micros
         FROM llm_messages`,
      ).all()
    );
    db.close();

    assert.ok(rows.length > 0, "should have imported messages");
    for (const row of rows) {
      const expected =
        row.cost_input_micros +
        row.cost_output_micros +
        row.cost_cache_read_micros +
        row.cost_cache_write_micros;
      assert.equal(
        row.cost_total_micros,
        expected,
        "cost_total_micros must equal sum of breakdown columns",
      );
    }
  });

  test("--until cutoff: messages with tsMs >= untilMs are skipped", async () => {
    const dbPath = join(tmp.dir, "import-cutoff.db");
    const { mkdirSync: mk3, copyFileSync: cp3 } = require("node:fs");
    const cutoffRoot = join(tmp.dir, "cutoff-sessions", "myproject");
    mk3(cutoffRoot, { recursive: true });
    cp3(F.simple, join(cutoffRoot, "2026-06-09T14:05:17.405Z_cutofftest.jsonl"));

    // Set until to the inner timestamp of the first assistant message (1749470737000).
    // That message should be cutoff_skipped; the second message (1749470780000) too.
    const untilIso = new Date(1749470737000).toISOString();
    const result = await importPiSessionLogs({
      sessionsPath: join(tmp.dir, "cutoff-sessions"),
      dbPath,
      until: untilIso,
    });
    assert.ok(result.ok);
    if (!result.ok) return;

    const session = result.result.sessions.find((s) =>
      s.filePath.endsWith("cutofftest.jsonl"),
    );
    assert.ok(session != null);
    // Both messages have tsMs >= untilMs → both should be cutoff_skipped.
    assert.ok(
      session.counts.messagesCutoffSkipped >= 1,
      `expected cutoff_skipped >= 1, got ${session.counts.messagesCutoffSkipped}`,
    );
    assert.equal(session.counts.messagesImported, 0, "no messages should be imported");
  });
});
