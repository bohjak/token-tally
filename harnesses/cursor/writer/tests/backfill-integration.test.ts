/**
 * tests/backfill-integration.test.ts — End-to-end integration tests for the
 * token/cost backfill pipeline triggered by the stop and subagentStop hooks.
 *
 * These tests pipe real hook payloads into the compiled binary (spawnSync)
 * against an isolated temp DB and assert on the resulting SQLite rows. This
 * catches integration issues that unit tests cannot, such as:
 *   - The backfill modules wiring into the stop handler correctly.
 *   - Placeholder rows created by afterAgentResponse being upserted by stop.
 *   - SQLite fallback firing when transcript_path is absent.
 *   - drained=true preventing double-backfill when stop fires twice.
 *   - subagentStop draining its own agent_transcript_path.
 *
 * Test structure mirrors main.test.ts for consistency.
 */

import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PACKAGE_ROOT = path.join(__dirname, "..", "..");
const BINARY = path.join(__dirname, "..", "bin", "token-tally-cursor-hook.js");
const FIXTURES_DIR = path.join(PACKAGE_ROOT, "tests", "fixtures");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpEnv(): {
  tmpDir: string;
  xdgDataHome: string;
  xdgStateHome: string;
  xdgConfigHome: string;
  dbPath: string;
  env: Record<string, string>;
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-backfill-"));
  const xdgDataHome = path.join(tmpDir, "data");
  const xdgStateHome = path.join(tmpDir, "state");
  const xdgConfigHome = path.join(tmpDir, "config");
  fs.mkdirSync(xdgDataHome, { recursive: true });
  fs.mkdirSync(xdgStateHome, { recursive: true });
  fs.mkdirSync(xdgConfigHome, { recursive: true });
  const dbPath = path.join(xdgDataHome, "token-tally", "events.db");
  return {
    tmpDir,
    xdgDataHome,
    xdgStateHome,
    xdgConfigHome,
    dbPath,
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

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8"),
  ) as Record<string, unknown>;
}

/** Write a JSONL transcript file. */
async function writeTranscript(filePath: string, entries: object[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf8",
  );
}

/** Query the single llm_message row for a given harness_message_id. */
function readMessageRow(dbPath: string, harnessMessageId: string): {
  cost_source: string;
  cost_total_micros: number;
  input_tokens: number;
  output_tokens: number;
  model_id: string | null;
} | null {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA query_only = 1");
  const row = db
    .prepare(
      `SELECT cost_source, cost_total_micros, input_tokens, output_tokens, model_id
       FROM llm_messages WHERE harness_message_id = ?`,
    )
    .get(harnessMessageId) as {
    cost_source: string;
    cost_total_micros: number;
    input_tokens: number;
    output_tokens: number;
    model_id: string | null;
  } | null;
  db.close();
  return row;
}

function countRows(dbPath: string, table: string): number {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA query_only = 1");
  const row = db
    .prepare(`SELECT count(*) as n FROM ${table} WHERE harness_id='cursor'`)
    .get() as { n: number };
  db.close();
  return row.n;
}

// ---------------------------------------------------------------------------
// Test 1: stop fires, transcript provided → placeholder upgraded
//
// Sequence:
//   sessionStart → beforeSubmitPrompt → afterAgentResponse → stop
//   (stop payload includes transcript_path pointing to a known-model JSONL)
// ---------------------------------------------------------------------------

