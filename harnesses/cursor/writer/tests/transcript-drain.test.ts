/**
 * tests/transcript-drain.test.ts — Unit tests for the transcript backfill drain.
 *
 * Tests cover:
 *   - Standard JSONL with Anthropic/OpenAI/Google/nested-message token formats
 *   - Empty transcript → empty results
 *   - Malformed JSONL → empty results (no throw)
 *   - Assistant entries with no token data → excluded
 *   - Assistant entries with no id field → excluded
 *   - Canonical harnessMessageId formation
 *   - Provider inference from model id
 *   - Reader handles missing file gracefully
 *
 * All imports use .js extension because tests are compiled and run from dist/.
 */

import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { readTranscriptEntries } from "../src/transcript/reader.js";
import { drainTranscript } from "../src/transcript/drain.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

// __dirname = dist/tests/
// Fixtures live in <package-root>/tests/fixtures/transcripts/
const FIXTURES_DIR = path.join(__dirname, "..", "..", "tests", "fixtures", "transcripts");

function fixture(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

// ---------------------------------------------------------------------------
// readTranscriptEntries
// ---------------------------------------------------------------------------

describe("readTranscriptEntries", () => {
  test("returns empty array for non-existent file", async () => {
    const result = await readTranscriptEntries("/nonexistent/path/transcript.jsonl");
    assert.deepEqual(result, []);
  });

  test("returns empty array for empty file", async () => {
    const result = await readTranscriptEntries(fixture("cursor-empty.jsonl"));
    assert.deepEqual(result, []);
  });

  test("parses valid JSONL and returns all entries", async () => {
    const result = await readTranscriptEntries(fixture("cursor-assistant-with-tokens.jsonl"));
    // 2 user + 2 assistant = 4 entries
    assert.equal(result.length, 4);
  });

  test("falls back gracefully on malformed JSONL → empty array", async () => {
    const result = await readTranscriptEntries(fixture("cursor-malformed.jsonl"));
    assert.deepEqual(result, []);
  });

  test("returns empty array on unreadable path (no throw)", async () => {
    // A path that definitely won't be readable
    const result = await readTranscriptEntries(
      path.join(os.tmpdir(), "tt-test-nonexistent-" + Date.now() + ".jsonl"),
    );
    assert.deepEqual(result, []);
  });

  test("handles nested-message JSONL (Claude Code style)", async () => {
    const result = await readTranscriptEntries(fixture("cursor-nested-message.jsonl"));
    assert.equal(result.length, 2);
  });

  test("parses single-object JSON wrapped in array", async () => {
    const tmpFile = path.join(os.tmpdir(), `tt-json-array-${Date.now()}.json`);
    fs.writeFileSync(
      tmpFile,
      JSON.stringify([
        { role: "user", content: "Hi" },
        { role: "assistant", id: "gen-001", content: "Hello", usage: { input_tokens: 10, output_tokens: 5 } },
      ]),
    );
    try {
      const result = await readTranscriptEntries(tmpFile);
      assert.equal(result.length, 2);
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  });

  test("handles { messages: [...] } JSON envelope", async () => {
    const tmpFile = path.join(os.tmpdir(), `tt-messages-${Date.now()}.json`);
    fs.writeFileSync(
      tmpFile,
      JSON.stringify({
        messages: [
          { role: "user", content: "Hi" },
          { role: "assistant", id: "gen-001", usage: { input_tokens: 10, output_tokens: 5 } },
        ],
      }),
    );
    try {
      const result = await readTranscriptEntries(tmpFile);
      assert.equal(result.length, 2);
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// drainTranscript
// ---------------------------------------------------------------------------

describe("drainTranscript", () => {
  const CONV_ID = "test-conv-001";

  test("returns empty for non-existent transcript", async () => {
    const result = await drainTranscript("/nonexistent/transcript.jsonl", CONV_ID);
    assert.deepEqual(result, []);
  });

  test("returns empty for empty transcript", async () => {
    const result = await drainTranscript(fixture("cursor-empty.jsonl"), CONV_ID);
    assert.deepEqual(result, []);
  });

  test("returns empty for malformed JSONL (no throw)", async () => {
    const result = await drainTranscript(fixture("cursor-malformed.jsonl"), CONV_ID);
    assert.deepEqual(result, []);
  });

  test("skips assistant entries with no token data", async () => {
    const result = await drainTranscript(fixture("cursor-no-tokens.jsonl"), CONV_ID);
    assert.deepEqual(result, []);
  });

  test("skips assistant entries with no id field", async () => {
    const result = await drainTranscript(fixture("cursor-no-id.jsonl"), CONV_ID);
    assert.deepEqual(result, []);
  });

  test("extracts Anthropic-format tokens from JSONL", async () => {
    const result = await drainTranscript(
      fixture("cursor-assistant-with-tokens.jsonl"),
      CONV_ID,
    );
    assert.equal(result.length, 2, "should have 2 assistant records");

    const [first, second] = result;

    // First assistant entry
    assert.equal(
      first?.harnessMessageId,
      `cursor:${CONV_ID}:cursor-gen-001:assistant`,
    );
    assert.equal(first?.inputTokens, 150);
    assert.equal(first?.outputTokens, 320);
    assert.equal(first?.modelId, "claude-sonnet-4-20250514");
    assert.equal(first?.provider, "anthropic");

    // Second assistant entry
    assert.equal(
      second?.harnessMessageId,
      `cursor:${CONV_ID}:cursor-gen-002:assistant`,
    );
    assert.equal(second?.inputTokens, 480);
    assert.equal(second?.outputTokens, 210);
  });

  test("extracts OpenAI-format tokens (prompt_tokens / completion_tokens)", async () => {
    const result = await drainTranscript(
      fixture("cursor-openai-format.jsonl"),
      CONV_ID,
    );
    assert.equal(result.length, 1);
    assert.equal(result[0]?.inputTokens, 10);
    assert.equal(result[0]?.outputTokens, 25);
    assert.equal(result[0]?.modelId, "gpt-4o");
    assert.equal(result[0]?.provider, "openai");
  });

  test("extracts Google Gemini format tokens (usage_metadata)", async () => {
    const result = await drainTranscript(
      fixture("cursor-google-format.jsonl"),
      CONV_ID,
    );
    assert.equal(result.length, 1);
    assert.equal(result[0]?.inputTokens, 12);
    assert.equal(result[0]?.outputTokens, 45);
    assert.equal(result[0]?.modelId, "gemini-1.5-pro");
    assert.equal(result[0]?.provider, "google");
  });

  test("extracts tokens from nested { message: { usage: ... } } format", async () => {
    // This is the Claude Code JSONL style
    const result = await drainTranscript(
      fixture("cursor-nested-message.jsonl"),
      CONV_ID,
    );
    assert.equal(result.length, 1);
    assert.equal(result[0]?.inputTokens, 200);
    assert.equal(result[0]?.outputTokens, 800);
    assert.equal(result[0]?.modelId, "claude-opus-4-5");
    assert.equal(result[0]?.provider, "anthropic");
  });

  test("canonical harnessMessageId uses conversation_id from parameter", async () => {
    const customConvId = "my-custom-conversation-xyz";
    const result = await drainTranscript(
      fixture("cursor-assistant-with-tokens.jsonl"),
      customConvId,
    );
    assert.ok(result.length > 0);
    assert.ok(result[0]!.harnessMessageId.startsWith(`cursor:${customConvId}:`));
  });

  test("harnessMessageId format: cursor:<conversationId>:<id>:assistant", async () => {
    const result = await drainTranscript(
      fixture("cursor-openai-format.jsonl"),
      "conv-abc",
    );
    assert.equal(result[0]?.harnessMessageId, "cursor:conv-abc:openai-gen-001:assistant");
  });

  test("user entries are not included in results", async () => {
    const result = await drainTranscript(
      fixture("cursor-assistant-with-tokens.jsonl"),
      CONV_ID,
    );
    // File has 2 user + 2 assistant entries; only assistant entries with tokens should appear
    assert.equal(result.length, 2);
    for (const record of result) {
      assert.ok(record.harnessMessageId.endsWith(":assistant"));
    }
  });

  test("inline JSON array transcript format", async () => {
    const tmpFile = path.join(os.tmpdir(), `tt-drain-array-${Date.now()}.json`);
    fs.writeFileSync(
      tmpFile,
      JSON.stringify([
        { role: "user", id: "u-1", content: "Hi" },
        {
          role: "assistant",
          id: "gen-json-001",
          model: "gpt-4o-mini",
          usage: { prompt_tokens: 8, completion_tokens: 15 },
        },
      ]),
    );
    try {
      const result = await drainTranscript(tmpFile, "conv-json");
      assert.equal(result.length, 1);
      assert.equal(result[0]?.harnessMessageId, "cursor:conv-json:gen-json-001:assistant");
      assert.equal(result[0]?.inputTokens, 8);
      assert.equal(result[0]?.outputTokens, 15);
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  });

  test("never throws on unexpected input shapes", async () => {
    const tmpFile = path.join(os.tmpdir(), `tt-weird-${Date.now()}.jsonl`);
    // Write totally unexpected content
    fs.writeFileSync(tmpFile, '42\n"a string"\nnull\ntrue\n[1,2,3]\n');
    try {
      const result = await drainTranscript(tmpFile, "conv-weird");
      assert.deepEqual(result, []);
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  });
});
