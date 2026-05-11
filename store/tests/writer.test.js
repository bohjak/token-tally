// @ts-check
/**
 * Tests: AnalyticsWriter upsert semantics and idempotency
 *
 * Covers:
 *   - Harness, session, turn, message, subscription, tool-call upserts
 *   - Idempotency: replaying the same event produces exactly 1 row
 *   - cost_total_micros = sum of four breakdown columns (CHECK constraint)
 *   - Subscription linking (cost_source = subscription_covered)
 *   - Closed writer rejects further calls
 *   - recordHarness returns name as id
 */

"use strict";

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { join } = require("node:path");
const { AnalyticsWriter } = require("../dist/src/index");
const { makeTempDir, openDb, countRows, seedMinimalData } = require("./helpers");

describe("AnalyticsWriter — upserts and idempotency", () => {
  /** @type {{ dir: string; cleanup: () => void }} */
  let tmp;

  before(() => {
    tmp = makeTempDir();
  });

  after(() => {
    tmp.cleanup();
  });

  // Helper: fresh writer per test with isolated DB.
  /**
   * @param {string} name
   * @returns {Promise<{ writer: import("../dist/src/index").AnalyticsWriter; dbPath: string }>}
   */
  async function freshWriter(name) {
    const dbPath = join(tmp.dir, `${name}.db`);
    const spoolDir = join(tmp.dir, `${name}-spool`);
    const writer = await AnalyticsWriter.open({ dbPath, spoolDir, harnessName: "pi" });
    return { writer, dbPath };
  }

  // ---------------------------------------------------------------------------
  // Harness
  // ---------------------------------------------------------------------------

  test("recordHarness returns name as id", async () => {
    const { writer, dbPath } = await freshWriter("harness-id");

    const result = await writer.recordHarness({ name: "pi", displayName: "Pi" });
    await writer.close();

    assert.equal(result.id, "pi");
  });

  test("recordHarness is idempotent — second call produces 1 row", async () => {
    const { writer, dbPath } = await freshWriter("harness-idem");

    await writer.recordHarness({ name: "pi", displayName: "Pi", version: "1" });
    await writer.recordHarness({ name: "pi", displayName: "Pi", version: "2" });
    await writer.close();

    const db = openDb(dbPath);
    assert.equal(countRows(db, "harnesses"), 1);
    // version should be updated to the latest value
    const row = /** @type {{ version: string }} */ (
      db.prepare("SELECT version FROM harnesses WHERE name='pi'").get()
    );
    db.close();
    assert.equal(row.version, "2");
  });

  // ---------------------------------------------------------------------------
  // Session
  // ---------------------------------------------------------------------------

  test("recordSession is idempotent on same harnessSessionId", async () => {
    const { writer, dbPath } = await freshWriter("session-idem");
    await writer.recordHarness({ name: "pi", displayName: "Pi" });

    const p = { harnessId: "pi", harnessSessionId: "sess-1", startedAt: Date.now() };
    const r1 = await writer.recordSession(p);
    const r2 = await writer.recordSession(p);
    await writer.close();

    const db = openDb(dbPath);
    assert.equal(countRows(db, "sessions"), 1);
    db.close();

    // Both calls should return the same canonical UUID.
    assert.equal(r1.id, r2.id);
  });

  test("recordSession with different harnessSessionId creates two rows", async () => {
    const { writer, dbPath } = await freshWriter("session-two");
    await writer.recordHarness({ name: "pi", displayName: "Pi" });

    await writer.recordSession({ harnessId: "pi", harnessSessionId: "s1", startedAt: 1 });
    await writer.recordSession({ harnessId: "pi", harnessSessionId: "s2", startedAt: 2 });
    await writer.close();

    const db = openDb(dbPath);
    assert.equal(countRows(db, "sessions"), 2);
    db.close();
  });

  // ---------------------------------------------------------------------------
  // Turn
  // ---------------------------------------------------------------------------

  test("recordTurn is idempotent on same (session_id, harnessTurnId)", async () => {
    const { writer, dbPath } = await freshWriter("turn-idem");
    const { sessionId } = await seedMinimalData(writer);
    // The seed already recorded one turn. Record it again.
    const r1 = await writer.recordTurn({
      harnessId: "pi",
      sessionId,
      harnessTurnId: "turn-1",
      startedAt: Date.now(),
    });
    await writer.close();

    const db = openDb(dbPath);
    assert.equal(countRows(db, "turns"), 1);
    db.close();
  });

  // ---------------------------------------------------------------------------
  // LLM message
  // ---------------------------------------------------------------------------

  test("recordLlmMessage is idempotent on same (harness_id, harnessMessageId)", async () => {
    const { writer, dbPath } = await freshWriter("msg-idem");
    const { sessionId, turnId } = await seedMinimalData(writer);

    const payload = {
      harnessId: "pi",
      sessionId,
      turnId,
      harnessMessageId: "unique-msg-42",
      ts: Date.now(),
      inputTokens: 10,
      outputTokens: 5,
      costInputMicros: 1_000,
      costOutputMicros: 500,
      costSource: /** @type {const} */ ("writer"),
    };

    await writer.recordLlmMessage(payload);
    await writer.recordLlmMessage(payload);
    await writer.close();

    const db = openDb(dbPath);
    // There's already one from seedMinimalData; we added one more unique id.
    // Total should be 2.
    assert.equal(countRows(db, "llm_messages"), 2);
    db.close();
  });

  test("cost_total_micros equals sum of breakdown columns", async () => {
    const { writer, dbPath } = await freshWriter("cost-check");
    const { sessionId, turnId } = await seedMinimalData(writer);

    await writer.recordLlmMessage({
      harnessId: "pi",
      sessionId,
      turnId,
      harnessMessageId: "cost-msg-1",
      ts: Date.now(),
      inputTokens: 100,
      outputTokens: 50,
      costInputMicros: 1_500,
      costOutputMicros: 3_000,
      costCacheReadMicros: 200,
      costCacheWriteMicros: 300,
      costSource: "writer",
    });
    await writer.close();

    const db = openDb(dbPath);
    const row = /** @type {{ cost_total_micros: number; cost_input_micros: number; cost_output_micros: number; cost_cache_read_micros: number; cost_cache_write_micros: number }} */ (
      db.prepare(
        "SELECT cost_total_micros, cost_input_micros, cost_output_micros, cost_cache_read_micros, cost_cache_write_micros FROM llm_messages WHERE harness_message_id='cost-msg-1'"
      ).get()
    );
    db.close();

    const expectedTotal =
      row.cost_input_micros +
      row.cost_output_micros +
      row.cost_cache_read_micros +
      row.cost_cache_write_micros;

    assert.equal(
      row.cost_total_micros,
      expectedTotal,
      "cost_total_micros must equal sum of breakdown columns"
    );
    assert.equal(row.cost_total_micros, 5_000);
  });

  test("DB CHECK rejects a message with inconsistent cost_total_micros", async () => {
    const { writer, dbPath } = await freshWriter("cost-check-fail");
    const { sessionId, turnId } = await seedMinimalData(writer);
    await writer.close();

    // Attempt a direct insert with mismatched cost_total to verify the DB CHECK fires.
    const db = openDb(dbPath);
    assert.throws(() => {
      db.prepare(
        `INSERT INTO llm_messages
           (id, session_id, turn_id, harness_id, harness_message_id,
            ts, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
            cost_input_micros, cost_output_micros, cost_cache_read_micros, cost_cache_write_micros,
            cost_total_micros, cost_currency, cost_source)
         VALUES
           ('bad-id', ?, ?, 'pi', 'bad-msg',
            1000000, 0, 0, 0, 0,
            100, 200, 0, 0,
            999, 'USD', 'writer')`
      ).run(sessionId, turnId);
    }, "CHECK constraint should reject mismatched cost_total_micros");
    db.close();
  });

  // ---------------------------------------------------------------------------
  // Subscription
  // ---------------------------------------------------------------------------

  test("recordSubscription is idempotent on (harness_id, plan_name, period_start)", async () => {
    const { writer, dbPath } = await freshWriter("sub-idem");
    await writer.recordHarness({ name: "pi", displayName: "Pi" });

    const subPayload = {
      harnessId: "pi",
      planName: "claude-pro",
      periodStart: 1_700_000_000_000,
      periodEnd: 1_702_000_000_000,
      fixedCost: 20.0,
      quotaUsed: 100,
    };

    const r1 = await writer.recordSubscription(subPayload);
    const r2 = await writer.recordSubscription({ ...subPayload, quotaUsed: 200 });
    await writer.close();

    const db = openDb(dbPath);
    assert.equal(countRows(db, "subscriptions"), 1);
    const row = /** @type {{ quota_used: number }} */ (
      db.prepare("SELECT quota_used FROM subscriptions").get()
    );
    db.close();

    // Second upsert should update quota_used.
    assert.equal(row.quota_used, 200);
    assert.equal(r1.id, r2.id, "both calls should return the same id");
  });

  test("subscription-linked message has cost_source = subscription_covered", async () => {
    const { writer, dbPath } = await freshWriter("sub-link");
    const { sessionId, turnId } = await seedMinimalData(writer);

    const sub = await writer.recordSubscription({
      harnessId: "pi",
      planName: "claude-pro",
      periodStart: 1_700_000_000_000,
      periodEnd: 1_702_000_000_000,
      fixedCost: 20.0,
    });

    await writer.recordLlmMessage({
      harnessId: "pi",
      sessionId,
      turnId,
      harnessMessageId: "covered-msg",
      ts: Date.now(),
      inputTokens: 10,
      outputTokens: 5,
      costInputMicros: 1_000,
      costOutputMicros: 500,
      costSource: "subscription_covered",
      subscriptionId: sub.id,
    });

    await writer.close();

    const db = openDb(dbPath);
    const row = /** @type {{ cost_source: string; subscription_id: string }} */ (
      db.prepare(
        "SELECT cost_source, subscription_id FROM llm_messages WHERE harness_message_id='covered-msg'"
      ).get()
    );
    db.close();

    assert.equal(row.cost_source, "subscription_covered");
    assert.equal(row.subscription_id, sub.id);
  });

  // ---------------------------------------------------------------------------
  // Tool call
  // ---------------------------------------------------------------------------

  test("recordToolCall is idempotent on (harness_id, harnessToolCallId)", async () => {
    const { writer, dbPath } = await freshWriter("tool-idem");
    const { sessionId, turnId } = await seedMinimalData(writer);

    await writer.recordToolCall({
      harnessId: "pi",
      sessionId,
      turnId,
      harnessToolCallId: "tc-1",
      toolName: "read",
      startedAt: Date.now() - 1_000,
      isError: false,
    });
    await writer.recordToolCall({
      harnessId: "pi",
      sessionId,
      turnId,
      harnessToolCallId: "tc-1",
      toolName: "read",
      startedAt: Date.now() - 1_000,
      isError: true, // update to error on second write
    });
    await writer.close();

    const db = openDb(dbPath);
    assert.equal(countRows(db, "tool_calls"), 1);
    const row = /** @type {{ is_error: number }} */ (
      db.prepare("SELECT is_error FROM tool_calls WHERE harness_tool_call_id='tc-1'").get()
    );
    db.close();
    // is_error should be updated to 1 by the second upsert.
    assert.equal(row.is_error, 1);
  });

  // ---------------------------------------------------------------------------
  // Session upsert integrity (data-integrity regression tests)
  // ---------------------------------------------------------------------------

  test("recordSession close event with startedAt=0 does not clobber real started_at", async () => {
    const { writer, dbPath } = await freshWriter("session-started-at-guard");
    await writer.recordHarness({ name: "pi", displayName: "Pi" });

    const realStart = 1_700_000_000_000;

    // First write: the session start event with a real timestamp.
    const r1 = await writer.recordSession({
      harnessId: "pi",
      harnessSessionId: "guard-sess-1",
      cwd: "/tmp/project",
      repoOwner: "owner",
      repoName: "repo",
      startedAt: realStart,
    });

    // Second write: a close/replay event that sends startedAt = 0 (sentinel).
    await writer.recordSession({
      harnessId: "pi",
      harnessSessionId: "guard-sess-1",
      cwd: "/tmp/project",
      startedAt: 0,
      endedAt: realStart + 60_000,
    });

    await writer.close();

    const db = openDb(dbPath);
    const row = /** @type {{ started_at: number; ended_at: number }} */ (
      db.prepare("SELECT started_at, ended_at FROM sessions WHERE harness_session_id='guard-sess-1'").get()
    );
    db.close();

    assert.equal(
      row.started_at,
      realStart,
      "started_at must not be clobbered by a close event with startedAt=0"
    );
    // ended_at should have been set by the close event.
    assert.equal(row.ended_at, realStart + 60_000);
  });

  test("recordSession close event does not clobber existing repo metadata with null", async () => {
    const { writer, dbPath } = await freshWriter("session-repo-guard");
    await writer.recordHarness({ name: "pi", displayName: "Pi" });

    const realStart = 1_700_000_000_000;

    // First write: session start with repo metadata (e.g. from async git capture).
    await writer.recordSession({
      harnessId: "pi",
      harnessSessionId: "repo-guard-sess-1",
      cwd: "/tmp/my-project",
      repoOwner: "acme-corp",
      repoName: "my-project",
      repoRemote: "https://github.com/acme-corp/my-project.git",
      startedAt: realStart,
    });

    // Second write: close event — no repo metadata (harness doesn't re-send it).
    await writer.recordSession({
      harnessId: "pi",
      harnessSessionId: "repo-guard-sess-1",
      cwd: "/tmp/my-project",
      startedAt: 0,
      endedAt: realStart + 120_000,
    });

    await writer.close();

    const db = openDb(dbPath);
    const row = /** @type {{ repo_owner: string; repo_name: string; repo_remote: string }} */ (
      db.prepare(
        "SELECT repo_owner, repo_name, repo_remote FROM sessions WHERE harness_session_id='repo-guard-sess-1'"
      ).get()
    );
    db.close();

    assert.equal(row.repo_owner,  "acme-corp",                                    "repo_owner must be preserved");
    assert.equal(row.repo_name,   "my-project",                                   "repo_name must be preserved");
    assert.equal(row.repo_remote, "https://github.com/acme-corp/my-project.git",  "repo_remote must be preserved");
  });

  test("recordSession strips credentials from repo_remote before storage", async () => {
    const { writer, dbPath } = await freshWriter("session-remote-redact");
    await writer.recordHarness({ name: "pi", displayName: "Pi" });

    await writer.recordSession({
      harnessId: "pi",
      harnessSessionId: "redact-sess-1",
      repoOwner: "owner",
      repoName: "repo",
      repoRemote: "https://user:ghp_supersecrettoken@github.com/owner/repo.git",
      startedAt: Date.now(),
    });

    await writer.close();

    const db = openDb(dbPath);
    const row = /** @type {{ repo_remote: string }} */ (
      db.prepare("SELECT repo_remote FROM sessions WHERE harness_session_id='redact-sess-1'").get()
    );
    db.close();

    assert.equal(
      row.repo_remote,
      "https://github.com/owner/repo.git",
      "repo_remote must not contain embedded credentials"
    );
    assert.ok(
      !row.repo_remote.includes("ghp_supersecrettoken"),
      "token must be absent from stored repo_remote"
    );
  });

  test("recordSession SSH remote is stored unchanged (no credential stripping)", async () => {
    const { writer, dbPath } = await freshWriter("session-ssh-remote");
    await writer.recordHarness({ name: "pi", displayName: "Pi" });

    const sshRemote = "git@github.com:owner/repo.git";

    await writer.recordSession({
      harnessId: "pi",
      harnessSessionId: "ssh-remote-sess-1",
      repoRemote: sshRemote,
      startedAt: Date.now(),
    });

    await writer.close();

    const db = openDb(dbPath);
    const row = /** @type {{ repo_remote: string }} */ (
      db.prepare("SELECT repo_remote FROM sessions WHERE harness_session_id='ssh-remote-sess-1'").get()
    );
    db.close();

    assert.equal(row.repo_remote, sshRemote, "SSH remote must be stored unchanged");
  });

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  test("calling a record method after close() throws", async () => {
    const { writer } = await freshWriter("closed-error");
    await writer.close();

    await assert.rejects(
      () => writer.recordHarness({ name: "pi", displayName: "Pi" }),
      /AnalyticsWriter has been closed/
    );
  });

  test("multiple harnesses write to the same DB without conflict", async () => {
    const { writer, dbPath } = await freshWriter("multi-harness");

    await writer.recordHarness({ name: "pi", displayName: "Pi" });
    await writer.recordHarness({ name: "claude-code", displayName: "Claude Code" });

    const s1 = await writer.recordSession({ harnessId: "pi", harnessSessionId: "s1", startedAt: 1 });
    const s2 = await writer.recordSession({ harnessId: "claude-code", harnessSessionId: "s2", startedAt: 2 });

    await writer.recordLlmMessage({
      harnessId: "pi",
      sessionId: s1.id,
      harnessMessageId: "pi-msg-1",
      ts: Date.now(),
      costSource: "writer",
    });
    await writer.recordLlmMessage({
      harnessId: "claude-code",
      sessionId: s2.id,
      harnessMessageId: "cc-msg-1",
      ts: Date.now(),
      costSource: "harness",
    });

    await writer.close();

    const db = openDb(dbPath);
    assert.equal(countRows(db, "harnesses"), 2);
    assert.equal(countRows(db, "sessions"), 2);
    assert.equal(countRows(db, "llm_messages"), 2);
    db.close();
  });
});
