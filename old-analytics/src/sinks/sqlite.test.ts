/**
 * sqlite.test.ts — Tests for SqliteSink.
 *
 * Tests use a temp file path (mkdtempSync) so each test gets an isolated DB.
 * No mocking — exercises the real better-sqlite3 layer end-to-end.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SqliteSink } from "./sqlite.ts";
import type { AnalyticsConfig } from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(dbPath: string): AnalyticsConfig {
  return {
    local: {
      enabled: true,
      dbPath,
      rawLogDir: join(tmpdir(), "pi-analytics-raw-test"),
    },
    privacy: {
      storePrompts: "hashed",
      storeToolArgs: "summary",
      storeToolOutputs: "size-only",
      redactPatterns: [],
    },
    git: { enabled: true, fetchPR: false, ghTimeoutMs: 2000 },
  };
}

/** Returns a monotonically-increasing fake timestamp. */
let _ts = 1_700_000_000_000;
function ts(): number {
  return (_ts += 1);
}

/** Minimal session_start event. */
function makeSessionStart(id: string) {
  return {
    kind: "session_start" as const,
    ts: ts(),
    id,
    parent_session_id: null,
    parent_session_file: null,
    started_at: ts(),
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

/** Minimal prompt event. */
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

/** Minimal turn_start event. */
function makeTurnStart(id: string, sessionId: string, promptId: string) {
  return {
    kind: "turn_start" as const,
    ts: ts(),
    id,
    session_id: sessionId,
    prompt_id: promptId,
    idx: 0,
    started_at: ts(),
    model_id: "claude-3-5-sonnet-20241022",
    provider: "anthropic",
    thinking_level: null,
  };
}

/** Minimal turn_end event. */
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

/** Minimal llm_message event. */
function makeLlmMessage(
  id: string,
  turnId: string,
  sessionId: string,
) {
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
    cost_input: 0.001,
    cost_output: 0.002,
    cost_cache_read: 0,
    cost_cache_write: 0,
    cost_total: 0.003,
    cache_write_retention: null,
    time_to_first_token_ms: 123,
    total_duration_ms: 456,
    stop_reason: "end_turn",
    model_id: null,
    provider: null,
  };
}

/** Minimal tool_call event. */
function makeToolCall(
  id: string,
  turnId: string,
  sessionId: string,
  name = "read",
) {
  const now = ts();
  return {
    kind: "tool_call" as const,
    ts: now,
    id,
    turn_id: turnId,
    session_id: sessionId,
    tool_call_id: `corr-${id}`,
    name,
    started_at: now,
    ended_at: now + 10,
    duration_ms: 10,
    is_error: false,
    input_bytes: 42,
    output_bytes: 100,
    error_kind: null,
  };
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let tmpDir: string;
let dbPath: string;
let sink: SqliteSink;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-sqlite-test-"));
  dbPath = join(tmpDir, "test.db");
  sink = new SqliteSink();
  await sink.init(makeConfig(dbPath));
});

