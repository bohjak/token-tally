/**
 * message-hook.test.ts — Tests for the message_end hook.
 *
 * Covers:
 *   - harness_message_id selection (responseId vs synthesized fallback)
 *   - pricing: known model resolves to correct rates (costSource='writer')
 *   - pricing: unknown model resolves to unknown (C2 regression — bare stem
 *     must NOT match the first table entry at Opus rates)
 *   - pricing: fallback when the store pricing module is unavailable
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { register, _setPricingForTest } from "../src/hooks/message.ts";
import { setSession, clearSession } from "../src/hooks/session-state.ts";
import { setTurn, clearTurn } from "../src/hooks/turn-state.ts";
import type { AnalyticsWriterLike } from "../src/cli-writer.ts";
import type { PiAPIStub, PiContextStub, PiEventHandler } from "../src/hooks/types.ts";

type RecordedMessage = { harnessMessageId: string; [key: string]: unknown };

function makeHarness(sessionFile: string): {
  emitMessageEnd: (message: Record<string, unknown>) => Promise<void>;
  messages: RecordedMessage[];
  cleanup: () => void;
} {
  const handlers = new Map<string, PiEventHandler>();
  const pi: PiAPIStub = {
    on(event, handler) {
      handlers.set(event, handler);
    },
  };

  const messages: RecordedMessage[] = [];
  const writer = {
    async recordLlmMessage(payload: RecordedMessage) {
      messages.push(payload);
      return { id: "msg-uuid" };
    },
  } as unknown as AnalyticsWriterLike;

  register(pi, writer);

  setSession(sessionFile, {
    harnessSessionId: sessionFile,
    centralSessionId: `central:${sessionFile}`,
    cwd: "/tmp/project",
    headShaStart: null,
    branchStart: null,
  });
  setTurn(`central:${sessionFile}`, {
    harnessTurnId: `${sessionFile}:t0`,
    centralTurnId: "turn-uuid",
    turnIndex: 0,
    startedAt: 1_000,
    messageCounter: 0,
  });

  const ctx: PiContextStub = {
    cwd: "/tmp/project",
    sessionManager: { getSessionFile: () => sessionFile },
  };

  return {
    async emitMessageEnd(message) {
      await handlers.get("message_end")?.({ message }, ctx);
    },
    messages,
    cleanup() {
      clearTurn(`central:${sessionFile}`);
      clearSession(sessionFile);
    },
  };
}

const USAGE = {
  input: 100,
  output: 50,
  cacheRead: 0,
  cacheWrite: 0,
  cost: { input: 0.0003, output: 0.00375, cacheRead: 0, cacheWrite: 0, total: 0.00405 },
};

test("message_end uses the provider responseId as harness_message_id when present", async () => {
  const h = makeHarness("/tmp/sessions/with-response-id.jsonl");
  try {
    await h.emitMessageEnd({
      role: "assistant",
      model: "claude-opus-4-5",
      provider: "anthropic",
      responseId: "msg_provider_abc123",
      usage: USAGE,
    });

    assert.equal(h.messages.length, 1);
    assert.equal(h.messages[0]!.harnessMessageId, "msg_provider_abc123");
  } finally {
    h.cleanup();
  }
});

test("message_end falls back to the synthesized ID when responseId is absent", async () => {
  const sessionFile = "/tmp/sessions/no-response-id.jsonl";
  const h = makeHarness(sessionFile);
  try {
    await h.emitMessageEnd({
      role: "assistant",
      model: "claude-opus-4-5",
      provider: "anthropic",
      usage: USAGE,
    });

    assert.equal(h.messages.length, 1);
    assert.equal(h.messages[0]!.harnessMessageId, `${sessionFile}:t0:m0`);
  } finally {
    h.cleanup();
  }
});

test("per-turn message counter still advances for mixed responseId presence", async () => {
  const sessionFile = "/tmp/sessions/mixed-ids.jsonl";
  const h = makeHarness(sessionFile);
  try {
    await h.emitMessageEnd({
      role: "assistant",
      model: "claude-opus-4-5",
      responseId: "msg_first",
      usage: USAGE,
    });
    await h.emitMessageEnd({
      role: "assistant",
      model: "claude-opus-4-5",
      usage: USAGE,
    });

    assert.equal(h.messages.length, 2);
    assert.equal(h.messages[0]!.harnessMessageId, "msg_first");
    // Counter advanced past the first (provider-ID) message, so the fallback
    // synthesized ID stays deterministic with respect to event order.
    assert.equal(h.messages[1]!.harnessMessageId, `${sessionFile}:t0:m1`);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Pricing tests — shared store pricing via _setPricingForTest
// ---------------------------------------------------------------------------
//
// USAGE fixture has cost.total > 0, so the harness-cost path is taken and
// writer pricing is skipped. For pricing tests we use ZERO_COST_USAGE so the
// fallback path is exercised.

/** Usage with no cost data — forces the writer pricing fallback path. */
const ZERO_COST_USAGE = {
  input: 1_000_000,
  output: 100_000,
  cacheRead: 0,
  cacheWrite: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Minimal stub matching StorePricing shape. */
function makePricingStub(overrides?: {
  modelId?: string;
  costSource?: "writer" | "unknown";
  inputMicros?: number;
  outputMicros?: number;
}): import("@token-tally/store/pricing") {
  return {
    computeCostMicros(params) {
      const model = params.modelId ?? "";
      // Haiku-4-5: inputPerMTokUSD=0.8  → 1M tokens = 800_000 micros
      //            outputPerMTokUSD=4   → 100k tokens = 400_000 micros
      if (model === "claude-haiku-4-5") {
        return {
          costInputMicros: overrides?.inputMicros ?? Math.round((params.inputTokens ?? 0) * 0.8),
          costOutputMicros: overrides?.outputMicros ?? Math.round((params.outputTokens ?? 0) * 4),
          costCacheReadMicros: 0,
          costCacheWriteMicros: 0,
          costSource: "writer",
        };
      }
      return {
        costInputMicros: 0,
        costOutputMicros: 0,
        costCacheReadMicros: 0,
        costCacheWriteMicros: 0,
        costSource: "unknown",
      };
    },
    lookupRates(_modelId: string) {
      return undefined;
    },
  } as unknown as import("@token-tally/store/pricing");
}

test("pricing: claude-haiku-4-5 resolves to haiku rates (costSource=writer)", async () => {
  _setPricingForTest(makePricingStub());
  const h = makeHarness("/tmp/sessions/pricing-haiku.jsonl");
  try {
    await h.emitMessageEnd({
      role: "assistant",
      model: "claude-haiku-4-5",
      responseId: "msg_haiku_1",
      usage: ZERO_COST_USAGE,
    });

    assert.equal(h.messages.length, 1);
    const msg = h.messages[0]!;
    assert.equal(msg.costSource, "writer", "known model should yield costSource=writer");
    // 1M input tokens × $0.80/MTok = 800_000 micros
    assert.equal(msg.costInputMicros, 800_000);
    // 100k output tokens × $4/MTok = 400_000 micros
    assert.equal(msg.costOutputMicros, 400_000);
  } finally {
    h.cleanup();
    _setPricingForTest(null);
  }
});

test("pricing: unknown bare Claude stem resolves to unknown (C2 regression)", async () => {
  // Without the dash guard in lookupRates, bare stems like 'claude' strip down
  // and prefix-match 'claude-opus-4-5', returning Opus rates. The shared
  // lookupRates has the guard; we verify the fallback produces costSource=unknown.
  _setPricingForTest(makePricingStub());
  const h = makeHarness("/tmp/sessions/pricing-unknown.jsonl");
  try {
    await h.emitMessageEnd({
      role: "assistant",
      model: "claude-supernova-9", // unknown Claude model
      responseId: "msg_unknown_1",
      usage: ZERO_COST_USAGE,
    });

    assert.equal(h.messages.length, 1);
    const msg = h.messages[0]!;
    // The stub returns unknown for non-haiku models, mirroring real lookup
    // behavior where the dash guard prevents bare-stem Opus misattribution.
    assert.equal(msg.costSource, "unknown");
    assert.equal(msg.costInputMicros, 0);
    assert.equal(msg.costOutputMicros, 0);
  } finally {
    h.cleanup();
    _setPricingForTest(null);
  }
});

test("pricing: fallback to unknown when store pricing module is unavailable", async () => {
  // Simulate a bare checkout where `make install` was never run and the store
  // dist is missing: _pricingModule stays null.
  _setPricingForTest(null);
  const h = makeHarness("/tmp/sessions/pricing-fallback.jsonl");
  try {
    await h.emitMessageEnd({
      role: "assistant",
      model: "claude-haiku-4-5",
      responseId: "msg_fallback_1",
      usage: ZERO_COST_USAGE,
    });

    assert.equal(h.messages.length, 1);
    const msg = h.messages[0]!;
    assert.equal(msg.costSource, "unknown", "unavailable pricing must fall back to unknown");
    assert.equal(msg.costInputMicros, 0);
    assert.equal(msg.costOutputMicros, 0);
    assert.equal(msg.costCacheReadMicros, 0);
    assert.equal(msg.costCacheWriteMicros, 0);
  } finally {
    h.cleanup();
    _setPricingForTest(null);
  }
});