describe("stop hook: backfill from transcript upgrades placeholder", () => {
  let tmpDir = "";
  let dbPath = "";
  let env: Record<string, string> = {};

  // Cursor-native fixture IDs
  const CONV_ID = "cursor-conv-001";
  const GEN_ID = "cursor-gen-001";
  const MSG_ID = `cursor:${CONV_ID}:${GEN_ID}:assistant`;

  before(async () => {
    const e = makeTmpEnv();
    tmpDir = e.tmpDir;
    dbPath = e.dbPath;
    env = e.env;

    // Write a transcript that the stop hook will read.
    const transcriptPath = path.join(tmpDir, "transcript.jsonl");
    await writeTranscript(transcriptPath, [
      {
        role: "assistant",
        id: GEN_ID,
        model: "claude-sonnet-4-20250514",
        usage: { input_tokens: 1000, output_tokens: 500 },
      },
    ]);

    // Run the session up to afterAgentResponse (placeholder written here).
    const setup = [
      "hooks/session-start.json",
      "hooks/before-submit-prompt.json",
      "hooks/after-agent-response.json",
    ];
    for (const name of setup) {
      const result = runHook(loadFixture(name), env);
      assert.equal(
        result.exitCode,
        0,
        `setup hook ${name} exited ${result.exitCode}: ${result.stderr.slice(0, 200)}`,
      );
    }

    // Assert placeholder row exists with unknown cost before stop.
    const placeholder = readMessageRow(dbPath, MSG_ID);
    assert.ok(placeholder !== null, "placeholder should exist after afterAgentResponse");
    assert.equal(placeholder?.cost_source, "unknown", "placeholder should be unknown");

    // Run stop with transcript_path pointing to our temp file.
    const stopPayload = {
      ...loadFixture("hooks/stop.json"),
      transcript_path: transcriptPath,
    };
    const stopResult = runHook(stopPayload, env);
    assert.equal(
      stopResult.exitCode,
      0,
      `stop hook exited ${stopResult.exitCode}: ${stopResult.stderr.slice(0, 200)}`,
    );
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("placeholder upgraded to writer cost after stop with transcript", () => {
    const row = readMessageRow(dbPath, MSG_ID);
    assert.ok(row !== null, "llm_message row must exist");
    assert.equal(row?.cost_source, "writer", "should be upgraded to writer");
    assert.equal(row?.input_tokens, 1000, "input tokens backfilled");
    assert.equal(row?.output_tokens, 500, "output tokens backfilled");
    assert.ok(row.cost_total_micros > 0, "cost_total_micros must be non-zero");
    assert.equal(row?.model_id, "claude-sonnet-4-20250514", "model_id stored");
  });

  test("no duplicate llm_message rows after stop", () => {
    assert.equal(countRows(dbPath, "llm_messages"), 1, "exactly 1 llm_message row");
  });
});

// ---------------------------------------------------------------------------
// Test 2: stop fires without transcript → placeholder stays unknown
// ---------------------------------------------------------------------------

describe("stop hook: no transcript → placeholder unchanged", () => {
  let tmpDir = "";
  let dbPath = "";
  let env: Record<string, string> = {};

  const CONV_ID = "cursor-conv-001";
  const GEN_ID = "cursor-gen-001";
  const MSG_ID = `cursor:${CONV_ID}:${GEN_ID}:assistant`;

  before(() => {
    const e = makeTmpEnv();
    tmpDir = e.tmpDir;
    dbPath = e.dbPath;
    env = e.env;

    const hooks = [
      "hooks/session-start.json",
      "hooks/before-submit-prompt.json",
      "hooks/after-agent-response.json",
      "hooks/stop.json", // no transcript_path
    ];
    for (const name of hooks) {
      const result = runHook(loadFixture(name), env);
      assert.equal(
        result.exitCode,
        0,
        `hook ${name} exited ${result.exitCode}: ${result.stderr.slice(0, 200)}`,
      );
    }
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("cost_source remains unknown when no transcript or sqlite data", () => {
    const row = readMessageRow(dbPath, MSG_ID);
    assert.ok(row !== null, "row must exist");
    assert.equal(row?.cost_source, "unknown", "should remain unknown");
    assert.equal(row?.input_tokens, 0, "tokens remain 0");
    assert.equal(row?.cost_total_micros, 0, "cost remains 0");
  });
});

// ---------------------------------------------------------------------------
// Test 3: drained flag prevents double-backfill
//
// When stop fires a second time (e.g. loop_count = 1), the backfill must not
// create extra rows or overwrite already-backfilled data.
// ---------------------------------------------------------------------------

describe("stop hook: drained flag prevents double-backfill", () => {
  let tmpDir = "";
  let dbPath = "";
  let env: Record<string, string> = {};

  const CONV_ID = "cursor-conv-001";
  const GEN_ID = "cursor-gen-001";
  const MSG_ID = `cursor:${CONV_ID}:${GEN_ID}:assistant`;
  let transcriptPath = "";

  before(async () => {
    const e = makeTmpEnv();
    tmpDir = e.tmpDir;
    dbPath = e.dbPath;
    env = e.env;

    transcriptPath = path.join(tmpDir, "transcript.jsonl");
    await writeTranscript(transcriptPath, [
      {
        role: "assistant",
        id: GEN_ID,
        model: "claude-sonnet-4-20250514",
        usage: { input_tokens: 1000, output_tokens: 500 },
      },
    ]);

    const setup = [
      "hooks/session-start.json",
      "hooks/before-submit-prompt.json",
      "hooks/after-agent-response.json",
    ];
    for (const name of setup) {
      runHook(loadFixture(name), env);
    }

    // First stop — should backfill.
    const stop1 = {
      ...loadFixture("hooks/stop.json"),
      transcript_path: transcriptPath,
    };
    runHook(stop1, env);

    // Second stop (loop_count = 1) — drained flag prevents repeat backfill.
    const stop2 = {
      ...loadFixture("hooks/stop.json"),
      transcript_path: transcriptPath,
      loop_count: 1,
    };
    runHook(stop2, env);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("exactly 1 llm_message row after two stop hooks", () => {
    assert.equal(countRows(dbPath, "llm_messages"), 1, "no duplicate rows");
  });

  test("row has correct backfilled values after two stop hooks", () => {
    const row = readMessageRow(dbPath, MSG_ID);
    assert.ok(row !== null);
    assert.equal(row?.cost_source, "writer");
    assert.equal(row?.input_tokens, 1000);
    assert.ok(row.cost_total_micros > 0);
  });
});

// ---------------------------------------------------------------------------
// Test 4: subagentStop drains agent_transcript_path
// ---------------------------------------------------------------------------

describe("subagentStop hook: backfill from agent_transcript_path", () => {
  let tmpDir = "";
  let dbPath = "";
  let env: Record<string, string> = {};

  const CONV_ID = "cursor-conv-001";

  before(async () => {
    const e = makeTmpEnv();
    tmpDir = e.tmpDir;
    dbPath = e.dbPath;
    env = e.env;

    // Start a session so state exists (subagentStop needs the centralSessionId).
    runHook(loadFixture("hooks/session-start.json"), env);
    runHook(loadFixture("hooks/before-submit-prompt.json"), env);

    // Write a placeholder for a subagent message.
    // The subagent has a different generation_id / bubble than the parent.
    const subGenId = randomUUID();
    const subMsgId = `cursor:${CONV_ID}:${subGenId}:assistant`;

    // We don't have a fixture for a subagent afterAgentResponse — write the
    // placeholder by running afterAgentResponse with a custom generation_id
    // so the canonical message id matches what the subagent transcript will use.
    const afterResponse = {
      ...loadFixture("hooks/after-agent-response.json"),
      generation_id: subGenId,
    };
    runHook(afterResponse, env);

    // Verify placeholder exists.
    const placeholder = readMessageRow(dbPath, subMsgId);
    assert.ok(placeholder !== null, "subagent placeholder should exist");
    assert.equal(placeholder?.cost_source, "unknown");

    // Write a subagent transcript.
    const agentTranscriptPath = path.join(tmpDir, "subagent-transcript.jsonl");
    await writeTranscript(agentTranscriptPath, [
      {
        role: "assistant",
        id: subGenId,
        model: "claude-sonnet-4-20250514",
        usage: { input_tokens: 200, output_tokens: 100 },
      },
    ]);

    // Fire subagentStop with agent_transcript_path.
    const subagentStopPayload = {
      hook_event_name: "subagentStop",
      conversation_id: CONV_ID,
      generation_id: "cursor-gen-001",
      model: "claude-sonnet-4-20250514",
      cursor_version: "1.7.5",
      status: "completed",
      agent_transcript_path: agentTranscriptPath,
    };
    const result = runHook(subagentStopPayload, env);
    assert.equal(
      result.exitCode,
      0,
      `subagentStop exited ${result.exitCode}: ${result.stderr.slice(0, 200)}`,
    );

    // Store subMsgId for assertions.
    // (We use a module-scoped variable trick — use the DB to look it up.)
    // Store it in the test closure via outer scope.
    (env as Record<string, string>)["_subMsgId"] = subMsgId;
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("subagent placeholder upgraded to writer cost", () => {
    const subMsgId = env["_subMsgId"];
    assert.ok(subMsgId, "subMsgId should be set in before()");

    const row = readMessageRow(dbPath, subMsgId);
    assert.ok(row !== null, "subagent llm_message should exist");
    assert.equal(row?.cost_source, "writer", "subagent message should be writer-priced");
    assert.equal(row?.input_tokens, 200, "subagent input tokens backfilled");
    assert.equal(row?.output_tokens, 100, "subagent output tokens backfilled");
    assert.ok(row.cost_total_micros > 0, "subagent cost should be non-zero");
  });
});

// ---------------------------------------------------------------------------
// Test 5: stop with subscription → cost_source=subscription_covered
// ---------------------------------------------------------------------------

describe("stop hook: subscription_covered via hooks.json", () => {
  let tmpDir = "";
  let dbPath = "";
  let env: Record<string, string> = {};
  let transcriptPath = "";

  const CONV_ID = "cursor-conv-001";
  const GEN_ID = "cursor-gen-001";
  const MSG_ID = `cursor:${CONV_ID}:${GEN_ID}:assistant`;

  before(async () => {
    const e = makeTmpEnv();
    tmpDir = e.tmpDir;
    dbPath = e.dbPath;
    env = e.env;

    // Write subscription config.
    const configDir = path.join(e.xdgConfigHome, "token-tally");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({
        harnesses: {
          cursor: {
            subscription: "cursor-pro",
            subscriptionFixedCostUSD: 20,
            subscriptionStartDay: 1,
          },
        },
      }),
      "utf8",
    );

    transcriptPath = path.join(tmpDir, "transcript.jsonl");
    await writeTranscript(transcriptPath, [
      {
        role: "assistant",
        id: GEN_ID,
        model: "claude-sonnet-4-20250514",
        usage: { input_tokens: 1000, output_tokens: 500 },
      },
    ]);

    for (const name of [
      "hooks/session-start.json",
      "hooks/before-submit-prompt.json",
      "hooks/after-agent-response.json",
    ]) {
      runHook(loadFixture(name), env);
    }

    const stopPayload = {
      ...loadFixture("hooks/stop.json"),
      transcript_path: transcriptPath,
    };
    const result = runHook(stopPayload, env);
    assert.equal(
      result.exitCode,
      0,
      `stop exited ${result.exitCode}: ${result.stderr.slice(0, 200)}`,
    );
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("llm_message has cost_source=subscription_covered", () => {
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA query_only = 1");
    const row = db
      .prepare(
        `SELECT cost_source, cost_total_micros, subscription_id
         FROM llm_messages WHERE harness_message_id = ?`,
      )
      .get(MSG_ID) as {
      cost_source: string;
      cost_total_micros: number;
      subscription_id: string | null;
    } | null;
    db.close();

    assert.ok(row !== null, "row must exist");
    assert.equal(row?.cost_source, "subscription_covered");
    // List-price equivalent is still stored.
    assert.ok(row.cost_total_micros > 0, "list-price cost preserved");
    assert.ok(row.subscription_id !== null, "subscription_id FK must be set");
  });
});
