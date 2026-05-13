/**
 * ids.test.ts — Unit tests for src/ids/synthesize.ts
 *
 * Tests verify the ID derivation rules specified in the plan:
 *   - harness_session_id = conversation_id ?? session_id; undefined when absent
 *   - harness_turn_id    = generation_id when present, else <sid>:t<index>
 *   - harness_message_id = cursor:<cid>:<gid>:assistant when both present,
 *                          else <sid>:m<index>
 *   - harness_tool_id    = tool_use_id when present, else <sid>:tc<index>
 *
 * All imports use the .js extension because tests are compiled to dist/ and
 * run via node --test against the compiled output.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  extractHarnessSessionId,
  computeHarnessTurnId,
  computeHarnessMessageId,
  computeHarnessToolCallId,
  centralUuid,
} from "../src/ids/synthesize.js";

// ---------------------------------------------------------------------------
// extractHarnessSessionId
// ---------------------------------------------------------------------------

describe("extractHarnessSessionId", () => {
  it("returns conversation_id when present", () => {
    const result = extractHarnessSessionId({
      conversation_id: "conv-abc",
      session_id: "sess-xyz",
    });
    assert.equal(result, "conv-abc");
  });

  it("falls back to session_id when conversation_id is absent", () => {
    const result = extractHarnessSessionId({ session_id: "sess-xyz" });
    assert.equal(result, "sess-xyz");
  });

  it("returns undefined when both are absent", () => {
    const result = extractHarnessSessionId({});
    assert.equal(result, undefined);
  });

  it("returns undefined when both are undefined explicitly", () => {
    const result = extractHarnessSessionId({
      conversation_id: undefined,
      session_id: undefined,
    });
    assert.equal(result, undefined);
  });

  it("prefers conversation_id over session_id (Cursor docs: they are aliases on sessionStart/End)", () => {
    // On sessionStart, Cursor sends both fields with the same value.
    // We should consistently use conversation_id.
    const result = extractHarnessSessionId({
      conversation_id: "conv-111",
      session_id: "conv-111",
    });
    assert.equal(result, "conv-111");
  });

  it("works for events with only conversation_id (most hook types)", () => {
    // Most Cursor hook events don't include session_id at all.
    const result = extractHarnessSessionId({ conversation_id: "conv-prompt-42" });
    assert.equal(result, "conv-prompt-42");
  });
});

// ---------------------------------------------------------------------------
// computeHarnessTurnId
// ---------------------------------------------------------------------------

describe("computeHarnessTurnId", () => {
  it("uses generation_id when present", () => {
    const result = computeHarnessTurnId("gen-abc123", "sess-1", 0);
    assert.equal(result, "gen-abc123");
  });

  it("falls back to synthesized form when generation_id is undefined", () => {
    const result = computeHarnessTurnId(undefined, "sess-1", 0);
    assert.equal(result, "sess-1:t0");
  });

  it("falls back to synthesized form when generation_id is empty string", () => {
    const result = computeHarnessTurnId("", "sess-1", 5);
    assert.equal(result, "sess-1:t5");
  });

  it("synthesized turn id includes the turn index", () => {
    assert.equal(computeHarnessTurnId(undefined, "sid", 0), "sid:t0");
    assert.equal(computeHarnessTurnId(undefined, "sid", 1), "sid:t1");
    assert.equal(computeHarnessTurnId(undefined, "sid", 99), "sid:t99");
  });

  it("synthesized turn id is deterministic — same inputs produce same output", () => {
    const a = computeHarnessTurnId(undefined, "sid", 3);
    const b = computeHarnessTurnId(undefined, "sid", 3);
    assert.equal(a, b);
  });

  it("different turn indices produce different IDs", () => {
    const a = computeHarnessTurnId(undefined, "sid", 1);
    const b = computeHarnessTurnId(undefined, "sid", 2);
    assert.notEqual(a, b);
  });
});

// ---------------------------------------------------------------------------
// computeHarnessMessageId
// ---------------------------------------------------------------------------

describe("computeHarnessMessageId", () => {
  it("builds cursor:<cid>:<gid>:assistant when both fields present", () => {
    const result = computeHarnessMessageId("conv-1", "gen-2", "sess-3", 0);
    assert.equal(result, "cursor:conv-1:gen-2:assistant");
  });

  it("falls back to synthesized form when conversation_id is absent", () => {
    const result = computeHarnessMessageId(undefined, "gen-2", "sess-3", 7);
    assert.equal(result, "sess-3:m7");
  });

  it("falls back to synthesized form when generation_id is absent", () => {
    const result = computeHarnessMessageId("conv-1", undefined, "sess-3", 3);
    assert.equal(result, "sess-3:m3");
  });

  it("falls back to synthesized form when both are absent", () => {
    const result = computeHarnessMessageId(undefined, undefined, "sess-3", 0);
    assert.equal(result, "sess-3:m0");
  });

  it("falls back to synthesized form when fields are empty strings", () => {
    const result = computeHarnessMessageId("", "gen-2", "sess-3", 2);
    assert.equal(result, "sess-3:m2");
  });

  it("canonical form is deterministic", () => {
    const a = computeHarnessMessageId("conv-1", "gen-2", "sess-3", 0);
    const b = computeHarnessMessageId("conv-1", "gen-2", "sess-3", 0);
    assert.equal(a, b);
  });

  it("synthesized form uses the message index", () => {
    assert.equal(
      computeHarnessMessageId(undefined, undefined, "sid", 0),
      "sid:m0",
    );
    assert.equal(
      computeHarnessMessageId(undefined, undefined, "sid", 5),
      "sid:m5",
    );
  });

  it("canonical form embeds conversation_id and generation_id for backfill correlation", () => {
    // The format "cursor:<cid>:<gid>:assistant" must be stable because the
    // token-backfill drain uses it to upsert the placeholder row.
    const id = computeHarnessMessageId("ABC", "XYZ", "sid", 0);
    assert.ok(id.startsWith("cursor:ABC:XYZ:"), `unexpected prefix: ${id}`);
    assert.ok(id.endsWith(":assistant"), `unexpected suffix: ${id}`);
  });
});

// ---------------------------------------------------------------------------
// computeHarnessToolCallId
// ---------------------------------------------------------------------------

describe("computeHarnessToolCallId", () => {
  it("uses tool_use_id when present", () => {
    const result = computeHarnessToolCallId("tool-abc", "sess-1", 0);
    assert.equal(result, "tool-abc");
  });

  it("falls back to synthesized form when tool_use_id is undefined", () => {
    const result = computeHarnessToolCallId(undefined, "sess-1", 0);
    assert.equal(result, "sess-1:tc0");
  });

  it("falls back to synthesized form when tool_use_id is empty string", () => {
    const result = computeHarnessToolCallId("", "sess-1", 3);
    assert.equal(result, "sess-1:tc3");
  });

  it("synthesized form uses the tool index", () => {
    assert.equal(computeHarnessToolCallId(undefined, "sid", 0), "sid:tc0");
    assert.equal(computeHarnessToolCallId(undefined, "sid", 1), "sid:tc1");
    assert.equal(computeHarnessToolCallId(undefined, "sid", 10), "sid:tc10");
  });

  it("synthesized form is deterministic", () => {
    const a = computeHarnessToolCallId(undefined, "sid", 4);
    const b = computeHarnessToolCallId(undefined, "sid", 4);
    assert.equal(a, b);
  });
});

// ---------------------------------------------------------------------------
// centralUuid
// ---------------------------------------------------------------------------

describe("centralUuid", () => {
  it("returns a string matching UUID v4 format", () => {
    const uuid = centralUuid();
    assert.match(
      uuid,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("returns different values on successive calls", () => {
    assert.notEqual(centralUuid(), centralUuid());
  });
});
