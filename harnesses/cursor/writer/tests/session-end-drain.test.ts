/**
 * tests/session-end-drain.test.ts — Tests for sessionEnd's final backfill.
 *
 * The orchestrator added a final best-effort backfill inside the sessionEnd
 * handler. This covers the case where a session ends abruptly (window close,
 * process kill, aborted agent) without a prior `stop` event. In that path
 * `drained` in the session state is still false, so sessionEnd runs the drain.
 *
 * Two scenarios:
 *
 *   1. stop was NOT fired — sessionEnd drains the transcript and upgrades the
 *      placeholder llm_message from cost_source='unknown' to 'writer'.
 *
 *   2. stop WAS fired first — sessionEnd detects drained=true and skips the
 *      drain. The row should still be 'writer' (set by stop), not regressed.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PACKAGE_ROOT = path.join(__dirname, "..", "..");
const FIXTURES_DIR = path.join(PACKAGE_ROOT, "tests", "fixtures");
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-sessionend-"));
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

function loadFixture(relPath: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(FIXTURES_DIR, relPath), "utf8"),
  ) as Record<string, unknown>;
}

async function writeTranscript(filePath: string, entries: object[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf8",
  );
}

function readMessageRow(
  dbPath: string,
  harnessMessageId: string,
): {
  cost_source: string;
  input_tokens: number;
  output_tokens: number;
  cost_total_micros: number;
} | null {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA query_only = 1");
  const row = db
    .prepare(
      `SELECT cost_source, input_tokens, output_tokens, cost_total_micros
       FROM llm_messages WHERE harness_message_id = ?`,
    )
    .get(harnessMessageId) as {
    cost_source: string;
    input_tokens: number;
    output_tokens: number;
    cost_total_micros: number;
  } | null;
  db.close();
  return row;
}

function countLlmMessages(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA query_only = 1");
  const row = db
    .prepare("SELECT count(*) as n FROM llm_messages WHERE harness_id='cursor'")
    .get() as { n: number };
  db.close();
  return row.n;
}

// ---------------------------------------------------------------------------
// Scenario 1: stop was NOT fired → sessionEnd drains and upgrades
//
// Models an abrupt session end (window close, crash, abort) where Cursor
// fires sessionEnd without a preceding stop event. The state file still
// has drained=false, so the sessionEnd handler must run the backfill.
// ---------------------------------------------------------------------------

describe("sessionEnd: drains when stop was skipped", () => {
  let tmpDir = "";
  let dbPath = "";
  let env: Record<string, string> = {};

  const CONV_ID = "cursor-conv-001";
  const GEN_ID = "cursor-gen-001";
  const MSG_ID = `cursor:${CONV_ID}:${GEN_ID}:assistant`;

  before(async () => {
    ({ tmpDir, dbPath, env } = makeTmpEnv());

    // Write a transcript that sessionEnd will read during its drain.
    const transcriptPath = path.join(tmpDir, "transcript.jsonl");
    await writeTranscript(transcriptPath, [
      {
        role: "assistant",
        id: GEN_ID,
        model: "claude-sonnet-4-20250514",
        usage: { input_tokens: 800, output_tokens: 400 },
      },
    ]);

    // Run up to afterAgentResponse — deliberately DO NOT fire stop.
    for (const name of [
      "hooks/session-start.json",
      "hooks/before-submit-prompt.json",
      "hooks/after-agent-response.json",
    ]) {
      const { exitCode, stderr } = runHook(loadFixture(name), env);
      assert.equal(exitCode, 0, `setup hook ${name} failed: ${stderr.slice(0, 200)}`);
    }

    // Assert placeholder is still 'unknown' (no stop drain has run).
    const placeholder = readMessageRow(dbPath, MSG_ID);
    assert.ok(placeholder !== null, "placeholder must exist after afterAgentResponse");
    assert.equal(
      placeholder?.cost_source,
      "unknown",
      "placeholder must be unknown before sessionEnd (stop was not fired)",
    );

    // Fire sessionEnd with transcript_path. The handler should detect
    // drained=false and run the drain before closing the session.
    const sessionEndPayload = {
      ...loadFixture("hooks/session-end.json"),
      transcript_path: transcriptPath,
    };
    const { exitCode, stderr } = runHook(sessionEndPayload, env);
    assert.equal(exitCode, 0, `sessionEnd failed: ${stderr.slice(0, 200)}`);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("placeholder upgraded to writer cost by sessionEnd drain", () => {
    const row = readMessageRow(dbPath, MSG_ID);
    assert.ok(row !== null, "llm_message row must exist");
    assert.equal(
      row!.cost_source,
      "writer",
      "sessionEnd must upgrade placeholder when stop was skipped",
    );
    assert.equal(row!.input_tokens, 800, "input tokens backfilled by sessionEnd");
    assert.equal(row!.output_tokens, 400, "output tokens backfilled by sessionEnd");
    assert.ok(row!.cost_total_micros > 0, "cost_total_micros must be non-zero after backfill");
  });

  test("session row has ended_at set after sessionEnd", () => {
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA query_only = 1");
    const row = db
      .prepare("SELECT ended_at FROM sessions WHERE harness_id='cursor' LIMIT 1")
      .get() as { ended_at: number | null } | null;
    db.close();
    assert.ok(row !== null, "session row must exist");
    assert.ok(
      typeof row!.ended_at === "number" && row!.ended_at > 0,
      "ended_at must be a positive timestamp",
    );
  });

  test("exactly one llm_message row after sessionEnd drain", () => {
    assert.equal(countLlmMessages(dbPath), 1, "no duplicate rows should be created");
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: stop was fired first → sessionEnd also runs backfill (idempotent)
//
// Normal agent loop: stop fires (backfills tokens), then sessionEnd fires.
// After the M4 drained-flag removal, sessionEnd always attempts backfill —
// it does NOT skip based on a flag. Because the store upserts are idempotent,
// the second backfill does not regress cost_source back to 'unknown' and does
// not create duplicate rows.
// ---------------------------------------------------------------------------

describe("sessionEnd: backfill is idempotent when stop already ran", () => {
  let tmpDir = "";
  let dbPath = "";
  let env: Record<string, string> = {};

  const CONV_ID = "cursor-conv-001";
  const GEN_ID = "cursor-gen-001";
  const MSG_ID = `cursor:${CONV_ID}:${GEN_ID}:assistant`;

  before(async () => {
    ({ tmpDir, dbPath, env } = makeTmpEnv());

    const transcriptPath = path.join(tmpDir, "transcript.jsonl");
    await writeTranscript(transcriptPath, [
      {
        role: "assistant",
        id: GEN_ID,
        model: "claude-sonnet-4-20250514",
        usage: { input_tokens: 600, output_tokens: 300 },
      },
    ]);

    // Run full sequence including stop.
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
    runHook(stopPayload, env);

    // Confirm stop upgraded the placeholder.
    const afterStop = readMessageRow(dbPath, MSG_ID);
    assert.ok(afterStop !== null, "row must exist after stop");
    assert.equal(afterStop!.cost_source, "writer", "stop should have upgraded placeholder");

    // Fire sessionEnd. It should see drained=true and not re-run the drain.
    const sessionEndPayload = {
      ...loadFixture("hooks/session-end.json"),
      transcript_path: transcriptPath,
    };
    const { exitCode, stderr } = runHook(sessionEndPayload, env);
    assert.equal(exitCode, 0, `sessionEnd failed: ${stderr.slice(0, 200)}`);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("cost_source remains 'writer' after sessionEnd (no regression)", () => {
    const row = readMessageRow(dbPath, MSG_ID);
    assert.ok(row !== null, "row must exist");
    assert.equal(
      row!.cost_source,
      "writer",
      "cost_source must not regress to unknown after sessionEnd",
    );
    assert.ok(row!.cost_total_micros > 0, "cost must remain non-zero");
  });

  test("still exactly one llm_message row after stop + sessionEnd", () => {
    assert.equal(countLlmMessages(dbPath), 1, "no duplicate rows after stop + sessionEnd");
  });
});
