/**
 * main-dispatch.test.ts — End-to-end integration test for the Claude Code writer.
 *
 * Pipes real hook payloads into the compiled binary (dist/bin/token-tally-claude-hook.js)
 * against an isolated temp DB, then inspects the resulting SQLite database to assert
 * that the full session lifecycle writes the expected rows and that replaying the same
 * sequence is fully idempotent.
 *
 * Uses:
 *   - node:sqlite (DatabaseSync) — Node 24 built-in, no native addon needed
 *   - spawnSync — synchronous subprocess per hook (matches how Claude Code calls us)
 *   - Isolated XDG_DATA_HOME / XDG_STATE_HOME — never touches the real DB
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
// Package root  = dist/tests/../../  = <package-root>/
// Source fixtures live in <package-root>/tests/fixtures/ (not copied to dist)
const PACKAGE_ROOT = path.join(__dirname, "..", "..");
const FIXTURES_DIR = path.join(PACKAGE_ROOT, "tests", "fixtures");
const BINARY = path.join(__dirname, "..", "bin", "token-tally-claude-hook.js");

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

/** Patch `transcript_path` into a hook payload (it's a placeholder in the fixture). */
function withTranscript(
  payload: Record<string, unknown>,
  transcriptPath: string,
): Record<string, unknown> {
  return { ...payload, transcript_path: transcriptPath };
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
  // Matches the store's reader recommendations: query_only prevents accidental writes
  // while still allowing WAL sidecar access (unlike mode=ro).
  db.exec("PRAGMA query_only = 1");
  const n = (sql: string): number => {
    const row = db.prepare(sql).get() as { n: number } | null;
    return row?.n ?? 0;
  };
  const counts: Counts = {
    harnesses: n("SELECT count(*) as n FROM harnesses WHERE name='claude-code'"),
    sessions: n("SELECT count(*) as n FROM sessions WHERE harness_id='claude-code'"),
    turns: n("SELECT count(*) as n FROM turns WHERE harness_id='claude-code'"),
    toolCalls: n("SELECT count(*) as n FROM tool_calls WHERE harness_id='claude-code'"),
    llmMessages: n("SELECT count(*) as n FROM llm_messages WHERE harness_id='claude-code'"),
  };
  db.close();
  return counts;
}

// ---------------------------------------------------------------------------
// Shared state between the two sequential tests
// ---------------------------------------------------------------------------

// Node's built-in test runner runs top-level tests sequentially, so it is
// safe to share mutable variables set by the first test and read by the second.
let sharedTmpDir = "";
let sharedDbPath = "";
let sharedTranscriptPath = "";
let sharedEnv: Record<string, string> = {};

// ---------------------------------------------------------------------------
// Test 1: Full session lifecycle
// ---------------------------------------------------------------------------

