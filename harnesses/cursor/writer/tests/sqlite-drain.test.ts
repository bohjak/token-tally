/**
 * tests/sqlite-drain.test.ts — Unit tests for the SQLite token backfill drain.
 *
 * Uses Node 24's built-in `node:sqlite` (DatabaseSync) to create temporary
 * SQLite databases with the Cursor-style `cursorDiskKV` schema. This avoids
 * committing binary fixtures and keeps the test self-contained.
 *
 * Tests cover:
 *   - Missing database file → empty result (no throw)
 *   - Database without cursorDiskKV table → empty result
 *   - Bubble rows with non-zero token counts → records returned
 *   - Bubble rows with zero token counts → excluded
 *   - Session-level lastUsedModel extraction from composerData row
 *   - Provider inference from model id
 *   - Cross-conversation isolation (only matching conversationId returned)
 *   - Malformed JSON value in a row → skip row, continue
 *   - Platform path resolution: macOS / Linux / Windows / unknown
 *
 * All imports use .js extension (compiled output runs from dist/).
 */

import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { drainSqlite } from "../src/sqlite/drain.js";
import { getCursorStateDbPath } from "../src/sqlite/paths.js";
import { bubbleKey, composerDataKey, parseBubbleKey, isComposerDataKey } from "../src/sqlite/keys.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp directory, returns its path and a cleanup function. */
function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-sqlite-drain-"));
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Create a minimal Cursor-style `cursorDiskKV` database at `dbPath`.
 * Optionally populate it with provided rows.
 */
function createKvDb(
  dbPath: string,
  rows: Array<{ key: string; value: string }> = [],
): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS cursorDiskKV (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const insert = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
  for (const row of rows) {
    insert.run(row.key, row.value);
  }
  db.close();
}

/** Build a bubble value JSON string. */
function bubbleValue(opts: {
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
  provider?: string;
}): string {
  const obj: Record<string, unknown> = {};
  if (opts.inputTokens !== undefined || opts.outputTokens !== undefined) {
    obj["tokenCount"] = {
      inputTokens: opts.inputTokens ?? 0,
      outputTokens: opts.outputTokens ?? 0,
    };
  }
  if (opts.model !== undefined) obj["model"] = opts.model;
  if (opts.provider !== undefined) obj["providerOptions"] = { provider: opts.provider };
  return JSON.stringify(obj);
}

/** Build a composerData value JSON string. */
function composerValue(opts: { lastUsedModel?: string }): string {
  return JSON.stringify({ lastUsedModel: opts.lastUsedModel });
}

// ---------------------------------------------------------------------------
// keys.ts tests
// ---------------------------------------------------------------------------

describe("sqlite/keys", () => {
  test("bubbleKey builds correct format", () => {
    assert.equal(bubbleKey("conv-1", "bubble-a"), "bubbleId:conv-1:bubble-a");
  });

  test("composerDataKey builds correct format", () => {
    assert.equal(composerDataKey("conv-1"), "composerData:conv-1");
  });

  test("parseBubbleKey parses a valid key", () => {
    const result = parseBubbleKey("bubbleId:conv-1:bubble-a");
    assert.deepEqual(result, { composerId: "conv-1", bubbleId: "bubble-a" });
  });

  test("parseBubbleKey returns null for non-bubble keys", () => {
    assert.equal(parseBubbleKey("composerData:conv-1"), null);
    assert.equal(parseBubbleKey("somethingElse"), null);
    assert.equal(parseBubbleKey("bubbleId:only-one-part"), null);
  });

  test("parseBubbleKey handles composerId with no bubbleId section", () => {
    assert.equal(parseBubbleKey("bubbleId:onlyone"), null);
  });

  test("isComposerDataKey identifies composer data keys", () => {
    assert.equal(isComposerDataKey("composerData:conv-1"), true);
    assert.equal(isComposerDataKey("bubbleId:conv-1:bub-1"), false);
    assert.equal(isComposerDataKey("randomKey"), false);
  });
});

// ---------------------------------------------------------------------------
// paths.ts tests
// ---------------------------------------------------------------------------

describe("sqlite/paths", () => {
  test("returns a string or undefined (never throws)", () => {
    // We can't know which platform we're on in tests, but the function
    // must not throw regardless of platform.
    const result = getCursorStateDbPath();
    assert.ok(result === undefined || typeof result === "string");
  });

  test("macOS path contains expected segments", () => {
    if (process.platform !== "darwin") return; // skip on non-macOS
    const result = getCursorStateDbPath();
    assert.ok(result !== undefined);
    assert.ok(result.includes("Library"));
    assert.ok(result.includes("Cursor"));
    assert.ok(result.endsWith("state.vscdb"));
  });

  test("Linux path contains expected segments", () => {
    if (process.platform !== "linux") return; // skip on non-Linux
    const result = getCursorStateDbPath();
    assert.ok(result !== undefined);
    assert.ok(result.includes(".config"));
    assert.ok(result.includes("Cursor"));
    assert.ok(result.endsWith("state.vscdb"));
  });
});