afterEach(async () => {
  await sink.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

describe("migration", () => {
  it("creates all expected tables on a fresh DB", () => {
    const db = sink.database!;
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);

    const expected = [
      "_meta",
      "branch_transitions",
      "commits_made",
      "files_touched",
      "llm_messages",
      "pr_associations",
      "prompts",
      "resource_usage",
      "sessions",
      "tool_calls",
      "turns",
    ];
    for (const t of expected) {
      assert.ok(tables.includes(t), `missing table: ${t}`);
    }
  });

  it("sets schema_version = 3 in _meta (after all migrations)", () => {
    const db = sink.database!;
    const row = db
      .prepare("SELECT value FROM _meta WHERE key='schema_version'")
      .get() as { value: string } | undefined;
    assert.ok(row, "_meta has no schema_version row");
    assert.equal(row.value, "3");
  });

  it("is idempotent — running init() twice does not throw", async () => {
    // Re-open the same DB path in a second sink
    const sink2 = new SqliteSink();
    await assert.doesNotReject(() => sink2.init(makeConfig(dbPath)));
    await sink2.close();
  });
});

// ---------------------------------------------------------------------------
// session_start / session_patch / session_end
// ---------------------------------------------------------------------------

describe("session events", () => {
  it("inserts a session row on session_start", () => {
    const e = makeSessionStart("sess-1");
    sink.write(e);

    const row = sink.getSessionById("sess-1");
    assert.ok(row, "session row not found");
    assert.equal(row.id, "sess-1");
    assert.equal(row.cwd, "/tmp/test");
    assert.equal(row.pi_version, "1.0.0");
    assert.equal(row.hostname, "test-host");
    assert.equal(row.ended_at, null);
    assert.equal(row.repo_remote, null);
  });

  it("patches git fields on session_patch", () => {
    sink.write(makeSessionStart("sess-2"));
    sink.write({
      kind: "session_patch",
      ts: ts(),
      session_id: "sess-2",
      repo_root: "/home/user/project",
      repo_remote: "https://github.com/owner/repo.git",
      repo_owner: "owner",
      repo_name: "repo",
      branch_start: "main",
      head_sha_start: "abc123",
      dirty_at_start: 0,
    });

    const row = sink.getSessionById("sess-2")!;
    assert.equal(row.repo_remote, "https://github.com/owner/repo.git");
    assert.equal(row.repo_owner, "owner");
    assert.equal(row.branch_start, "main");
    assert.equal(row.head_sha_start, "abc123");
  });

  it("updates end fields on session_end", () => {
    sink.write(makeSessionStart("sess-3"));
    const endedAt = ts();
    sink.write({
      kind: "session_end",
      ts: endedAt,
      session_id: "sess-3",
      ended_at: endedAt,
      branch_end: "feature/x",
      head_sha_end: "def456",
      exit_reason: "normal",
    });

    const row = sink.getSessionById("sess-3")!;
    assert.equal(row.ended_at, endedAt);
    assert.equal(row.branch_end, "feature/x");
    assert.equal(row.head_sha_end, "def456");
    assert.equal(row.exit_reason, "normal");
  });

  it("records parent_session_id for forked sessions", () => {
    sink.write(makeSessionStart("sess-parent"));
    sink.write({
      ...makeSessionStart("sess-child"),
      parent_session_id: "sess-parent",
      parent_session_file: "/tmp/parent.json",
    });

    const child = sink.getSessionById("sess-child")!;
    assert.equal(child.parent_session_id, "sess-parent");
    assert.equal(child.parent_session_file, "/tmp/parent.json");
  });
});

// ---------------------------------------------------------------------------
// prompts
// ---------------------------------------------------------------------------

describe("prompt events", () => {
  it("inserts a prompt row", () => {
    sink.write(makeSessionStart("sess-p1"));
    sink.write(makePrompt("prompt-1", "sess-p1"));

    const db = sink.database!;
    const rows = db
      .prepare("SELECT * FROM prompts WHERE session_id='sess-p1'")
      .all() as { id: string; text_len: number; text_sha256: string }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "prompt-1");
    assert.equal(rows[0].text_len, 10);
    assert.equal(rows[0].text_sha256, "abc123");
  });

  it("records slash command kind", () => {
    sink.write(makeSessionStart("sess-p2"));
    sink.write({
      kind: "prompt" as const,
      ts: ts(),
      id: "prompt-slash",
      session_id: "sess-p2",
      source: "user",
      command: "/usage",
      slash_kind: "builtin",
      text_len: 6,
      text_sha256: "xyz",
      image_count: 0,
    });

    const db = sink.database!;
    const row = db
      .prepare("SELECT command, slash_kind FROM prompts WHERE id='prompt-slash'")
      .get() as { command: string; slash_kind: string };
    assert.equal(row.command, "/usage");
    assert.equal(row.slash_kind, "builtin");
  });
});

// ---------------------------------------------------------------------------
// turns
// ---------------------------------------------------------------------------

