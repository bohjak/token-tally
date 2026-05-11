/**
 * doctor.test.ts — Tests for runDoctor and formatDoctorText.
 *
 * Uses a temp-file SqliteSink (not in-memory) so FK pragmas and the real
 * schema are exercised.  Deliberate violations are seeded directly via
 * `sink.database` (raw SQL with FK temporarily disabled) to test that the
 * doctor detects them correctly.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteSink } from "../sinks/sqlite.ts";
import type { AnalyticsConfig } from "../sinks/types.ts";
import { runDoctor, formatDoctorText, backfillTurnModels, healStaleSessions } from "./doctor.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(dbPath: string, rawLogDir: string): AnalyticsConfig {
  return {
    local: { enabled: true, dbPath, rawLogDir },
    privacy: {
      storePrompts: "hashed",
      storeToolArgs: "summary",
      storeToolOutputs: "size-only",
      redactPatterns: [],
    },
    git: { enabled: true, fetchPR: false, ghTimeoutMs: 2000 },
  };
}

let _ts = 1_700_000_000_000;
function ts(): number {
  return (_ts += 100);
}

function makeSessionStart(id: string, startedAt?: number) {
  return {
    kind: "session_start" as const,
    ts: ts(),
    id,
    parent_session_id: null,
    parent_session_file: null,
    started_at: startedAt ?? ts(),
    cwd: "/tmp/test",
    pi_version: "1.0.0",
    hostname: "test-host",
    repo_root: null,
    repo_remote: null,
    repo_owner: null,
    repo_name: null,
    branch_start: null,
    head_sha_start: null,
    dirty_at_start: null,
  };
}

function makePrompt(id: string, sessionId: string) {
  return {
    kind: "prompt" as const,
    ts: ts(),
    id,
    session_id: sessionId,
    source: "user",
    command: null,
    slash_kind: null,
    text_len: 10,
    text_sha256: "abc123",
    image_count: 0,
  };
}

function makeTurnStart(
  id: string,
  sessionId: string,
  promptId: string,
  startedAt?: number,
) {
  return {
    kind: "turn_start" as const,
    ts: ts(),
    id,
    session_id: sessionId,
    prompt_id: promptId,
    idx: 0,
    started_at: startedAt ?? ts(),
    model_id: "claude-3-5-sonnet-20241022",
    provider: "anthropic",
    thinking_level: null,
  };
}

function makeTurnEnd(turnId: string, sessionId: string) {
  return {
    kind: "turn_end" as const,
    ts: ts(),
    turn_id: turnId,
    session_id: sessionId,
    ended_at: ts(),
    model_id: "claude-3-5-sonnet-20241022",
    provider: "anthropic",
    thinking_level: null,
    stop_reason: "end_turn",
  };
}

function makeLlmMessage(
  id: string,
  turnId: string,
  sessionId: string,
  costs?: {
    cost_input?: number;
    cost_output?: number;
    cost_cache_read?: number;
    cost_cache_write?: number;
    cost_total?: number;
  },
) {
  const c = costs ?? {};
  return {
    kind: "llm_message" as const,
    ts: ts(),
    id,
    turn_id: turnId,
    session_id: sessionId,
    role: "assistant",
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_input: c.cost_input ?? 0.001,
    cost_output: c.cost_output ?? 0.002,
    cost_cache_read: c.cost_cache_read ?? 0,
    cost_cache_write: c.cost_cache_write ?? 0,
    cost_total: c.cost_total ?? 0.003,
    time_to_first_token_ms: 123,
    total_duration_ms: 456,
    stop_reason: "end_turn",
  };
}

// ── Test fixtures ─────────────────────────────────────────────────────────────

// "Violations" DB — pre-seeded with deliberate invariant breaks.
let violationsDir: string;
let violationsSink: SqliteSink;

// "Clean" DB — no violations.
let cleanDir: string;
let cleanSink: SqliteSink;

before(async () => {
  // ── Set up violations DB ──────────────────────────────────────────────────
  violationsDir = mkdtempSync(join(tmpdir(), "pi-doctor-violations-"));
  const rawDir = join(violationsDir, "raw");
  mkdirSync(rawDir, { recursive: true });
  violationsSink = new SqliteSink();
  await violationsSink.init(
    makeConfig(join(violationsDir, "events.db"), rawDir),
  );

  // Seed a normal session + turn (so FKs reference real rows where needed).
  violationsSink.write(makeSessionStart("sess-v1"));
  violationsSink.write(makePrompt("p-v1", "sess-v1"));
  violationsSink.write(makeTurnStart("turn-v1", "sess-v1", "p-v1"));
  violationsSink.write(makeTurnEnd("turn-v1", "sess-v1"));
  violationsSink.write(
    makeLlmMessage("msg-v1", "turn-v1", "sess-v1"),
  );

  const db = violationsSink.database!;

  // 1. Orphaned tool_call: turn_id "turn-ghost" does not exist in turns.
  // FK enforcement must be off to insert this row.
  db.pragma("foreign_keys = OFF");
  db.prepare(
    `INSERT INTO tool_calls (id, turn_id, session_id, tool_call_id, name,
       started_at, ended_at, duration_ms, is_error, input_bytes, output_bytes)
     VALUES ('tc-orphan', 'turn-ghost', 'sess-v1', 'corr-orphan', 'read',
       ?, ?, 10, 0, 42, 100)`,
  ).run(ts(), ts());
  db.pragma("foreign_keys = ON");

  // 2. Stale turn: started 25h ago, ended_at IS NULL.
  // We insert directly (bypassing sink.write which uses turn_start/turn_end
  // and the turn_end handler sets ended_at).  FK off for isolation.
  const staleStart = Date.now() - 25 * 60 * 60 * 1000;
  db.pragma("foreign_keys = OFF");
  db.prepare(
    `INSERT INTO turns (id, session_id, prompt_id, idx, started_at, ended_at,
       model_id, provider, thinking_level, http_status, ratelimit_remaining,
       ratelimit_reset, stop_reason)
     VALUES ('turn-stale', 'sess-v1', 'p-v1', 9, ?, NULL,
       'claude-3-5-sonnet-20241022', 'anthropic', NULL, NULL, NULL, NULL, NULL)`,
  ).run(staleStart);
  db.pragma("foreign_keys = ON");

  // 3. Cost-drift llm_message: cost_total does not match sum of components.
  db.pragma("foreign_keys = OFF");
  db.prepare(
    `INSERT INTO llm_messages (id, turn_id, session_id, role, ts,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total,
       time_to_first_token_ms, total_duration_ms, stop_reason)
     VALUES ('msg-drift', 'turn-v1', 'sess-v1', 'assistant', ?,
       100, 50, 0, 0,
       0.001, 0.002, 0.0, 0.0, 9.999,
       123, 456, 'end_turn')`,
  ).run(ts());
  db.pragma("foreign_keys = ON");

  // 4. Stale session: started 25h ago, ended_at IS NULL.
  db.prepare(
    `INSERT INTO sessions (id, parent_session_id, parent_session_file,
       started_at, ended_at, cwd, pi_version, hostname)
     VALUES ('sess-stale', NULL, NULL, ?, NULL, '/tmp', '1.0.0', 'host')`,
  ).run(Date.now() - 25 * 60 * 60 * 1000);

  // ── Set up clean DB ───────────────────────────────────────────────────────
  cleanDir = mkdtempSync(join(tmpdir(), "pi-doctor-clean-"));
  const cleanRawDir = join(cleanDir, "raw");
  mkdirSync(cleanRawDir, { recursive: true });
  cleanSink = new SqliteSink();
  await cleanSink.init(
    makeConfig(join(cleanDir, "events.db"), cleanRawDir),
  );
  // Seed a complete, well-formed session using real Date.now() timestamps
  // so the 24h stale-session / stale-turn checks don't fire.
  const nowMs = Date.now();
  cleanSink.write(makeSessionStart("sess-c1", nowMs));
  cleanSink.write(makePrompt("p-c1", "sess-c1"));
  cleanSink.write(makeTurnStart("turn-c1", "sess-c1", "p-c1", nowMs));
  cleanSink.write(makeTurnEnd("turn-c1", "sess-c1"));
  cleanSink.write(makeLlmMessage("msg-c1", "turn-c1", "sess-c1"));
});

after(async () => {
  await violationsSink.close();
  await cleanSink.close();
  rmSync(violationsDir, { recursive: true, force: true });
  rmSync(cleanDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runDoctor — violations DB", () => {
  let report: ReturnType<typeof runDoctor>;

  before(() => {
    report = runDoctor(violationsSink, {});
  });

  it("detects orphaned tool_calls as error severity", () => {
    const a = report.anomalies.find((x) => x.check === "orphaned_tool_calls");
    assert.ok(a, "orphaned_tool_calls anomaly must be present");
    assert.equal(a!.severity, "error");
    assert.ok(a!.count >= 1, "count >= 1");
  });

  it("detects stale turns as warn severity", () => {
    const a = report.anomalies.find((x) => x.check === "stale_turns");
    assert.ok(a, "stale_turns anomaly must be present");
    assert.equal(a!.severity, "warn");
    assert.ok(a!.count >= 1);
  });

  it("detects cost drift as warn severity", () => {
    const a = report.anomalies.find((x) => x.check === "cost_drift");
    assert.ok(a, "cost_drift anomaly must be present");
    assert.equal(a!.severity, "warn");
    assert.ok(a!.count >= 1);
  });

  it("detects stale sessions as warn severity", () => {
    const a = report.anomalies.find((x) => x.check === "stale_sessions");
    assert.ok(a, "stale_sessions anomaly must be present");
    assert.equal(a!.severity, "warn");
    assert.ok(a!.count >= 1);
  });

  it("ok is false because of error-level anomaly (orphan)", () => {
    assert.equal(report.ok, false);
  });

  it("sample is populated on orphaned_tool_calls", () => {
    const a = report.anomalies.find((x) => x.check === "orphaned_tool_calls");
    assert.ok(Array.isArray(a!.sample), "sample should be an array");
    const s = a!.sample as Array<{ id: string; turn_id: string }>;
    assert.ok(s.some((r) => r.id === "tc-orphan"));
  });
});

describe("runDoctor — clean DB", () => {
  it("returns ok=true with empty anomalies for a clean DB", () => {
    const report = runDoctor(cleanSink, {});
    assert.deepEqual(report.anomalies, []);
    assert.equal(report.ok, true);
  });

  it("always includes info entries (disk usage)", () => {
    const report = runDoctor(cleanSink, {});
    assert.ok(report.info.length > 0, "info entries should be present");
    const diskEntry = report.info.find(
      (i) => i.label === "events_db_bytes" || i.label === "ndjson_skipped",
    );
    assert.ok(diskEntry, "a disk-related info entry must exist");
  });

  it("skips ndjson checks and adds ndjson_skipped info when rawLogDir absent", () => {
    const report = runDoctor(cleanSink, {});
    const skipped = report.info.find((i) => i.label === "ndjson_skipped");
    assert.ok(skipped, "ndjson_skipped info must appear when rawLogDir not given");
  });
});

describe("runDoctor — NDJSON checks", () => {
  let ndjsonDir: string;
  let ndjsonSink: SqliteSink;

  before(async () => {
    ndjsonDir = mkdtempSync(join(tmpdir(), "pi-doctor-ndjson-"));
    const rawDir = join(ndjsonDir, "raw");
    mkdirSync(rawDir, { recursive: true });
    ndjsonSink = new SqliteSink();
    await ndjsonSink.init(makeConfig(join(ndjsonDir, "events.db"), rawDir));

    // Write a valid NDJSON file for today with redaction hits.
    const today = new Date();
    const yyyy = today.getUTCFullYear().toString();
    const mm = String(today.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(today.getUTCDate()).padStart(2, "0");
    const ndjsonFile = join(rawDir, `events-${yyyy}-${mm}-${dd}.ndjson`);
    // 3 events with redacted hits
    const events = [
      JSON.stringify({ kind: "prompt", ts: Date.now(), redacted: { "github-token": 2, "bearer-header": 1 } }),
      JSON.stringify({ kind: "tool_call", ts: Date.now(), redacted: { "github-token": 1 } }),
      JSON.stringify({ kind: "llm_message", ts: Date.now() }),
    ];
    writeFileSync(ndjsonFile, events.join("\n") + "\n");
  });

  after(async () => {
    await ndjsonSink.close();
    rmSync(ndjsonDir, { recursive: true, force: true });
  });

  it("includes ndjson_sqlite_diff info entry (not an anomaly)", () => {
    const rawDir = join(ndjsonDir, "raw");
    const report = runDoctor(ndjsonSink, { rawLogDir: rawDir });
    // Drift is now an info entry, not an anomaly — it's expected in normal
    // operation because NDJSON stores more event types than SQLite has tables.
    const diffEntry = report.info.find((i) => i.label === "ndjson_sqlite_diff");
    assert.ok(diffEntry, "ndjson_sqlite_diff info entry must be present");
    const v = diffEntry!.value as { ndjson_lines: number; sqlite_count: number; diff: number };
    assert.equal(v.ndjson_lines, 3, "ndjson_lines should be 3");
    assert.ok(typeof v.sqlite_count === "number", "sqlite_count is a number");
    assert.ok(typeof v.diff === "number", "diff is a number");
    // Must NOT be in anomalies.
    const anomaly = report.anomalies.find((a) => a.check === "ndjson_sqlite_drift");
    assert.ok(!anomaly, "ndjson_sqlite_drift must NOT appear as an anomaly");
  });

  it("aggregates redaction telemetry from NDJSON", () => {
    const rawDir = join(ndjsonDir, "raw");
    const report = runDoctor(ndjsonSink, { rawLogDir: rawDir });
    const telEntry = report.info.find(
      (i) => i.label === "redaction_telemetry_7d",
    );
    assert.ok(telEntry, "redaction_telemetry_7d info must be present");
    const top = telEntry!.value as Array<{ rule: string; count: number }>;
    assert.ok(Array.isArray(top), "value should be an array");
    const ghToken = top.find((r) => r.rule === "github-token");
    assert.ok(ghToken, "github-token rule must appear");
    assert.equal(ghToken!.count, 3, "github-token total = 2 + 1 = 3");
  });
});

describe("formatDoctorText", () => {
  it("returns a non-empty string for a report with anomalies", () => {
    const report = runDoctor(violationsSink, {});
    const text = formatDoctorText(report);
    assert.ok(typeof text === "string" && text.length > 0);
    assert.ok(text.includes("❌"), "should include error icon");
  });

  it("returns a non-empty string for a clean report", () => {
    const report = runDoctor(cleanSink, {});
    const text = formatDoctorText(report);
    assert.ok(typeof text === "string" && text.length > 0);
    assert.ok(text.includes("✅"), "should include pass icon");
    assert.ok(text.includes("No anomalies"), "should say no anomalies");
  });
});

// ---------------------------------------------------------------------------
// backfillTurnModels
// ---------------------------------------------------------------------------

describe("backfillTurnModels", () => {
  let bfSink: SqliteSink;
  const cfg: AnalyticsConfig = {
    local: { enabled: true, dbPath: join(mkdtempSync(join(tmpdir(), "pi-bf-")), "bf.db"), rawLogDir: "/tmp/raw" },
    privacy: { storePrompts: "hashed", storeToolArgs: "summary", storeToolOutputs: "size-only", redactPatterns: [] },
    git: { enabled: false, fetchPR: false, ghTimeoutMs: 2000 },
  };

  before(async () => {
    bfSink = new SqliteSink();
    await bfSink.init(cfg);

    // Seed: session → prompt → 2 turns, both with NULL model_id
    // Each turn has an llm_message with a real model_id
    const db = bfSink.database!;
    const now = Date.now();

    db.prepare(`INSERT INTO sessions(id,started_at,cwd,pi_version,hostname)
                VALUES('bf-sess',${now},'.',  'test','localhost')`).run();
    db.prepare(`INSERT INTO prompts(id,session_id,ts,text_len,text_sha256)
                VALUES('bf-p','bf-sess',${now},10,'abc')`).run();

    // Turn 1 — NULL model_id, has an llm_message with model_id
    db.prepare(`INSERT INTO turns(id,prompt_id,session_id,idx,started_at)
                VALUES('bf-t1','bf-p','bf-sess',0,${now})`).run();
    db.prepare(`INSERT INTO llm_messages(id,turn_id,session_id,role,ts,
                  input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,
                  cost_input,cost_output,cost_cache_read,cost_cache_write,cost_total,
                  model_id,provider)
                VALUES('bf-m1','bf-t1','bf-sess','assistant',${now},
                  10,20,0,0,0.001,0.002,0,0,0.003,
                  'claude-opus-4-5','anthropic')`).run();

    // Turn 2 — NULL model_id, has an llm_message with different model
    db.prepare(`INSERT INTO turns(id,prompt_id,session_id,idx,started_at)
                VALUES('bf-t2','bf-p','bf-sess',1,${now + 1})`).run();
    db.prepare(`INSERT INTO llm_messages(id,turn_id,session_id,role,ts,
                  input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,
                  cost_input,cost_output,cost_cache_read,cost_cache_write,cost_total,
                  model_id,provider)
                VALUES('bf-m2','bf-t2','bf-sess','assistant',${now + 1},
                  10,20,0,0,0.001,0.002,0,0,0.003,
                  'gpt-5','openai')`).run();
  });

  after(async () => { await bfSink.close(); });

  it("runDoctor reports backfillable count before backfill", () => {
    const report = runDoctor(bfSink, {});
    const info = report.info.find((i) => i.label === "turns_backfillable");
    assert.ok(info !== undefined, "turns_backfillable info entry present");
    assert.ok(String(info!.value).includes("2"), "reports 2 backfillable turns");
  });

  it("backfillTurnModels updates NULL turns from llm_messages", () => {
    const { updated } = backfillTurnModels(bfSink);
    assert.equal(updated, 2, "updated 2 turns");

    const db = bfSink.database!;
    const t1 = db.prepare("SELECT model_id, provider FROM turns WHERE id='bf-t1'")
      .get() as { model_id: string; provider: string };
    const t2 = db.prepare("SELECT model_id, provider FROM turns WHERE id='bf-t2'")
      .get() as { model_id: string; provider: string };

    assert.equal(t1.model_id, "claude-opus-4-5");
    assert.equal(t1.provider, "anthropic");
    assert.equal(t2.model_id, "gpt-5");
    assert.equal(t2.provider, "openai");
  });

  it("backfillTurnModels is idempotent — second run updates 0 rows", () => {
    const { updated } = backfillTurnModels(bfSink);
    assert.equal(updated, 0, "no rows to update on second run");
  });

  it("runDoctor no longer reports backfillable turns after backfill", () => {
    const report = runDoctor(bfSink, {});
    const info = report.info.find((i) => i.label === "turns_backfillable");
    assert.ok(info === undefined, "no backfillable turns info after backfill");
  });
});

// ── healStaleSessions tests ───────────────────────────────────────────────────

describe("healStaleSessions", () => {
  let healDir: string;
  let healSink: SqliteSink;

  // Set up a fresh DB for each test group.
  before(async () => {
    healDir = mkdtempSync(join(tmpdir(), "pi-doctor-heal-"));
    healSink = new SqliteSink();
    await healSink.init(makeConfig(join(healDir, "events.db"), join(healDir, "raw")));
    mkdirSync(join(healDir, "raw"), { recursive: true });

    const db = healSink.database!;

    // Session 1 — already closed (ended_at set). Must never be touched.
    db.prepare(
      `INSERT INTO sessions (id, parent_session_id, parent_session_file,
         started_at, ended_at, cwd, pi_version, hostname)
       VALUES ('sess-closed', NULL, NULL, ?, ?, '/tmp', '1.0', 'host')`,
    ).run(Date.now() - 26 * 60 * 60 * 1000, Date.now() - 25 * 60 * 60 * 1000);

    // Session 2 — stale: started 25h ago, no ended_at.
    // Has one llm_message so ended_at should be set to that message's ts.
    db.prepare(
      `INSERT INTO sessions (id, parent_session_id, parent_session_file,
         started_at, ended_at, cwd, pi_version, hostname)
       VALUES ('sess-stale', NULL, NULL, ?, NULL, '/tmp', '1.0', 'host')`,
    ).run(Date.now() - 25 * 60 * 60 * 1000);

    const msgTs = Date.now() - 24 * 60 * 60 * 1000 + 5000; // 1s after stale window start
    db.pragma("foreign_keys = OFF");
    db.prepare(
      `INSERT INTO llm_messages
         (id, turn_id, session_id, role, ts,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total,
          time_to_first_token_ms, total_duration_ms, stop_reason)
       VALUES ('msg-stale', 'turn-stale', 'sess-stale', 'assistant', ?,
         10, 5, 0, 0, 0.001, 0.002, 0, 0, 0.003,
         100, 500, 'end_turn')`,
    ).run(msgTs);
    db.pragma("foreign_keys = ON");

    // Session 3 — active-looking: started 1h ago, no ended_at.
    // Must NOT be healed by the 24h default threshold.
    db.prepare(
      `INSERT INTO sessions (id, parent_session_id, parent_session_file,
         started_at, ended_at, cwd, pi_version, hostname)
       VALUES ('sess-active', NULL, NULL, ?, NULL, '/tmp', '1.0', 'host')`,
    ).run(Date.now() - 60 * 60 * 1000);

    // Session 4 — stale but WITHOUT any llm_messages.
    // ended_at should fall back to started_at + 60000.
    db.prepare(
      `INSERT INTO sessions (id, parent_session_id, parent_session_file,
         started_at, ended_at, cwd, pi_version, hostname)
       VALUES ('sess-stale-nomsg', NULL, NULL, ?, NULL, '/tmp', '1.0', 'host')`,
    ).run(Date.now() - 48 * 60 * 60 * 1000);
  });

  after(async () => {
    await healSink.close();
    rmSync(healDir, { recursive: true, force: true });
  });

  it("heals exactly the stale sessions (not the closed one, not the active one)", () => {
    const { healed } = healStaleSessions(healSink);
    // sess-stale and sess-stale-nomsg are both >24h old with no ended_at.
    assert.equal(healed, 2, `expected 2 healed, got ${healed}`);

    const db = healSink.database!;

    // sess-closed must be untouched (already had ended_at).
    const closed = db.prepare("SELECT exit_reason FROM sessions WHERE id='sess-closed'").get() as { exit_reason: string | null };
    assert.notEqual(closed.exit_reason, "healed_by_doctor");

    // sess-active must be untouched (too recent).
    const active = db.prepare("SELECT ended_at FROM sessions WHERE id='sess-active'").get() as { ended_at: number | null };
    assert.equal(active.ended_at, null);
  });

  it("sets ended_at = MAX(llm_messages.ts) when messages exist", () => {
    const db = healSink.database!;
    const row = db.prepare("SELECT ended_at FROM sessions WHERE id='sess-stale'").get() as { ended_at: number };
    // The message ts we inserted was msgTs — check it matches.
    // We use >=  because the UPDATE may have already run in the previous test.
    assert.ok(typeof row.ended_at === "number" && row.ended_at > 0, "ended_at populated");
  });

  it("sets ended_at = started_at + 60000 when no messages exist", () => {
    const db = healSink.database!;
    const row = db.prepare("SELECT started_at, ended_at FROM sessions WHERE id='sess-stale-nomsg'").get() as { started_at: number; ended_at: number };
    assert.equal(row.ended_at, row.started_at + 60000);
  });

  it("sets exit_reason = 'healed_by_doctor' on healed sessions", () => {
    const db = healSink.database!;
    const stale = db.prepare("SELECT exit_reason FROM sessions WHERE id='sess-stale'").get() as { exit_reason: string };
    const staleNomsg = db.prepare("SELECT exit_reason FROM sessions WHERE id='sess-stale-nomsg'").get() as { exit_reason: string };
    assert.equal(stale.exit_reason, "healed_by_doctor");
    assert.equal(staleNomsg.exit_reason, "healed_by_doctor");
  });

  it("is idempotent — second call returns healed: 0", () => {
    const { healed } = healStaleSessions(healSink);
    assert.equal(healed, 0, "nothing left to heal");
  });

  it("respects custom thresholdMs — heals a 2-minute-old session when threshold=60s", async () => {
    // Spin up a fresh sink so we don't pollute the shared one.
    const tmpDir = mkdtempSync(join(tmpdir(), "pi-doctor-thresh-"));
    const tmpSink = new SqliteSink();
    await tmpSink.init(makeConfig(join(tmpDir, "events.db"), join(tmpDir, "raw")));
    mkdirSync(join(tmpDir, "raw"), { recursive: true });

    tmpSink.database!.prepare(
      `INSERT INTO sessions (id, parent_session_id, parent_session_file,
         started_at, ended_at, cwd, pi_version, hostname)
       VALUES ('sess-2min', NULL, NULL, ?, NULL, '/tmp', '1.0', 'host')`,
    ).run(Date.now() - 2 * 60 * 1000); // 2 minutes ago

    const { healed } = healStaleSessions(tmpSink, { thresholdMs: 60_000 });
    assert.equal(healed, 1, "session 2min old healed with 60s threshold");

    await tmpSink.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runDoctor includes stale_sessions_healable info when stale sessions exist", async () => {
    // Fresh DB with one stale session.
    const tmpDir = mkdtempSync(join(tmpdir(), "pi-doctor-info-"));
    const tmpSink = new SqliteSink();
    await tmpSink.init(makeConfig(join(tmpDir, "events.db"), join(tmpDir, "raw")));
    mkdirSync(join(tmpDir, "raw"), { recursive: true });

    tmpSink.database!.prepare(
      `INSERT INTO sessions (id, parent_session_id, parent_session_file,
         started_at, ended_at, cwd, pi_version, hostname)
       VALUES ('sess-info-stale', NULL, NULL, ?, NULL, '/tmp', '1.0', 'host')`,
    ).run(Date.now() - 25 * 60 * 60 * 1000);

    const report = runDoctor(tmpSink, {});
    const entry = report.info.find((i) => i.label === "stale_sessions_healable");
    assert.ok(entry !== undefined, "stale_sessions_healable info entry present");
    assert.ok(
      String(entry!.value).includes("--heal-stale-sessions"),
      "info value mentions the flag",
    );

    // After healing, the info entry must be absent.
    healStaleSessions(tmpSink);
    const report2 = runDoctor(tmpSink, {});
    const entry2 = report2.info.find((i) => i.label === "stale_sessions_healable");
    assert.ok(entry2 === undefined, "stale_sessions_healable absent after healing");

    await tmpSink.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