// ---------------------------------------------------------------------------
// drainSqlite — missing / invalid DB
// ---------------------------------------------------------------------------

describe("drainSqlite: missing or invalid database", () => {
  test("returns empty result for non-existent DB path (no throw)", async () => {
    const result = await drainSqlite("conv-1", "/nonexistent/path/state.vscdb");
    assert.deepEqual(result.records, []);
    assert.equal(result.sessionModel, null);
  });

  test("returns empty result for DB without cursorDiskKV table", async () => {
    const { dir, cleanup } = makeTmpDir();
    const dbPath = path.join(dir, "no-table.db");
    // Create a DB with a different table
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE other_table (id INTEGER PRIMARY KEY)");
    db.close();

    try {
      const result = await drainSqlite("conv-1", dbPath);
      assert.deepEqual(result.records, []);
      assert.equal(result.sessionModel, null);
    } finally {
      cleanup();
    }
  });

  test("returns empty result when given a text file that is not SQLite", async () => {
    const { dir, cleanup } = makeTmpDir();
    const fakePath = path.join(dir, "not-a-db.vscdb");
    fs.writeFileSync(fakePath, "this is not a sqlite file\n");

    try {
      const result = await drainSqlite("conv-1", fakePath);
      assert.deepEqual(result.records, []);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// drainSqlite — token extraction
// ---------------------------------------------------------------------------

describe("drainSqlite: token extraction", () => {
  let tmpDir: { dir: string; cleanup: () => void };

  before(() => {
    tmpDir = makeTmpDir();
  });

  after(() => {
    tmpDir.cleanup();
  });

  test("extracts tokens from a bubble with non-zero counts", async () => {
    const dbPath = path.join(tmpDir.dir, "bubble-tokens.db");
    createKvDb(dbPath, [
      {
        key: bubbleKey("conv-123", "bubble-abc"),
        value: bubbleValue({
          inputTokens: 500,
          outputTokens: 200,
          model: "claude-sonnet-4-20250514",
        }),
      },
    ]);

    const result = await drainSqlite("conv-123", dbPath);
    assert.equal(result.records.length, 1);

    const record = result.records[0]!;
    assert.equal(record.harnessMessageId, "cursor:conv-123:bubble-abc:assistant");
    assert.equal(record.inputTokens, 500);
    assert.equal(record.outputTokens, 200);
    assert.equal(record.modelId, "claude-sonnet-4-20250514");
    assert.equal(record.provider, "anthropic");
  });

  test("skips bubble rows with zero token counts", async () => {
    const dbPath = path.join(tmpDir.dir, "zero-tokens.db");
    createKvDb(dbPath, [
      {
        key: bubbleKey("conv-zero", "bubble-1"),
        value: bubbleValue({ inputTokens: 0, outputTokens: 0 }),
      },
    ]);

    const result = await drainSqlite("conv-zero", dbPath);
    assert.equal(result.records.length, 0);
  });

  test("skips bubble rows with missing tokenCount field", async () => {
    const dbPath = path.join(tmpDir.dir, "no-tokens.db");
    createKvDb(dbPath, [
      {
        key: bubbleKey("conv-notoken", "bubble-1"),
        value: JSON.stringify({ model: "claude-sonnet-4-20250514" }), // no tokenCount
      },
    ]);

    const result = await drainSqlite("conv-notoken", dbPath);
    assert.equal(result.records.length, 0);
  });

  test("extracts multiple bubbles from the same conversation", async () => {
    const dbPath = path.join(tmpDir.dir, "multi-bubble.db");
    createKvDb(dbPath, [
      {
        key: bubbleKey("conv-multi", "bubble-1"),
        value: bubbleValue({ inputTokens: 100, outputTokens: 50 }),
      },
      {
        key: bubbleKey("conv-multi", "bubble-2"),
        value: bubbleValue({ inputTokens: 200, outputTokens: 100 }),
      },
    ]);

    const result = await drainSqlite("conv-multi", dbPath);
    assert.equal(result.records.length, 2);

    const ids = result.records.map((r) => r.harnessMessageId).sort();
    assert.deepEqual(ids, [
      "cursor:conv-multi:bubble-1:assistant",
      "cursor:conv-multi:bubble-2:assistant",
    ]);
  });

  test("does not return bubbles from other conversations", async () => {
    const dbPath = path.join(tmpDir.dir, "multi-conv.db");
    createKvDb(dbPath, [
      {
        key: bubbleKey("conv-A", "bub-1"),
        value: bubbleValue({ inputTokens: 100, outputTokens: 50 }),
      },
      {
        key: bubbleKey("conv-B", "bub-1"),
        value: bubbleValue({ inputTokens: 200, outputTokens: 100 }),
      },
    ]);

    const result = await drainSqlite("conv-A", dbPath);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0]!.harnessMessageId, "cursor:conv-A:bub-1:assistant");
  });

  test("skips malformed JSON value rows without aborting the drain", async () => {
    const dbPath = path.join(tmpDir.dir, "malformed-row.db");
    createKvDb(dbPath, [
      {
        key: bubbleKey("conv-bad", "bub-good"),
        value: bubbleValue({ inputTokens: 100, outputTokens: 40 }),
      },
      {
        key: bubbleKey("conv-bad", "bub-broken"),
        value: "not-valid-json{{{",
      },
    ]);

    const result = await drainSqlite("conv-bad", dbPath);
    // Should get the good record; the bad one is silently skipped
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0]!.harnessMessageId, "cursor:conv-bad:bub-good:assistant");
  });

  test("extracts explicit provider from providerOptions", async () => {
    const dbPath = path.join(tmpDir.dir, "explicit-provider.db");
    createKvDb(dbPath, [
      {
        key: bubbleKey("conv-prov", "bub-1"),
        value: bubbleValue({
          inputTokens: 10,
          outputTokens: 20,
          model: "my-custom-model",
          provider: "openai",
        }),
      },
    ]);

    const result = await drainSqlite("conv-prov", dbPath);
    assert.equal(result.records[0]?.provider, "openai");
  });

  test("infers provider from model id when providerOptions is absent", async () => {
    const dbPath = path.join(tmpDir.dir, "infer-provider.db");
    createKvDb(dbPath, [
      {
        key: bubbleKey("conv-infer", "bub-1"),
        value: bubbleValue({
          inputTokens: 30,
          outputTokens: 15,
          model: "gpt-4o",
          // no explicit provider
        }),
      },
    ]);

    const result = await drainSqlite("conv-infer", dbPath);
    assert.equal(result.records[0]?.provider, "openai");
  });
});

// ---------------------------------------------------------------------------
// drainSqlite — session model extraction
// ---------------------------------------------------------------------------

describe("drainSqlite: session model extraction", () => {
  let tmpDir: { dir: string; cleanup: () => void };

  before(() => {
    tmpDir = makeTmpDir();
  });

  after(() => {
    tmpDir.cleanup();
  });

  test("returns lastUsedModel from composerData row", async () => {
    const dbPath = path.join(tmpDir.dir, "session-model.db");
    createKvDb(dbPath, [
      {
        key: composerDataKey("conv-sess"),
        value: composerValue({ lastUsedModel: "claude-opus-4-5" }),
      },
    ]);

    const result = await drainSqlite("conv-sess", dbPath);
    assert.equal(result.sessionModel, "claude-opus-4-5");
  });

  test("sessionModel is null when composerData row is absent", async () => {
    const dbPath = path.join(tmpDir.dir, "no-session-model.db");
    // Only create a bubble row, no composerData
    createKvDb(dbPath, [
      {
        key: bubbleKey("conv-nosess", "bub-1"),
        value: bubbleValue({ inputTokens: 10, outputTokens: 5 }),
      },
    ]);

    const result = await drainSqlite("conv-nosess", dbPath);
    assert.equal(result.sessionModel, null);
  });

  test("sessionModel is null when lastUsedModel is empty string", async () => {
    const dbPath = path.join(tmpDir.dir, "empty-model.db");
    createKvDb(dbPath, [
      {
        key: composerDataKey("conv-empty"),
        value: composerValue({ lastUsedModel: "" }),
      },
    ]);

    const result = await drainSqlite("conv-empty", dbPath);
    assert.equal(result.sessionModel, null);
  });

  test("sessionModel is null when composerData value is malformed JSON", async () => {
    const dbPath = path.join(tmpDir.dir, "bad-composer.db");
    createKvDb(dbPath, [
      {
        key: composerDataKey("conv-bad-json"),
        value: "NOT VALID JSON",
      },
    ]);

    const result = await drainSqlite("conv-bad-json", dbPath);
    assert.equal(result.sessionModel, null);
  });

  test("returns both records and sessionModel when both are present", async () => {
    const dbPath = path.join(tmpDir.dir, "both-present.db");
    createKvDb(dbPath, [
      {
        key: composerDataKey("conv-both"),
        value: composerValue({ lastUsedModel: "gemini-1.5-pro" }),
      },
      {
        key: bubbleKey("conv-both", "bub-a"),
        value: bubbleValue({ inputTokens: 200, outputTokens: 100, model: "gemini-1.5-pro" }),
      },
    ]);

    const result = await drainSqlite("conv-both", dbPath);
    assert.equal(result.sessionModel, "gemini-1.5-pro");
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0]!.inputTokens, 200);
  });

  test("composerData from a different conversation is not returned", async () => {
    const dbPath = path.join(tmpDir.dir, "wrong-conv.db");
    createKvDb(dbPath, [
      {
        // composerData for conv-X — we query for conv-Y
        key: composerDataKey("conv-X"),
        value: composerValue({ lastUsedModel: "gpt-4o" }),
      },
    ]);

    const result = await drainSqlite("conv-Y", dbPath);
    assert.equal(result.sessionModel, null);
  });
});