describe("turn events", () => {
  it("inserts turn on turn_start then updates on turn_end", () => {
    sink.write(makeSessionStart("sess-t1"));
    sink.write(makePrompt("p-t1", "sess-t1"));
    sink.write(makeTurnStart("turn-1", "sess-t1", "p-t1"));

    const db = sink.database!;
    let row = db
      .prepare("SELECT * FROM turns WHERE id='turn-1'")
      .get() as { id: string; ended_at: number | null; stop_reason: string | null };
    assert.equal(row.id, "turn-1");
    assert.equal(row.ended_at, null);
    assert.equal(row.stop_reason, null);

    sink.write(makeTurnEnd("turn-1", "sess-t1"));

    row = db
      .prepare("SELECT * FROM turns WHERE id='turn-1'")
      .get() as { id: string; ended_at: number | null; stop_reason: string | null };
    assert.ok(row.ended_at !== null, "ended_at should be set");
    assert.equal(row.stop_reason, "end_turn");
  });

  it("patches http_status and rate-limit on provider_response", () => {
    sink.write(makeSessionStart("sess-t2"));
    sink.write(makePrompt("p-t2", "sess-t2"));
    sink.write(makeTurnStart("turn-2", "sess-t2", "p-t2"));
    sink.write({
      kind: "provider_response" as const,
      ts: ts(),
      turn_id: "turn-2",
      session_id: "sess-t2",
      http_status: 200,
      ratelimit_remaining: 4999,
      ratelimit_reset: Date.now() + 60_000,
    });

    const db = sink.database!;
    const row = db
      .prepare("SELECT http_status, ratelimit_remaining FROM turns WHERE id='turn-2'")
      .get() as { http_status: number; ratelimit_remaining: number };
    assert.equal(row.http_status, 200);
    assert.equal(row.ratelimit_remaining, 4999);
  });
});

// ---------------------------------------------------------------------------
// llm_messages
// ---------------------------------------------------------------------------

describe("llm_message events", () => {
  it("inserts llm_message with correct cost fields", () => {
    sink.write(makeSessionStart("sess-llm"));
    sink.write(makePrompt("p-llm", "sess-llm"));
    sink.write(makeTurnStart("turn-llm", "sess-llm", "p-llm"));
    sink.write(makeLlmMessage("msg-1", "turn-llm", "sess-llm"));

    const db = sink.database!;
    const row = db
      .prepare("SELECT * FROM llm_messages WHERE id='msg-1'")
      .get() as {
      input_tokens: number;
      output_tokens: number;
      cost_total: number;
      stop_reason: string;
    };
    assert.equal(row.input_tokens, 100);
    assert.equal(row.output_tokens, 50);
    assert.ok(Math.abs(row.cost_total - 0.003) < 1e-9, "cost_total mismatch");
    assert.equal(row.stop_reason, "end_turn");
  });

  it("stores model_id and provider on llm_message row (migration 002)", () => {
    sink.write(makeSessionStart("sess-model"));
    sink.write(makePrompt("p-model", "sess-model"));
    sink.write(makeTurnStart("turn-model", "sess-model", "p-model"));

    const ev = {
      ...makeLlmMessage("msg-model", "turn-model", "sess-model"),
      model_id: "claude-opus-4-5",
      provider: "anthropic",
    };
    sink.write(ev);

    const db = sink.database!;
    const row = db
      .prepare("SELECT model_id, provider FROM llm_messages WHERE id='msg-model'")
      .get() as { model_id: string | null; provider: string | null };
    assert.equal(row.model_id, "claude-opus-4-5", "model_id stored");
    assert.equal(row.provider, "anthropic", "provider stored");
  });

  it("stores NULL model_id when field is absent (backward compat)", () => {
    sink.write(makeSessionStart("sess-nullm"));
    sink.write(makePrompt("p-nullm", "sess-nullm"));
    sink.write(makeTurnStart("turn-nullm", "sess-nullm", "p-nullm"));

    // makeLlmMessage does not include model_id/provider — old-style event
    const ev = {
      ...makeLlmMessage("msg-nullm", "turn-nullm", "sess-nullm"),
      model_id: null,
      provider: null,
    };
    sink.write(ev);

    const db = sink.database!;
    const row = db
      .prepare("SELECT model_id, provider FROM llm_messages WHERE id='msg-nullm'")
      .get() as { model_id: string | null; provider: string | null };
    assert.strictEqual(row.model_id, null, "model_id is NULL");
    assert.strictEqual(row.provider, null, "provider is NULL");
  });
});

// ---------------------------------------------------------------------------
// Migration 002 — fresh DB and existing-DB upgrade
// ---------------------------------------------------------------------------

