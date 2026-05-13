/**
 * tests/pre-compact.test.ts — Integration tests for the preCompact hook handler.
 *
 * preCompact is the only Cursor hook that carries token/context window data.
 * The handler is a no-op by default (captureRaw=false) and emits a minimal
 * raw_event when captureRaw=true in the harness config.
 *
 * These tests verify:
 *   - Default: no raw_events row written when captureRaw is absent/false.
 *   - Opt-in: exactly one raw_event per preCompact when captureRaw=true.
 *   - Payload safety: the emitted payload contains only allowed metadata fields.
 *   - Append-only: raw_events has no idempotency key; each preCompact adds a row.
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

// __dirname = dist/tests/  (tests run against compiled output)
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-precompact-"));
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

function countRawEvents(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA query_only = 1");
  const row = db
    .prepare("SELECT count(*) as n FROM raw_events WHERE harness_id='cursor'")
    .get() as { n: number };
  db.close();
  return row.n;
}

// ---------------------------------------------------------------------------
// Scenario 1: preCompact is a no-op when captureRaw is disabled (default)
//
// Most users will not opt in to raw capture. Confirm that no raw_events rows
// are written even when preCompact fires. This is the common path.
// ---------------------------------------------------------------------------

describe("preCompact: no-op when captureRaw is disabled (default)", () => {
  let tmpDir = "";
  let dbPath = "";
  let env: Record<string, string> = {};

  before(() => {
    ({ tmpDir, dbPath, env } = makeTmpEnv());
    // No config file → captureRaw defaults to false.

    // Start a session so the harness + DB rows exist.
    const sessionStart = runHook(loadFixture("hooks/session-start.json"), env);
    assert.equal(sessionStart.exitCode, 0, `sessionStart failed: ${sessionStart.stderr}`);

    // Fire preCompact without a captureRaw config present.
    const preCompact = runHook(loadFixture("hooks/pre-compact.json"), env);
    assert.equal(preCompact.exitCode, 0, `preCompact failed: ${preCompact.stderr}`);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("no raw_events row when captureRaw is false", () => {
    assert.equal(
      countRawEvents(dbPath),
      0,
      "preCompact must not write raw_events by default (opt-in only)",
    );
  });

  test("hook exits 0 even when preCompact is a no-op", () => {
    // Verified in before() — hook must never block Cursor regardless of config.
    assert.ok(true, "exit-0 contract verified in before()");
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: preCompact emits a minimal raw_event when captureRaw=true
//
// Users who opt in to raw capture must get exactly one row per event, with a
// payload that contains only safe numeric/boolean metadata — no PII.
// ---------------------------------------------------------------------------

describe("preCompact: emits raw_event when captureRaw=true", () => {
  let tmpDir = "";
  let dbPath = "";
  let env: Record<string, string> = {};

  before(async () => {
    ({ tmpDir, dbPath, env } = makeTmpEnv());

    // Write a config that opts into raw capture for the cursor harness.
    const configDir = path.join(env["XDG_CONFIG_HOME"]!, "token-tally");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({
        harnesses: {
          cursor: {
            captureRaw: true,
          },
        },
      }),
      "utf8",
    );

    // Start session so the harness FK exists.
    const sessionStart = runHook(loadFixture("hooks/session-start.json"), env);
    assert.equal(sessionStart.exitCode, 0, `sessionStart failed: ${sessionStart.stderr}`);

    // Fire preCompact with context_tokens=110000 and context_window_size=128000
    // (values from hooks/pre-compact.json fixture).
    const preCompact = runHook(loadFixture("hooks/pre-compact.json"), env);
    assert.equal(preCompact.exitCode, 0, `preCompact failed: ${preCompact.stderr}`);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("exactly one raw_event row emitted", () => {
    assert.equal(countRawEvents(dbPath), 1, "exactly one raw_event should be written");
  });

  test("raw_event kind is 'preCompact'", () => {
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA query_only = 1");
    const row = db
      .prepare("SELECT kind FROM raw_events WHERE harness_id='cursor' LIMIT 1")
      .get() as { kind: string } | null;
    db.close();
    assert.ok(row !== null, "raw_event row must exist");
    assert.equal(row!.kind, "preCompact", "kind must be 'preCompact'");
  });

  test("raw_event payload contains context_tokens and context_window_size", () => {
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA query_only = 1");
    const row = db
      .prepare("SELECT payload_json FROM raw_events WHERE harness_id='cursor' LIMIT 1")
      .get() as { payload_json: string } | null;
    db.close();
    assert.ok(row !== null, "raw_event row must exist");
    const payload = JSON.parse(row!.payload_json) as Record<string, unknown>;
    // The fixture sets context_tokens: 110000, context_window_size: 128000.
    assert.equal(payload["context_tokens"], 110_000, "context_tokens must be stored");
    assert.equal(payload["context_window_size"], 128_000, "context_window_size must be stored");
  });

  test("raw_event payload does not contain PII or conversation text", () => {
    // Safety gate: the handler is only permitted to emit numeric/boolean
    // context-window metadata. Conversation text, prompt content, user email,
    // and file paths must never appear here.
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA query_only = 1");
    const row = db
      .prepare("SELECT payload_json FROM raw_events WHERE harness_id='cursor' LIMIT 1")
      .get() as { payload_json: string } | null;
    db.close();
    assert.ok(row !== null);
    const payload = JSON.parse(row!.payload_json) as Record<string, unknown>;

    const disallowedKeys = ["prompt", "text", "message", "content", "user_email", "file_path"];
    for (const key of disallowedKeys) {
      assert.ok(
        !(key in payload),
        `raw_event payload must not contain '${key}'. Found in: ${JSON.stringify(payload)}`,
      );
    }
  });

  test("firing preCompact again appends a second raw_event row (append-only)", () => {
    // raw_events is append-only — there is no upsert/idempotency key.
    // Each preCompact event that fires while captureRaw=true produces a new row.
    // This is expected and documented behaviour (diagnostic capture, not structured data).
    const result = runHook(loadFixture("hooks/pre-compact.json"), env);
    assert.equal(result.exitCode, 0, "second preCompact must exit 0");
    assert.equal(
      countRawEvents(dbPath),
      2,
      "second preCompact must append a second row (raw_events is not idempotent)",
    );
  });
});