test("full session lifecycle", async () => {
  // ── Temp environment ──────────────────────────────────────────────────────
  sharedTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-cc-integration-"));
  const xdgDataHome = path.join(sharedTmpDir, "data");
  const xdgStateHome = path.join(sharedTmpDir, "state");
  fs.mkdirSync(xdgDataHome, { recursive: true });
  fs.mkdirSync(xdgStateHome, { recursive: true });

  sharedDbPath = path.join(xdgDataHome, "token-tally", "events.db");
  sharedEnv = { XDG_DATA_HOME: xdgDataHome, XDG_STATE_HOME: xdgStateHome };

  // Copy transcript fixture so the hook process can read it
  sharedTranscriptPath = path.join(sharedTmpDir, "transcript.jsonl");
  fs.copyFileSync(
    path.join(FIXTURES_DIR, "transcript-basic.jsonl"),
    sharedTranscriptPath,
  );

  // ── Build hook sequence ───────────────────────────────────────────────────
  // SessionStart → UserPromptSubmit → PreToolUse → PostToolUse → Stop → SessionEnd
  // This covers: 1 session, 1 turn, 1 tool call, 2 llm_messages (both
  // assistant entries in transcript-basic.jsonl are drained by PostToolUse).
  const hookNames = [
    "hooks/session-start.json",
    "hooks/user-prompt-submit.json",
    "hooks/pre-tool-use.json",
    "hooks/post-tool-use.json",
    "hooks/stop.json",
    "hooks/session-end.json",
  ] as const;

  for (const name of hookNames) {
    const payload = withTranscript(loadFixture(name), sharedTranscriptPath);
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
  assert.equal(counts.harnesses, 1, "should have exactly 1 harness row for claude-code");
  assert.equal(counts.sessions, 1, "should have exactly 1 session row");
  assert.ok(counts.turns >= 1, `should have >= 1 turn, got ${counts.turns}`);
  assert.ok(counts.toolCalls >= 1, `should have >= 1 tool_call, got ${counts.toolCalls}`);
  assert.ok(counts.llmMessages >= 1, `should have >= 1 llm_message, got ${counts.llmMessages}`);

  // cost_total_micros must equal the sum of the four breakdown columns
  // (the schema enforces this with a CHECK constraint; we verify it here too)
  const db = new DatabaseSync(sharedDbPath);
  db.exec("PRAGMA query_only = 1");
  const badCost = db.prepare(
    `SELECT count(*) as n FROM llm_messages
     WHERE cost_total_micros !=
       cost_input_micros + cost_output_micros +
       cost_cache_read_micros + cost_cache_write_micros`,
  ).get() as { n: number };
  db.close();
  assert.equal(
    badCost.n,
    0,
    "all llm_message rows must satisfy cost_total_micros == sum of breakdown columns",
  );

  // ── State file cleanup ────────────────────────────────────────────────────
  const stateFile = path.join(
    xdgStateHome,
    "token-tally",
    "claude-code",
    "test-session-001.json",
  );
  assert.ok(
    !fs.existsSync(stateFile),
    "session state file should be deleted after SessionEnd",
  );
});

// ---------------------------------------------------------------------------
// Test 2: Idempotency — replaying all hooks must not create new rows
// ---------------------------------------------------------------------------

test("idempotency: replaying all hooks produces no new rows", async () => {
  assert.ok(sharedTmpDir, "shared tmpDir not set — lifecycle test must run first");

  const countsBefore = queryCounts(sharedDbPath);

  // Replay the exact same hook sequence
  const hookNames = [
    "hooks/session-start.json",
    "hooks/user-prompt-submit.json",
    "hooks/pre-tool-use.json",
    "hooks/post-tool-use.json",
    "hooks/stop.json",
    "hooks/session-end.json",
  ] as const;

  for (const name of hookNames) {
    const payload = withTranscript(loadFixture(name), sharedTranscriptPath);
    const { exitCode, stderr } = runHook(payload, sharedEnv);
    assert.equal(
      exitCode,
      0,
      `replay hook ${String(payload["hook_event_name"])} exited ${exitCode}. stderr: ${stderr.slice(0, 500)}`,
    );
  }

  const countsAfter = queryCounts(sharedDbPath);

  assert.equal(
    countsAfter.harnesses,
    countsBefore.harnesses,
    "harnesses count must not change on replay",
  );
  assert.equal(
    countsAfter.sessions,
    countsBefore.sessions,
    "sessions count must not change on replay",
  );
  assert.equal(
    countsAfter.turns,
    countsBefore.turns,
    "turns count must not change on replay",
  );
  assert.equal(
    countsAfter.toolCalls,
    countsBefore.toolCalls,
    "tool_calls count must not change on replay",
  );
  assert.equal(
    countsAfter.llmMessages,
    countsBefore.llmMessages,
    "llm_messages count must not change on replay",
  );

  // Clean up temp dir
  fs.rmSync(sharedTmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test 3: Spool isolation — extra closed spool files are not drained by hooks
// ---------------------------------------------------------------------------

test("spool isolation: hook invocations do not drain pre-existing closed spool files", async () => {
  // This test proves the drain: {} semantics are in effect for hot-path hooks.
  // Extra closed spool files in the spool directory must survive the full
  // hook sequence intact. The drain daemon (T6) owns full-directory drain.

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-cc-spool-isolation-"));
  const xdgDataHome = path.join(tmpDir, "data");
  const xdgStateHome = path.join(tmpDir, "state");
  fs.mkdirSync(xdgDataHome, { recursive: true });
  fs.mkdirSync(xdgStateHome, { recursive: true });

  const spoolDir = path.join(xdgDataHome, "token-tally", "spool");
  fs.mkdirSync(spoolDir, { recursive: true });

  const env = { XDG_DATA_HOME: xdgDataHome, XDG_STATE_HOME: xdgStateHome };

  // Plant three synthetic closed spool files that would fail ingest
  // (they contain valid JSON but reference non-existent parent rows).
  // If the hook drains the spool directory, it would attempt these files
  // and likely delete or quarantine them. We assert they survive untouched.
  const spoolFileNames = [
    "claude-code-99001-1700000000001-1700000000002.ndjson.closed",
    "claude-code-99002-1700000000003-1700000000004.ndjson.closed",
    "claude-code-99003-1700000000005-1700000000006.ndjson.closed",
  ];
  for (const name of spoolFileNames) {
    fs.writeFileSync(
      path.join(spoolDir, name),
      JSON.stringify({
        type: "llm-message",
        payload: {
          harnessId: "claude-code",
          sessionId: "spool:claude-code:orphan-session",
          turnId: "spool:spool:claude-code:orphan-session:orphan-turn",
          harnessMessageId: "orphan-msg-1",
          ts: 1700000000000,
        },
      }) + "\n",
      "utf8",
    );
  }

  // Run a minimal hook sequence (just SessionStart) — enough to open and
  // close a writer, which is the point where drain could occur.
  const transcriptPath = path.join(tmpDir, "transcript.jsonl");
  fs.copyFileSync(
    path.join(FIXTURES_DIR, "transcript-basic.jsonl"),
    transcriptPath,
  );
  const startPayload = withTranscript(loadFixture("hooks/session-start.json"), transcriptPath);
  const { exitCode, stderr } = runHook(startPayload, env);
  assert.equal(exitCode, 0, `SessionStart hook failed: ${stderr.slice(0, 400)}`);

  // All three pre-planted closed files must still be present.
  for (const name of spoolFileNames) {
    assert.ok(
      fs.existsSync(path.join(spoolDir, name)),
      `pre-planted spool file should not be touched by hot-path hook: ${name}`,
    );
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
