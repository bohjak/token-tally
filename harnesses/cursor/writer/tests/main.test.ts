/**
 * tests/main.test.ts — End-to-end integration test for the Cursor writer.
 *
 * Pipes real hook payloads (Cursor-native format) into the compiled binary
 * against an isolated temp DB, then inspects the resulting SQLite database to
 * assert the full session lifecycle writes the expected rows, and that
 * replaying the same sequence is fully idempotent.
 *
 * Uses:
 *   - node:sqlite (DatabaseSync) — Node 24 built-in, no native addon needed
 *   - spawnSync — synchronous subprocess per hook (matches how Cursor calls us)
 *   - Isolated XDG_DATA_HOME / XDG_STATE_HOME — never touches the real DB
 *
 * Key Cursor differences from Claude Code tests:
 *   - Fixtures use `conversation_id` + `generation_id` (no session_id on most events)
 *   - No transcript_path dependency — Cursor hooks are write-only at T4
 *   - Event sequence includes afterAgentResponse (not present in Claude Code hooks)
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

// __dirname = dist/tests/
// Package root = dist/tests/../../ = <package-root>/
const PACKAGE_ROOT = path.join(__dirname, "..", "..");
const FIXTURES_DIR = path.join(PACKAGE_ROOT, "tests", "fixtures");
const BINARY = path.join(__dirname, "..", "bin", "token-tally-cursor-hook.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runHook(
  payload: Record<string, unknown>,
  env: Record<string, string>,
): { exitCode: number; stderr: string } {
  const result = spawnSync(process.execPath, [BINARY], {
    input: JSON.stringify(payload),
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 15_000,
  });
  return { exitCode: result.status ?? 1, stderr: result.stderr ?? "" };
}

function loadFixture(relPath: string): Record<string, unknown> {
  const raw = fs.readFileSync(path.join(FIXTURES_DIR, relPath), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

interface Counts {
  harnesses: number;
  sessions: number;
  turns: number;
  toolCalls: number;
  llmMessages: number;
}

function queryCounts(dbPath: string): Counts {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA query_only = 1");
  const n = (sql: string): number => {
    const row = db.prepare(sql).get() as { n: number } | null;
    return row?.n ?? 0;
  };
  const counts: Counts = {
    harnesses: n("SELECT count(*) as n FROM harnesses WHERE name='cursor'"),
    sessions: n("SELECT count(*) as n FROM sessions WHERE harness_id='cursor'"),
    turns: n("SELECT count(*) as n FROM turns WHERE harness_id='cursor'"),
    toolCalls: n("SELECT count(*) as n FROM tool_calls WHERE harness_id='cursor'"),
    llmMessages: n("SELECT count(*) as n FROM llm_messages WHERE harness_id='cursor'"),
  };
  db.close();
  return counts;
}

// ---------------------------------------------------------------------------
// Shared state between sequential tests
// ---------------------------------------------------------------------------

let sharedTmpDir = "";
let sharedDbPath = "";
let sharedEnv: Record<string, string> = {};

// ---------------------------------------------------------------------------
// Test 1: Full session lifecycle
// ---------------------------------------------------------------------------

test("full session lifecycle (Cursor-native format)", async () => {
  // ── Temp environment ──────────────────────────────────────────────────────
  sharedTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-cursor-integration-"));
  const xdgDataHome = path.join(sharedTmpDir, "data");
  const xdgStateHome = path.join(sharedTmpDir, "state");
  fs.mkdirSync(xdgDataHome, { recursive: true });
  fs.mkdirSync(xdgStateHome, { recursive: true });

  sharedDbPath = path.join(xdgDataHome, "token-tally", "events.db");
  sharedEnv = {
    XDG_DATA_HOME: xdgDataHome,
    XDG_STATE_HOME: xdgStateHome,
    // Prevent subscription config from being loaded from the real home dir
    XDG_CONFIG_HOME: path.join(sharedTmpDir, "config"),
  };

  // ── Hook sequence ─────────────────────────────────────────────────────────
  // sessionStart → beforeSubmitPrompt → preToolUse → postToolUse →
  // afterAgentResponse → stop → sessionEnd
  //
  // Cursor-native: conversation_id + generation_id, no session_id on most events
  const hookNames = [
    "hooks/session-start.json",
    "hooks/before-submit-prompt.json",
    "hooks/pre-tool-use.json",
    "hooks/post-tool-use.json",
    "hooks/after-agent-response.json",
    "hooks/stop.json",
    "hooks/session-end.json",
  ] as const;

  for (const name of hookNames) {
    const payload = loadFixture(name);
    const { exitCode, stderr } = runHook(payload, sharedEnv);
    assert.equal(
      exitCode,
      0,
      `hook ${String(payload["hook_event_name"])} exited ${exitCode}. stderr: ${stderr.slice(0, 500)}`,
    );
  }

  // ── DB assertions ─────────────────────────────────────────────────────────
  assert.ok(fs.existsSync(sharedDbPath), "events.db should exist after session");

  const counts = queryCounts(sharedDbPath);
  assert.equal(counts.harnesses, 1, "should have exactly 1 harness row for cursor");
  assert.equal(counts.sessions, 1, "should have exactly 1 session row");
  assert.ok(counts.turns >= 1, `should have >= 1 turn, got ${counts.turns}`);
  assert.ok(counts.toolCalls >= 1, `should have >= 1 tool_call, got ${counts.toolCalls}`);
  assert.equal(counts.llmMessages, 1, "should have exactly 1 llm_message (afterAgentResponse)");

  // Verify the LLM message has the canonical Cursor message id
  const db = new DatabaseSync(sharedDbPath);
  db.exec("PRAGMA query_only = 1");
  const msgRow = db.prepare(
    `SELECT harness_message_id, cost_source, cost_total_micros
     FROM llm_messages WHERE harness_id='cursor' LIMIT 1`,
  ).get() as { harness_message_id: string; cost_source: string; cost_total_micros: number } | null;
  assert.ok(msgRow !== null, "should have an llm_message row");
  assert.equal(
    msgRow?.harness_message_id,
    "cursor:cursor-conv-001:cursor-gen-001:assistant",
    "harness_message_id should use Cursor canonical form",
  );
  assert.equal(msgRow?.cost_source, "unknown", "placeholder should have cost_source = unknown");
  assert.equal(msgRow?.cost_total_micros, 0, "placeholder should have zero cost");

  // Verify cost integrity constraint: total = sum of breakdown columns
  const badCost = db.prepare(
    `SELECT count(*) as n FROM llm_messages
     WHERE cost_total_micros !=
       cost_input_micros + cost_output_micros +
       cost_cache_read_micros + cost_cache_write_micros`,
  ).get() as { n: number };
  db.close();
  assert.equal(badCost.n, 0, "all llm_message rows must satisfy cost constraint");

  // Verify session state file was deleted after sessionEnd
  const stateDir = path.join(xdgStateHome, "token-tally", "cursor");
  const stateFile = path.join(stateDir, "cursor-conv-001.json");
  assert.ok(
    !fs.existsSync(stateFile),
    "session state file should be deleted after sessionEnd",
  );
});

// ---------------------------------------------------------------------------
// Test 2: Idempotency
// ---------------------------------------------------------------------------

test("idempotency: replaying all hooks produces no new rows", async () => {
  assert.ok(sharedTmpDir, "sharedTmpDir not set — lifecycle test must run first");

  const countsBefore = queryCounts(sharedDbPath);

  const hookNames = [
    "hooks/session-start.json",
    "hooks/before-submit-prompt.json",
    "hooks/pre-tool-use.json",
    "hooks/post-tool-use.json",
    "hooks/after-agent-response.json",
    "hooks/stop.json",
    "hooks/session-end.json",
  ] as const;

  for (const name of hookNames) {
    const payload = loadFixture(name);
    const { exitCode, stderr } = runHook(payload, sharedEnv);
    assert.equal(
      exitCode,
      0,
      `replay hook ${String(payload["hook_event_name"])} exited ${exitCode}. stderr: ${stderr.slice(0, 500)}`,
    );
  }

  const countsAfter = queryCounts(sharedDbPath);
  assert.equal(countsAfter.harnesses, countsBefore.harnesses, "harnesses must not change on replay");
  assert.equal(countsAfter.sessions, countsBefore.sessions, "sessions must not change on replay");
  assert.equal(countsAfter.turns, countsBefore.turns, "turns must not change on replay");
  assert.equal(countsAfter.toolCalls, countsBefore.toolCalls, "tool_calls must not change on replay");
  assert.equal(countsAfter.llmMessages, countsBefore.llmMessages, "llm_messages must not change on replay");

  fs.rmSync(sharedTmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test 3: Missing conversation_id — graceful skip
// ---------------------------------------------------------------------------

test("missing conversation_id: hook exits 0 and skips recording", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-cursor-noid-"));
  const env = {
    XDG_DATA_HOME: path.join(tmpDir, "data"),
    XDG_STATE_HOME: path.join(tmpDir, "state"),
    XDG_CONFIG_HOME: path.join(tmpDir, "config"),
  };

  const payload = { hook_event_name: "beforeSubmitPrompt", generation_id: "gen-xyz" };
  const { exitCode } = runHook(payload, env);
  assert.equal(exitCode, 0, "hook must exit 0 even when conversation_id is missing");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test 4: Unknown event name — graceful skip
// ---------------------------------------------------------------------------

test("unknown hook_event_name: hook exits 0 with a warning", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-cursor-unknown-"));
  const env = {
    XDG_DATA_HOME: path.join(tmpDir, "data"),
    XDG_STATE_HOME: path.join(tmpDir, "state"),
    XDG_CONFIG_HOME: path.join(tmpDir, "config"),
  };

  const payload = {
    hook_event_name: "futureUnknownEvent",
    conversation_id: "conv-unknown",
    generation_id: "gen-unknown",
  };
  const { exitCode } = runHook(payload, env);
  assert.equal(exitCode, 0, "hook must exit 0 for unknown events");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test 5: postToolUseFailure records isError = true
// ---------------------------------------------------------------------------

test("postToolUseFailure: tool call recorded with is_error = 1", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-cursor-failure-"));
  const xdgDataHome = path.join(tmpDir, "data");
  const xdgStateHome = path.join(tmpDir, "state");
  const env = {
    XDG_DATA_HOME: xdgDataHome,
    XDG_STATE_HOME: xdgStateHome,
    XDG_CONFIG_HOME: path.join(tmpDir, "config"),
  };

  // Start a session, open a turn, buffer a tool, then fail it
  for (const name of [
    "hooks/session-start.json",
    "hooks/before-submit-prompt.json",
  ]) {
    const payload = loadFixture(name);
    const { exitCode } = runHook(payload, env);
    assert.equal(exitCode, 0);
  }

  // Buffer a tool with tool-002 id (matches post-tool-use-failure fixture)
  const preFail = {
    ...loadFixture("hooks/pre-tool-use.json"),
    tool_use_id: "cursor-tool-002",
  };
  runHook(preFail, env);

  // Report failure
  const failPayload = loadFixture("hooks/post-tool-use-failure.json");
  const { exitCode } = runHook(failPayload, env);
  assert.equal(exitCode, 0);

  const dbPath = path.join(xdgDataHome, "token-tally", "events.db");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA query_only = 1");
  const row = db.prepare(
    `SELECT is_error FROM tool_calls
     WHERE harness_id='cursor' AND harness_tool_call_id='cursor-tool-002'`,
  ).get() as { is_error: number } | null;
  db.close();

  assert.ok(row !== null, "tool_calls row for cursor-tool-002 should exist");
  assert.equal(row?.is_error, 1, "failed tool call should have is_error = 1");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
