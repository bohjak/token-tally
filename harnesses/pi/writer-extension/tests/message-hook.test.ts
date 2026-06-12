/**
 * message-hook.test.ts — Tests for the message_end hook's harness_message_id
 * selection.
 *
 * Verifies the canonical-ID invariant from the session-log drift findings:
 *   - When Pi's AssistantMessage carries a provider responseId, the recorded
 *     harness_message_id must be that responseId (matching the importer).
 *   - When responseId is absent (aborted/error responses), the hook falls
 *     back to the synthesized `${harnessSessionId}:t${turnIndex}:m${counter}`
 *     ID.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { register } from "../src/hooks/message.ts";
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
