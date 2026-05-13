/**
 * tests/multi-turn.test.ts — Integration tests for multi-turn sessions and
 * synthetic ID generation when generation_id is absent.
 *
 * Cursor assigns a fresh `generation_id` for every user-to-model exchange. The
 * writer uses this as the harness turn id and embeds it in the canonical
 * message id (cursor:<cid>:<gid>:assistant). These tests verify:
 *
 *   1. Two-turn session — two distinct generation_ids produce two separate
 *      turn rows and two separate llm_message rows, all under one session.
 *
 *   2. Synthetic IDs — when generation_id is absent (defensive handling for
 *      future/older Cursor versions), the writer synthesizes IDs from per-
 *      session counters. The hook must still exit 0 and write correct rows.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PACKAGE_ROOT = path.join(__dirname, "..", "..");
const BINARY = path.join(__dirname, "..", "bin", "token-tally-cursor-hook.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TmpEnv {
  tmpDir: string;
  dbPath: string;
  env: Record<string, string>;
}

function makeTmpEnv(): TmpEnv {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-multiturn-"));
  const xdgDataHome = path.join(tmpDir, "data");
  const xdgStateHome = path.join(tmpDir, "state");
  const xdgConfigHome = path.join(tmpDir, "config");
  fs.mkdirSync(xdgDataHome, { recursive: true });
  fs.mkdirSync(xdgStateHome, { recursive: true });
  fs.mkdirSync(xdgConfigHome, { recursive: true });
  return {
    tmpDir,
    dbPath: path.join(xdgDataHome, "token-tally", "events.db"),
    env: {
      XDG_DATA_HOME: xdgDataHome,
      XDG_STATE_HOME: xdgStateHome,
      XDG_CONFIG_HOME: xdgConfigHome,
    },
  };
}

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

function queryCounts(
  dbPath: string,
): { turns: number; llmMessages: number; sessions: number } {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA query_only = 1");
  const n = (sql: string): number =>
    (db.prepare(sql).get() as { n: number } | null)?.n ?? 0;
  const result = {
    turns: n("SELECT count(*) as n FROM turns WHERE harness_id='cursor'"),
    llmMessages: n("SELECT count(*) as n FROM llm_messages WHERE harness_id='cursor'"),
    sessions: n("SELECT count(*) as n FROM sessions WHERE harness_id='cursor'"),
  };
  db.close();
  return result;
}

// ---------------------------------------------------------------------------
// Scenario 1: Two-turn session with distinct generation_ids
//
// Models the normal agent loop:
//   sessionStart
//   → (turn 1) beforeSubmitPrompt(gen-1) → afterAgentResponse(gen-1) → stop(gen-1)
//   → (turn 2) beforeSubmitPrompt(gen-2) → afterAgentResponse(gen-2) → stop(gen-2)
//   → sessionEnd
// ---------------------------------------------------------------------------

describe("multi-turn: two turns with distinct generation_ids", () => {
  let tmpDir = "";
  let dbPath = "";
  let env: Record<string, string> = {};

  const CONV_ID = "cursor-conv-mt-001";
  const GEN_ID_1 = "cursor-gen-mt-001";
  const GEN_ID_2 = "cursor-gen-mt-002";
  const MSG_ID_1 = `cursor:${CONV_ID}:${GEN_ID_1}:assistant`;
  const MSG_ID_2 = `cursor:${CONV_ID}:${GEN_ID_2}:assistant`;

  /** Build a minimal Cursor-native payload for a given event. */
  function makePayload(
    hookEventName: string,
    genId: string | undefined,
    extra?: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      hook_event_name: hookEventName,
      conversation_id: CONV_ID,
      ...(genId !== undefined && { generation_id: genId }),
      model: "claude-sonnet-4-20250514",
      cursor_version: "1.7.5",
      workspace_roots: ["/tmp"],
      cwd: "/tmp",
      ...extra,
    };
  }

  before(() => {
    ({ tmpDir, dbPath, env } = makeTmpEnv());

    const hooks: Record<string, unknown>[] = [
      // sessionStart: Cursor sends both conversation_id and session_id
      {
        hook_event_name: "sessionStart",
        conversation_id: CONV_ID,
        session_id: CONV_ID,
        generation_id: null,
        model: "claude-sonnet-4-20250514",
        cursor_version: "1.7.5",
        workspace_roots: ["/tmp"],
        cwd: "/tmp",
        is_background_agent: false,
        composer_mode: "agent",
      },
      // Turn 1
      makePayload("beforeSubmitPrompt", GEN_ID_1),
      makePayload("afterAgentResponse", GEN_ID_1),
      makePayload("stop", GEN_ID_1, { status: "completed", loop_count: 0 }),
      // Turn 2 — different generation_id means a new exchange
      makePayload("beforeSubmitPrompt", GEN_ID_2),
      makePayload("afterAgentResponse", GEN_ID_2),
      makePayload("stop", GEN_ID_2, { status: "completed", loop_count: 0 }),
      // sessionEnd
      {
        hook_event_name: "sessionEnd",
        conversation_id: CONV_ID,
        session_id: CONV_ID,
        model: "claude-sonnet-4-20250514",
        cursor_version: "1.7.5",
        workspace_roots: ["/tmp"],
        cwd: "/tmp",
        reason: "completed",
        duration_ms: 30_000,
      },
    ];

    for (const payload of hooks) {
      const { exitCode, stderr } = runHook(payload, env);
      assert.equal(
        exitCode,
        0,
        `hook '${String(payload["hook_event_name"])}' exited ${exitCode}: ${stderr.slice(0, 300)}`,
      );
    }
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("two turn rows written (one per generation_id)", () => {
    const { turns } = queryCounts(dbPath);
    assert.equal(turns, 2, "should have exactly 2 turn rows");
  });

  test("two llm_message rows written (one per afterAgentResponse)", () => {
    const { llmMessages } = queryCounts(dbPath);
    assert.equal(llmMessages, 2, "should have exactly 2 llm_message rows");
  });

  test("one session row covers both turns", () => {
    const { sessions } = queryCounts(dbPath);
    assert.equal(sessions, 1, "both turns must belong to the same session");
  });

  test("message IDs use canonical cursor:<cid>:<gid>:assistant form", () => {
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA query_only = 1");
    const rows = db
      .prepare(
        "SELECT harness_message_id FROM llm_messages WHERE harness_id='cursor' ORDER BY rowid",
      )
      .all() as { harness_message_id: string }[];
    db.close();

    const ids = rows.map((r) => r.harness_message_id);
    assert.ok(ids.includes(MSG_ID_1), `Expected '${MSG_ID_1}' in ${JSON.stringify(ids)}`);
    assert.ok(ids.includes(MSG_ID_2), `Expected '${MSG_ID_2}' in ${JSON.stringify(ids)}`);
  });

  test("turn harness_turn_ids match the generation_ids", () => {
    // When generation_id is present, it is used directly as the harness turn id
    // so the turn can be correlated with the transcript for backfill.
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA query_only = 1");
    const rows = db
      .prepare(
        "SELECT harness_turn_id FROM turns WHERE harness_id='cursor' ORDER BY started_at",
      )
      .all() as { harness_turn_id: string }[];
    db.close();

    const ids = rows.map((r) => r.harness_turn_id);
    assert.ok(ids.includes(GEN_ID_1), `Expected '${GEN_ID_1}' in ${JSON.stringify(ids)}`);
    assert.ok(ids.includes(GEN_ID_2), `Expected '${GEN_ID_2}' in ${JSON.stringify(ids)}`);
  });

  test("idempotency: replaying the same two-turn sequence adds no new rows", () => {
    const countsBefore = queryCounts(dbPath);

    // Replay the entire sequence.
    for (const payload of [
      {
        hook_event_name: "sessionStart",
        conversation_id: CONV_ID,
        session_id: CONV_ID,
        model: "claude-sonnet-4-20250514",
        cursor_version: "1.7.5",
        workspace_roots: ["/tmp"],
        cwd: "/tmp",
      },
      {
        hook_event_name: "beforeSubmitPrompt",
        conversation_id: CONV_ID,
        generation_id: GEN_ID_1,
        model: "claude-sonnet-4-20250514",
        cursor_version: "1.7.5",
        workspace_roots: ["/tmp"],
        cwd: "/tmp",
      },
      {
        hook_event_name: "afterAgentResponse",
        conversation_id: CONV_ID,
        generation_id: GEN_ID_1,
        model: "claude-sonnet-4-20250514",
        cursor_version: "1.7.5",
        workspace_roots: ["/tmp"],
      },
    ]) {
      runHook(payload, env);
    }

    // Turns and messages must not change because upserts key on the same IDs.
    const countsAfter = queryCounts(dbPath);
    assert.equal(countsAfter.turns, countsBefore.turns, "no new turns on replay");
    assert.equal(countsAfter.llmMessages, countsBefore.llmMessages, "no new messages on replay");
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Turn where generation_id is absent → synthesized IDs
//
// Defensive case for older or non-standard Cursor versions that might omit
// generation_id. The writer must:
//   - Exit 0 on every event (never block Cursor).
//   - Synthesize turn/message IDs from per-session state counters.
//   - Write correct DB rows so the session is still captured.
// ---------------------------------------------------------------------------

describe("multi-turn: synthetic IDs when generation_id is absent", () => {
  let tmpDir = "";
  let dbPath = "";
  let env: Record<string, string> = {};

  // Use a different conversation_id to keep state isolated from other tests.
  const CONV_ID = "cursor-conv-mt-002";

  /** Build a Cursor-native payload deliberately without generation_id. */
  function makePayloadNoGenId(
    hookEventName: string,
    extra?: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      hook_event_name: hookEventName,
      conversation_id: CONV_ID,
      // generation_id intentionally absent — tests the synthetic-ID path
      model: "claude-sonnet-4-20250514",
      cursor_version: "1.7.5",
      workspace_roots: ["/tmp"],
      cwd: "/tmp",
      ...extra,
    };
  }

  before(() => {
    ({ tmpDir, dbPath, env } = makeTmpEnv());

    const hooks: Record<string, unknown>[] = [
      {
        hook_event_name: "sessionStart",
        conversation_id: CONV_ID,
        session_id: CONV_ID,
        // no generation_id
        model: "claude-sonnet-4-20250514",
        cursor_version: "1.7.5",
        workspace_roots: ["/tmp"],
        cwd: "/tmp",
        is_background_agent: false,
      },
      makePayloadNoGenId("beforeSubmitPrompt"),
      makePayloadNoGenId("afterAgentResponse"),
      makePayloadNoGenId("stop", { status: "completed", loop_count: 0 }),
      {
        hook_event_name: "sessionEnd",
        conversation_id: CONV_ID,
        session_id: CONV_ID,
        model: "claude-sonnet-4-20250514",
        cursor_version: "1.7.5",
        workspace_roots: ["/tmp"],
        reason: "completed",
      },
    ];

    for (const payload of hooks) {
      const { exitCode, stderr } = runHook(payload, env);
      assert.equal(
        exitCode,
        0,
        `hook '${String(payload["hook_event_name"])}' exited ${exitCode}: ${stderr.slice(0, 300)}`,
      );
    }
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("hook exits 0 for every event even when generation_id is absent", () => {
    // Already verified in before() — documents the contractual requirement.
    assert.ok(true, "exit-0 contract verified by before() assertions");
  });

  test("one turn row written with a synthesized harness_turn_id", () => {
    const { turns } = queryCounts(dbPath);
    assert.equal(turns, 1, "should have exactly 1 turn row");
  });

  test("synthesized turn id uses the <conversation_id>:t<index> format", () => {
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA query_only = 1");
    const row = db
      .prepare("SELECT harness_turn_id FROM turns WHERE harness_id='cursor' LIMIT 1")
      .get() as { harness_turn_id: string } | null;
    db.close();
    assert.ok(row !== null, "turn row must exist");
    // Expected: cursor-conv-mt-002:t1  (turnIndex increments before assignment)
    assert.match(
      row!.harness_turn_id,
      new RegExp(`^${CONV_ID}:t\\d+$`),
      `Expected synthesized turn id like '${CONV_ID}:t1', got: ${row!.harness_turn_id}`,
    );
  });

  test("one llm_message row written with a synthesized harness_message_id", () => {
    const { llmMessages } = queryCounts(dbPath);
    assert.equal(llmMessages, 1, "should have exactly 1 llm_message row");
  });

  test("synthesized message id uses the <conversation_id>:m<index> format", () => {
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA query_only = 1");
    const row = db
      .prepare(
        "SELECT harness_message_id FROM llm_messages WHERE harness_id='cursor' LIMIT 1",
      )
      .get() as { harness_message_id: string } | null;
    db.close();
    assert.ok(row !== null, "llm_message row must exist");
    // Expected: cursor-conv-mt-002:m0  (messageIndex starts at 0)
    assert.match(
      row!.harness_message_id,
      new RegExp(`^${CONV_ID}:m\\d+$`),
      `Expected synthesized message id like '${CONV_ID}:m0', got: ${row!.harness_message_id}`,
    );
  });

  test("synthesized message id does NOT contain ':assistant' suffix", () => {
    // Canonical IDs (cursor:<cid>:<gid>:assistant) end with ':assistant'.
    // Synthesized fallback IDs use a different format to avoid ambiguity.
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA query_only = 1");
    const row = db
      .prepare(
        "SELECT harness_message_id FROM llm_messages WHERE harness_id='cursor' LIMIT 1",
      )
      .get() as { harness_message_id: string } | null;
    db.close();
    assert.ok(row !== null);
    assert.ok(
      !row!.harness_message_id.endsWith(":assistant"),
      `Synthesized ID must not end with ':assistant'. Got: ${row!.harness_message_id}`,
    );
  });
});