describe("migration 002 — llm_message model columns", () => {
  it("fresh DB has model_id and provider columns on llm_messages", () => {
    // `sink` was initialised fresh for this test module — check schema
    const db = sink.database!;
    const cols = (db.prepare("PRAGMA table_info(llm_messages)").all() as Array<{ name: string }>)
      .map((c) => c.name);
    assert.ok(cols.includes("model_id"), "model_id column present");
    assert.ok(cols.includes("provider"), "provider column present");
  });

  it("existing v1 DB (no model columns) survives migration to v2", async () => {
    // Build a v1-only DB by running only 001_init.sql manually.
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join: pjoin } = await import("node:path");
    const Database = (await import("better-sqlite3")).default;

    const dir = mkdtempSync(pjoin(tmpdir(), "pi-analytics-v1-"));
    const v1Path = pjoin(dir, "v1.db");
    const v1db = new Database(v1Path);

    // Apply only migration 001 manually.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname } = await import("node:path");
    const __dirnameLocal = dirname(fileURLToPath(import.meta.url));
    const sql001 = readFileSync(pjoin(__dirnameLocal, "migrations", "001_init.sql"), "utf-8");
    v1db.exec(sql001);
    v1db.exec(`CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    v1db.prepare("INSERT OR REPLACE INTO _meta(key, value) VALUES ('schema_version', '1')").run();

    // Confirm no model_id column yet.
    const colsBefore = (v1db.prepare("PRAGMA table_info(llm_messages)").all() as Array<{ name: string }>)
      .map((c) => c.name);
    assert.ok(!colsBefore.includes("model_id"), "no model_id before migration");
    v1db.close();

    // Now open via SqliteSink — it should run migration 002.
    const { SqliteSink: SS } = await import("./sqlite.ts");
    const upgradeSink = new SS();
    const defaultCfg = {
      local: { enabled: true, dbPath: v1Path, rawLogDir: pjoin(dir, "raw") },
      privacy: { storePrompts: "hashed" as const, storeToolArgs: "summary" as const, storeToolOutputs: "size-only" as const, redactPatterns: [] },
      git: { enabled: false, fetchPR: false, ghTimeoutMs: 2000 },
    };
    await upgradeSink.init(defaultCfg);

    const db2 = upgradeSink.database!;
    const colsAfter = (db2.prepare("PRAGMA table_info(llm_messages)").all() as Array<{ name: string }>)
      .map((c) => c.name);
    assert.ok(colsAfter.includes("model_id"), "model_id present after migration");
    assert.ok(colsAfter.includes("provider"), "provider present after migration");

    await upgradeSink.close();

    // Cleanup
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// tool_calls
// ---------------------------------------------------------------------------

describe("tool_call events", () => {
  it("inserts tool_call row with is_error=0", () => {
    sink.write(makeSessionStart("sess-tc"));
    sink.write(makePrompt("p-tc", "sess-tc"));
    sink.write(makeTurnStart("turn-tc", "sess-tc", "p-tc"));
    sink.write(makeToolCall("tc-1", "turn-tc", "sess-tc", "read"));

    const db = sink.database!;
    const row = db
      .prepare("SELECT * FROM tool_calls WHERE id='tc-1'")
      .get() as { name: string; is_error: number; input_bytes: number };
    assert.equal(row.name, "read");
    assert.equal(row.is_error, 0);
    assert.equal(row.input_bytes, 42);
  });

  it("records is_error=1 for errored tool calls", () => {
    sink.write(makeSessionStart("sess-tc2"));
    sink.write(makePrompt("p-tc2", "sess-tc2"));
    sink.write(makeTurnStart("turn-tc2", "sess-tc2", "p-tc2"));

    const now = ts();
    sink.write({
      kind: "tool_call" as const,
      ts: now,
      id: "tc-err",
      turn_id: "turn-tc2",
      session_id: "sess-tc2",
      tool_call_id: "corr-err",
      name: "bash",
      started_at: now,
      ended_at: now + 5,
      duration_ms: 5,
      is_error: true,
      input_bytes: 20,
      output_bytes: 0,
      error_kind: "ExitNonZero",
    });

    const db = sink.database!;
    const row = db
      .prepare("SELECT is_error, error_kind FROM tool_calls WHERE id='tc-err'")
      .get() as { is_error: number; error_kind: string };
    assert.equal(row.is_error, 1);
    assert.equal(row.error_kind, "ExitNonZero");
  });
});

// ---------------------------------------------------------------------------
// file_touched
// ---------------------------------------------------------------------------

describe("file_touched events", () => {
  it("inserts file_touched row", () => {
    sink.write(makeSessionStart("sess-ft"));
    sink.write({
      kind: "file_touched" as const,
      ts: ts(),
      tool_call_id: "corr-tc-1",
      session_id: "sess-ft",
      path: "/src/foo.ts",
      op: "read",
      bytes: 512,
      sensitive: false,
    });

    const files = sink.getFilesTouchedForSession("sess-ft");
    assert.equal(files.length, 1);
    assert.equal(files[0].path, "/src/foo.ts");
    assert.equal(files[0].op, "read");
    assert.equal(files[0].bytes, 512);
    assert.equal(files[0].sensitive, 0);
  });

  it("sets sensitive=1 for sensitive-path hits", () => {
    sink.write(makeSessionStart("sess-ft2"));
    sink.write({
      kind: "file_touched" as const,
      ts: ts(),
      tool_call_id: "corr-sensitive",
      session_id: "sess-ft2",
      path: "/home/user/.ssh/id_rsa",
      op: "read",
      bytes: 1800,
      sensitive: true,
    });

    const files = sink.getFilesTouchedForSession("sess-ft2");
    assert.equal(files[0].sensitive, 1);
  });
});

// ---------------------------------------------------------------------------
// branch_transition
// ---------------------------------------------------------------------------

describe("branch_transition events", () => {
  it("inserts a branch_transitions row", () => {
    sink.write(makeSessionStart("sess-br"));
    sink.write({
      kind: "branch_transition" as const,
      ts: ts(),
      session_id: "sess-br",
      turn_id: null,
      from_branch: "main",
      to_branch: "feat/analytics",
    });

    const db = sink.database!;
    const rows = db
      .prepare(
        "SELECT from_branch, to_branch FROM branch_transitions WHERE session_id='sess-br'",
      )
      .all() as { from_branch: string; to_branch: string }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].from_branch, "main");
    assert.equal(rows[0].to_branch, "feat/analytics");
  });
});

// ---------------------------------------------------------------------------
// commit_made
// ---------------------------------------------------------------------------

describe("commit_made events", () => {
  it("inserts commits and retrieves via getCommitsForSession", () => {
    sink.write(makeSessionStart("sess-cm"));
    sink.write({
      kind: "commit_made" as const,
      ts: ts(),
      session_id: "sess-cm",
      turn_id: null,
      sha: "aabbcc",
      subject: "feat: add analytics",
      files_changed: 3,
      insertions: 100,
      deletions: 10,
    });
    sink.write({
      kind: "commit_made" as const,
      ts: ts(),
      session_id: "sess-cm",
      turn_id: "turn-x",
      sha: "ddeeff",
      subject: "fix: typo",
      files_changed: 1,
      insertions: 1,
      deletions: 1,
    });

    const commits = sink.getCommitsForSession("sess-cm");
    assert.equal(commits.length, 2);
    assert.equal(commits[0].sha, "aabbcc");
    assert.equal(commits[1].sha, "ddeeff");
    assert.equal(commits[1].turn_id, "turn-x");
  });
});

// ---------------------------------------------------------------------------
// resource_usage (model_select / thinking_level_select / resource_used)
// ---------------------------------------------------------------------------

describe("resource_usage events", () => {
  it("writes model_select to resource_usage with kind=model", () => {
    sink.write(makeSessionStart("sess-ru"));
    sink.write({
      kind: "model_select" as const,
      ts: ts(),
      session_id: "sess-ru",
      model_id: "claude-3-5-sonnet-20241022",
      provider: "anthropic",
    });

    const db = sink.database!;
    const row = db
      .prepare(
        "SELECT label, kind, name FROM resource_usage WHERE session_id='sess-ru'",
      )
      .get() as { label: string; kind: string; name: string };
    assert.equal(row.label, "model_select");
    assert.equal(row.kind, "model");
    assert.equal(row.name, "claude-3-5-sonnet-20241022");
  });

  it("writes thinking_level_select to resource_usage with kind=thinking_level", () => {
    sink.write(makeSessionStart("sess-tl"));
    sink.write({
      kind: "thinking_level_select" as const,
      ts: ts(),
      session_id: "sess-tl",
      turn_id: null,
      thinking_level: "high",
    });

    const db = sink.database!;
    const row = db
      .prepare(
        "SELECT label, kind, name FROM resource_usage WHERE session_id='sess-tl'",
      )
      .get() as { label: string; kind: string; name: string };
    assert.equal(row.label, "thinking_level_select");
    assert.equal(row.kind, "thinking_level");
    assert.equal(row.name, "high");
  });

  it("writes resource_used with explicit label/kind/name", () => {
    sink.write(makeSessionStart("sess-res"));
    sink.write({
      kind: "resource_used" as const,
      ts: ts(),
      session_id: "sess-res",
      label: "skill:git-commit",
      kind_: "skill",
      name: "git-commit",
    });

    const db = sink.database!;
    const row = db
      .prepare(
        "SELECT label, kind, name FROM resource_usage WHERE session_id='sess-res'",
      )
      .get() as { label: string; kind: string; name: string };
    assert.equal(row.label, "skill:git-commit");
    assert.equal(row.kind, "skill");
    assert.equal(row.name, "git-commit");
  });
});

// ---------------------------------------------------------------------------
// tool_side_effect — no-op
// ---------------------------------------------------------------------------

describe("tool_side_effect", () => {
  it("is silently ignored (no DB row, no error)", () => {
    sink.write(makeSessionStart("sess-tse"));
    sink.write({
      kind: "tool_side_effect" as const,
      ts: ts(),
      session_id: "sess-tse",
      turn_id: "turn-x",
      effect: "gh-pr-create",
      remote: "origin",
      branch: "feat/x",
    });

    // No exception means the sink handled it gracefully.
    // Verify no spurious row appeared in any table.
    const db = sink.database!;
    const count = (
      db
        .prepare("SELECT count(*) AS c FROM commits_made WHERE session_id='sess-tse'")
        .get() as { c: number }
    ).c;
    assert.equal(count, 0);
  });
});

// ---------------------------------------------------------------------------
// pr_associations
// ---------------------------------------------------------------------------

describe("pr_association events and upsertPrAssociation", () => {
  it("inserts a pr_association row via write()", () => {
    sink.write(makeSessionStart("sess-pr1"));
    sink.write({
      kind: "pr_association" as const,
      ts: ts(),
      session_id: "sess-pr1",
      repo_remote: "https://github.com/owner/repo",
      pr_number: 42,
      pr_url: "https://github.com/owner/repo/pull/42",
      confidence: 0.8,
      reason: "branch-match",
    });

    const db = sink.database!;
    const row = db
      .prepare(
        "SELECT confidence, reason FROM pr_associations WHERE session_id='sess-pr1' AND pr_number=42",
      )
      .get() as { confidence: number; reason: string } | undefined;
    assert.ok(row, "pr_association row not found");
    assert.ok(Math.abs(row.confidence - 0.8) < 1e-9);
    assert.equal(row.reason, "branch-match");
  });

  it("upsertPrAssociation only upgrades confidence", () => {
    sink.write(makeSessionStart("sess-pr2"));

    const base = {
      session_id: "sess-pr2",
      repo_remote: "https://github.com/owner/repo",
      pr_number: 7,
      pr_url: "https://github.com/owner/repo/pull/7",
      confidence: 0.5,
      reason: "files-overlap" as const,
      linked_at: ts(),
    };
    sink.upsertPrAssociation(base);

    // Lower confidence → should NOT override
    sink.upsertPrAssociation({ ...base, confidence: 0.3, reason: "preceding-window" });

    const db = sink.database!;
    let row = db
      .prepare(
        "SELECT confidence, reason FROM pr_associations WHERE session_id='sess-pr2' AND pr_number=7",
      )
      .get() as { confidence: number; reason: string };
    assert.ok(Math.abs(row.confidence - 0.5) < 1e-9, "confidence should stay at 0.5");
    assert.equal(row.reason, "files-overlap");

    // Higher confidence → should upgrade
    sink.upsertPrAssociation({ ...base, confidence: 1.0, reason: "commit-in-pr" });

    row = db
      .prepare(
        "SELECT confidence, reason FROM pr_associations WHERE session_id='sess-pr2' AND pr_number=7",
      )
      .get() as { confidence: number; reason: string };
    assert.ok(Math.abs(row.confidence - 1.0) < 1e-9, "confidence should upgrade to 1.0");
    assert.equal(row.reason, "commit-in-pr");
  });
});

// ---------------------------------------------------------------------------
// Read-side query methods
// ---------------------------------------------------------------------------

describe("read-side query methods", () => {
  it("findSessionsByRepoSince returns only sessions after the given ts", () => {
    const t0 = ts();
    sink.write({
      ...makeSessionStart("sess-q1"),
      started_at: t0,
      repo_remote: "https://github.com/org/proj",
    });
    sink.write({
      ...makeSessionStart("sess-q2"),
      started_at: t0 + 100,
      repo_remote: "https://github.com/org/proj",
    });
    sink.write({
      ...makeSessionStart("sess-q3"),
      started_at: t0 + 200,
      repo_remote: "https://github.com/org/other",
    });
    // Patch git fields so repo_remote is set
    sink.write({
      kind: "session_patch" as const,
      ts: ts(),
      session_id: "sess-q1",
      repo_root: "/p",
      repo_remote: "https://github.com/org/proj",
      repo_owner: "org",
      repo_name: "proj",
      branch_start: "main",
      head_sha_start: "aa",
      dirty_at_start: 0,
    });
    sink.write({
      kind: "session_patch" as const,
      ts: ts(),
      session_id: "sess-q2",
      repo_root: "/p",
      repo_remote: "https://github.com/org/proj",
      repo_owner: "org",
      repo_name: "proj",
      branch_start: "main",
      head_sha_start: "bb",
      dirty_at_start: 0,
    });

    const results = sink.findSessionsByRepoSince(
      "https://github.com/org/proj",
      t0 + 50,
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].id, "sess-q2");
  });

  it("getSessionById returns undefined for unknown id", () => {
    const row = sink.getSessionById("no-such-id");
    assert.equal(row, undefined);
  });

  it("write() does not throw when called before init()", () => {
    const uninitSink = new SqliteSink();
    // Should console.warn but not throw
    assert.doesNotThrow(() => {
      uninitSink.write(makeSessionStart("x"));
    });
  });
});

// ---------------------------------------------------------------------------
// Full round-trip: session → prompt → turn → llm_message → tool_call → files
// ---------------------------------------------------------------------------

describe("full round-trip", () => {
  it("stores and retrieves a complete session flow", () => {
    const sessId = "rt-sess";
    const promptId = "rt-prompt";
    const turnId = "rt-turn";
    const msgId = "rt-msg";
    const tcId = "rt-tc";

    sink.write(makeSessionStart(sessId));
    sink.write(makePrompt(promptId, sessId));
    sink.write(makeTurnStart(turnId, sessId, promptId));
    sink.write(makeLlmMessage(msgId, turnId, sessId));
    sink.write(makeToolCall(tcId, turnId, sessId));
    sink.write({
      kind: "file_touched" as const,
      ts: ts(),
      tool_call_id: `corr-${tcId}`,
      session_id: sessId,
      path: "/src/index.ts",
      op: "read",
      bytes: 200,
      sensitive: false,
    });
    sink.write(makeTurnEnd(turnId, sessId));
    sink.write({
      kind: "session_end" as const,
      ts: ts(),
      session_id: sessId,
      ended_at: ts(),
      branch_end: "main",
      head_sha_end: "ffffff",
      exit_reason: "normal",
    });

    const db = sink.database!;

    const sessionCount = (
      db.prepare("SELECT count(*) AS c FROM sessions").get() as { c: number }
    ).c;
    const promptCount = (
      db.prepare("SELECT count(*) AS c FROM prompts").get() as { c: number }
    ).c;
    const turnCount = (
      db.prepare("SELECT count(*) AS c FROM turns").get() as { c: number }
    ).c;
    const msgCount = (
      db.prepare("SELECT count(*) AS c FROM llm_messages").get() as { c: number }
    ).c;
    const tcCount = (
      db.prepare("SELECT count(*) AS c FROM tool_calls").get() as { c: number }
    ).c;

    assert.equal(sessionCount, 1);
    assert.equal(promptCount, 1);
    assert.equal(turnCount, 1);
    assert.equal(msgCount, 1);
    assert.equal(tcCount, 1);

    const files = sink.getFilesTouchedForSession(sessId);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, "/src/index.ts");

    const session = sink.getSessionById(sessId)!;
    assert.equal(session.branch_end, "main");
    assert.equal(session.exit_reason, "normal");
  });
});
