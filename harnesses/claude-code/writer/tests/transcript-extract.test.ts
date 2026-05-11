/**
 * Tests for transcript/extract.ts
 *
 * All fixtures are inline objects — no files needed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractAssistantUsage } from "../src/transcript/extract.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assistantEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "assistant",
    uuid: "test-uuid-001",
    timestamp: "2024-01-15T10:00:00.000Z",
    message: {
      model: "claude-opus-4-5",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 10,
      },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("assistant entry with type='assistant' returns usage", () => {
  const entry = assistantEntry({ type: "assistant", role: undefined });
  const result = extractAssistantUsage(entry);
  assert.ok(result !== null);
  assert.equal(result.harnessMessageId, "test-uuid-001");
  assert.equal(result.modelId, "claude-opus-4-5");
  assert.equal(result.inputTokens, 100);
  assert.equal(result.outputTokens, 50);
  assert.equal(result.cacheReadTokens, 20);
  assert.equal(result.cacheWriteTokens, 10);
  assert.equal(result.legacyCostUSD, null);
});

test("assistant entry with role='assistant' (alternate convention) returns usage", () => {
  const entry = {
    role: "assistant",
    uuid: "test-uuid-002",
    timestamp: "2024-01-15T10:00:00.000Z",
    message: {
      model: "claude-sonnet-4-5",
      usage: {
        input_tokens: 200,
        output_tokens: 80,
      },
    },
  };
  const result = extractAssistantUsage(entry);
  assert.ok(result !== null);
  assert.equal(result.harnessMessageId, "test-uuid-002");
  assert.equal(result.modelId, "claude-sonnet-4-5");
  assert.equal(result.inputTokens, 200);
  assert.equal(result.outputTokens, 80);
  assert.equal(result.cacheReadTokens, 0);
  assert.equal(result.cacheWriteTokens, 0);
});

test("user entry returns null", () => {
  const entry = { type: "user", uuid: "u1", message: { content: "hello" } };
  assert.equal(extractAssistantUsage(entry), null);
});

test("system entry returns null", () => {
  const entry = { type: "system", uuid: "s1" };
  assert.equal(extractAssistantUsage(entry), null);
});

test("entry without uuid returns null", () => {
  const entry = assistantEntry({ uuid: undefined });
  assert.equal(extractAssistantUsage(entry), null);
});

test("entry with empty uuid returns null", () => {
  const entry = assistantEntry({ uuid: "" });
  assert.equal(extractAssistantUsage(entry), null);
});

test("null entry returns null", () => {
  assert.equal(extractAssistantUsage(null), null);
});

test("non-object entry returns null", () => {
  assert.equal(extractAssistantUsage("string"), null);
  assert.equal(extractAssistantUsage(42), null);
  assert.equal(extractAssistantUsage(undefined), null);
});

test("legacy costUSD field is extracted", () => {
  const entry = assistantEntry({ costUSD: 0.00123 });
  const result = extractAssistantUsage(entry);
  assert.ok(result !== null);
  assert.ok(result.legacyCostUSD !== null);
  assert.ok(Math.abs((result.legacyCostUSD as number) - 0.00123) < 1e-9);
});

test("missing usage fields default to 0", () => {
  const entry = {
    type: "assistant",
    uuid: "uuid-no-usage",
    message: { model: "claude-opus-4-5" },
    // no usage block
  };
  const result = extractAssistantUsage(entry);
  assert.ok(result !== null);
  assert.equal(result.inputTokens, 0);
  assert.equal(result.outputTokens, 0);
  assert.equal(result.cacheReadTokens, 0);
  assert.equal(result.cacheWriteTokens, 0);
});

test("entry with no message block returns null model but valid usage zeros", () => {
  const entry = { type: "assistant", uuid: "uuid-no-msg" };
  const result = extractAssistantUsage(entry);
  assert.ok(result !== null);
  assert.equal(result.modelId, null);
  assert.equal(result.inputTokens, 0);
});

test("timestamp ISO string is parsed to unix ms", () => {
  const ts = "2024-06-01T12:00:00.000Z";
  const expected = new Date(ts).getTime();
  const entry = assistantEntry({ timestamp: ts });
  const result = extractAssistantUsage(entry);
  assert.ok(result !== null);
  assert.equal(result.ts, expected);
});

test("missing timestamp falls back to Date.now() (approximate)", () => {
  const before = Date.now();
  const entry = assistantEntry({ timestamp: undefined });
  const result = extractAssistantUsage(entry);
  const after = Date.now();
  assert.ok(result !== null);
  assert.ok(result.ts >= before && result.ts <= after, "ts should be close to now");
});

test("entry with both type and role set to assistant is accepted", () => {
  const entry = assistantEntry({ type: "assistant", role: "assistant" });
  const result = extractAssistantUsage(entry);
  assert.ok(result !== null);
});
