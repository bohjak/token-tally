/**
 * hooks/turn.test.ts — Unit tests for hooks/turn.ts (T8).
 *
 * Tests are self-contained:
 * - Session state is seeded directly via setSession() so no live pi process
 *   is required and no T6 hook registration is needed.
 * - A minimal CollectorSink captures emitted analytics events for assertion.
 * - FakeExtensionAPI / FakeExtensionContext from T17 drive event dispatch.
 *
 * Covers:
 *   - register() sets up listeners without throwing
 *   - turn_start emits TurnStartEvent with correct fields
 *   - turn_start uses promptStartTs as started_at when available
 *   - turn_start falls back when no session is registered
 *   - model_select tracking feeds into subsequent turn_start events
 *   - thinking_level_select tracking feeds into subsequent turn_start events
 *   - after_provider_response emits ProviderResponseEvent with parsed headers
 *   - after_provider_response patches the in-flight turn record
 *   - message_end stashes stop_reason for turn_end
 *   - turn_end emits TurnEndEvent with stop_reason
 *   - turn_end prefers event.message.stopReason over stashed value
 *   - turn_end clears the active turn (getActiveTurnId returns null after)
 *   - getActiveTurnId returns correct values during the full lifecycle
 *   - rate-limit header parsing — various formats
 *   - no-op / graceful degradation for missing or malformed payloads
 *   - full turn lifecycle end-to-end
 *
 * Run: node --test src/hooks/turn.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { register, getActiveTurnId, setActiveModel } from "./turn.ts";
import { setSession, clearSession } from "./session-state.ts";
import {
  getLatestPromptId as _getLatestPromptId,
  getLatestPromptStartTs as _getLatestPromptStartTs,
} from "./input.ts";
import type {
  AnalyticsConfig,
  AnalyticsEvent,
  AnalyticsSink,
  TurnStartEvent,
  TurnEndEvent,
  ProviderResponseEvent,
} from "../sinks/types.ts";
import type { HookContext, PiContextStub } from "./types.ts";
import type { ExecFn } from "../git/capture.ts";
import { FakeExtensionAPI, FakeExtensionContext } from "../test-harness/harness.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal sink that collects every event written to it. */
class CollectorSink implements AnalyticsSink {
  readonly events: AnalyticsEvent[] = [];

  async init(): Promise<void> {}

  write(event: AnalyticsEvent): void {
    this.events.push(event);
  }

  async flush(): Promise<void> {}
  async close(): Promise<void> {}

  /** All events of a given kind. */
  all<K extends AnalyticsEvent["kind"]>(
    kind: K,
  ): Extract<AnalyticsEvent, { kind: K }>[] {
    return this.events.filter(
      (e): e is Extract<AnalyticsEvent, { kind: K }> => e.kind === kind,
    );
  }

  /** First event of a given kind, or undefined. */
  first<K extends AnalyticsEvent["kind"]>(
    kind: K,
  ): Extract<AnalyticsEvent, { kind: K }> | undefined {
    return this.all(kind)[0];
  }

  /** Clear all collected events (used in beforeEach). */
  clear(): void {
    this.events.length = 0;
  }
}

/** No-op ExecFn — turn hook doesn't call exec. */
const noop_exec: ExecFn = async () => ({ stdout: "", stderr: "", exitCode: 0 });

const TEST_CONFIG: AnalyticsConfig = {
  local: {
    enabled: true,
    dbPath: "~/.pi/analytics/events.db",
    rawLogDir: "~/.pi/analytics/raw",
  },
  privacy: {
    storePrompts: "hashed",
    storeToolArgs: "summary",
    storeToolOutputs: "size-only",
    redactPatterns: [],
  },
  git: { enabled: true, fetchPR: true, ghTimeoutMs: 2000 },
};

const HOOK_CTX: HookContext = { config: TEST_CONFIG, exec: noop_exec };

/** Build a PiContextStub for a given session file. */
function makeCtx(sessionFile: string | null): PiContextStub {
  return {
    cwd: "/tmp/test-repo",
    sessionManager: { getSessionFile: () => sessionFile },
    signal: undefined,
  };
}

// Unique session file per test group to avoid state bleed.
const SESSION_FILE = "/tmp/turn-test.jsonl";
const SESSION_ID = "turn-test-session-001";

// ---------------------------------------------------------------------------
// Per-test setup: seed a fresh session entry so getActiveSessionId() works.
// ---------------------------------------------------------------------------

function seedSession(
  sessionFile: string = SESSION_FILE,
  sessionId: string = SESSION_ID,
): void {
  setSession(sessionFile, {
    sessionId,
    headShaStart: null,
    branchStart: null,
    cwd: "/tmp/test-repo",
  });
}

function clearTestSession(sessionFile: string = SESSION_FILE): void {
  clearSession(sessionFile);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("hooks/turn — register()", () => {
  it("registers listeners without throwing", () => {
    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    assert.doesNotThrow(() => register(api, sink, HOOK_CTX));
  });

  it("registers handlers for all six expected events", () => {
    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, HOOK_CTX);

    const events = [
      "model_select",
      "thinking_level_select",
      "turn_start",
      "after_provider_response",
      "message_end",
      "turn_end",
    ];
    for (const evt of events) {
      assert.ok(
        (api.listeners.get(evt)?.length ?? 0) >= 1,
        `handler for '${evt}' should be registered`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// turn_start
// ---------------------------------------------------------------------------

describe("hooks/turn — turn_start", () => {
  beforeEach(() => {
    seedSession();
  });

  it("emits one turn_start event per turn_start call", async () => {
    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, HOOK_CTX);

    await api.emit(
      "turn_start",
      { turnIndex: 0, timestamp: Date.now() },
      new FakeExtensionContext("/repo", SESSION_FILE),
    );

    assert.equal(sink.all("turn_start").length, 1);
    clearTestSession();
  });

  it("populates session_id from session-state registry", async () => {
    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, HOOK_CTX);

    await api.emit(
      "turn_start",
      { turnIndex: 0, timestamp: Date.now() },
      new FakeExtensionContext("/repo", SESSION_FILE),
    );

    const ev = sink.first("turn_start")!;
    assert.equal(ev.session_id, SESSION_ID);
    clearTestSession();
  });

  it("uses turnIndex as idx", async () => {
    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, HOOK_CTX);

    await api.emit(
      "turn_start",
      { turnIndex: 3, timestamp: Date.now() },
      new FakeExtensionContext("/repo", SESSION_FILE),
    );

    const ev = sink.first("turn_start")!;
    assert.equal(ev.idx, 3);
    clearTestSession();
  });

  it("generates a non-empty string turn id", async () => {
    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, HOOK_CTX);

    await api.emit(
      "turn_start",
      { turnIndex: 0, timestamp: Date.now() },
      new FakeExtensionContext("/repo", SESSION_FILE),
    );

    const ev = sink.first("turn_start")!;
    assert.ok(typeof ev.id === "string" && ev.id.length > 0);
    clearTestSession();
  });

  it("uses pi's event.timestamp as started_at when no before_agent_start timestamp", async () => {
    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, HOOK_CTX);

    // Use a distinct timestamp so the assertion is unambiguous.
    const piTs = 1_700_000_000_000;
    await api.emit(
      "turn_start",
      { turnIndex: 0, timestamp: piTs },
      new FakeExtensionContext("/repo", SESSION_FILE),
    );

    const ev = sink.first("turn_start")!;
    // When no before_agent_start has fired, getLatestPromptStartTs returns null,
    // so started_at falls back to event.timestamp.
    assert.equal(ev.started_at, piTs);
    clearTestSession();
  });

  it("model_id and provider are null when no model_select has fired", async () => {
    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, HOOK_CTX);

    await api.emit(
      "turn_start",
      { turnIndex: 0, timestamp: Date.now() },
      new FakeExtensionContext("/repo", SESSION_FILE),
    );

    const ev = sink.first("turn_start")!;
    assert.equal(ev.model_id, null);
    assert.equal(ev.provider, null);
    clearTestSession();
  });

  it("thinking_level is null when no thinking_level_select has fired", async () => {
    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, HOOK_CTX);

    await api.emit(
      "turn_start",
      { turnIndex: 0, timestamp: Date.now() },
      new FakeExtensionContext("/repo", SESSION_FILE),
    );

    const ev = sink.first("turn_start")!;
    assert.equal(ev.thinking_level, null);
    clearTestSession();
  });

  it("prompt_id is 'unknown' when no prompt has been recorded yet", async () => {
    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, HOOK_CTX);

    // Seed a fresh session that has never seen an `input` event.
    const freshFile = "/tmp/fresh-session.jsonl";
    setSession(freshFile, {
      sessionId: "fresh-session-id",
      headShaStart: null,
      branchStart: null,
      cwd: "/tmp",
    });

    await api.emit(
      "turn_start",
      { turnIndex: 0, timestamp: Date.now() },
      new FakeExtensionContext("/repo", freshFile),
    );

    const ev = sink.first("turn_start")!;
    assert.equal(ev.prompt_id, "unknown");
    clearSession(freshFile);
  });

  it("does not throw or emit when no session is registered", async () => {
    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, HOOK_CTX);

    // No setSession() call for this file → getActiveSessionId returns null.
    await api.emit(
      "turn_start",
      { turnIndex: 0, timestamp: Date.now() },
      new FakeExtensionContext("/repo", "/tmp/no-session.jsonl"),
    );

    assert.equal(sink.all("turn_start").length, 0, "no event when session missing");
  });
});

// ---------------------------------------------------------------------------
// model_select tracking → turn_start denormalization
// ---------------------------------------------------------------------------

describe("hooks/turn — model_select tracking", () => {
  it("model_id and provider from model_select appear in subsequent turn_start", async () => {
    const sessionFile = "/tmp/model-track.jsonl";
    setSession(sessionFile, {
      sessionId: "model-track-001",
      headShaStart: null,
      branchStart: null,
      cwd: "/tmp",
    });

    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, HOOK_CTX);
    const ctx = new FakeExtensionContext("/repo", sessionFile);

    await api.emit(
      "model_select",
      { model: { id: "claude-opus-4-5", provider: "anthropic" }, source: "set" },
      ctx,
    );

    await api.emit("turn_start", { turnIndex: 0, timestamp: Date.now() }, ctx);

    const ev = sink.first("turn_start")!;
    assert.equal(ev.model_id, "claude-opus-4-5");
    assert.equal(ev.provider, "anthropic");
    clearSession(sessionFile);
  });

  it("model_select before session_start is silently ignored", async () => {
    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, HOOK_CTX);

    // No session registered for this file.
    const ctx = new FakeExtensionContext("/repo", "/tmp/no-session-model.jsonl");

    await api.emit(
      "model_select",
      { model: { id: "claude-opus-4-5", provider: "anthropic" }, source: "set" },
      ctx,
    );
    // No assertion needed — just verify no throw.
  });

  it("provider defaults to null when absent from model event", async () => {
    const sessionFile = "/tmp/no-provider.jsonl";
    setSession(sessionFile, {
      sessionId: "no-provider-001",
      headShaStart: null,
      branchStart: null,
      cwd: "/tmp",
    });

    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, HOOK_CTX);
    const ctx = new FakeExtensionContext("/repo", sessionFile);

    await api.emit(
      "model_select",
      { model: { id: "local-model" }, source: "set" }, // no provider field
      ctx,
    );
    await api.emit("turn_start", { turnIndex: 0, timestamp: Date.now() }, ctx);

    const ev = sink.first("turn_start")!;
    assert.equal(ev.provider, null);
    clearSession(sessionFile);
  });
});

// ---------------------------------------------------------------------------
// thinking_level_select tracking → turn_start denormalization
// ---------------------------------------------------------------------------

describe("hooks/turn — thinking_level_select tracking", () => {
  it("thinking_level from thinking_level_select appears in subsequent turn_start", async () => {
    const sessionFile = "/tmp/thinking-track.jsonl";
    setSession(sessionFile, {
      sessionId: "thinking-track-001",
      headShaStart: null,
      branchStart: null,
      cwd: "/tmp",
    });

    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, HOOK_CTX);
    const ctx = new FakeExtensionContext("/repo", sessionFile);

    await api.emit(
      "thinking_level_select",
      { level: "high", previousLevel: "low" },
      ctx,
    );

    await api.emit("turn_start", { turnIndex: 0, timestamp: Date.now() }, ctx);

    const ev = sink.first("turn_start")!;
    assert.equal(ev.thinking_level, "high");
    clearSession(sessionFile);
  });
});

// ---------------------------------------------------------------------------
// after_provider_response
// ---------------------------------------------------------------------------

describe("hooks/turn — after_provider_response", () => {
  it("emits one provider_response event per call", async () => {
    const sessionFile = "/tmp/apr-basic.jsonl";
    setSession(sessionFile, {
      sessionId: "apr-basic-001",
      headShaStart: null,
      branchStart: null,
      cwd: "/tmp",
    });

    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, HOOK_CTX);
    const ctx = new FakeExtensionContext("/repo", sessionFile);

    // Must have an active turn first.
    await api.emit("turn_start", { turnIndex: 0, timestamp: Date.now() }, ctx);
    await api.emit(
      "after_provider_response",
      { status: 200, headers: {} },
      ctx,
    );

    assert.equal(sink.all("provider_response").length, 1);
    clearSession(sessionFile);
  });

  it("sets http_status from event.status", async () => {
    const sessionFile = "/tmp/apr-status.jsonl";
    setSession(sessionFile, {
      sessionId: "apr-status-001",
      headShaStart: null,
      branchStart: null,
      cwd: "/tmp",
    });

    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, HOOK_CTX);
    const ctx = new FakeExtensionContext("/repo", sessionFile);

    await api.emit("turn_start", { turnIndex: 0, timestamp: Date.now() }, ctx);
    await api.emit(
      "after_provider_response",
      { status: 429, headers: { "retry-after": "30" } },
      ctx,
    );

    const ev = sink.first("provider_response")!;
    assert.equal(ev.http_status, 429);
    clearSession(sessionFile);
  });

  it("parses anthropic ratelimit-remaining header", async () => {
    const sessionFile = "/tmp/apr-remaining.jsonl";
    setSession(sessionFile, {
      sessionId: "apr-remaining-001",
      headShaStart: null,
      branchStart: null,
      cwd: "/tmp",
    });

    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, HOOK_CTX);
    const ctx = new FakeExtensionContext("/repo", sessionFile);

    await api.emit("turn_start", { turnIndex: 0, timestamp: Date.now() }, ctx);
    await api.emit(
      "after_provider_response",
      {
        status: 200,
        headers: { "anthropic-ratelimit-requests-remaining": "42" },
      },
      ctx,
    );

    const ev = sink.first("provider_response")!;
    assert.equal(ev.ratelimit_remaining, 42);
    clearSession(sessionFile);
  });

  it("parses retry-after as relative seconds → Unix ms", async () => {
    const sessionFile = "/tmp/apr-retry.jsonl";
    setSession(sessionFile, {
      sessionId: "apr-retry-001",
      headShaStart: null,
      branchStart: null,
      cwd: "/tmp",
    });

    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, HOOK_CTX);
    const ctx = new FakeExtensionContext("/repo", sessionFile);

    const before = Date.now();
    await api.emit("turn_start", { turnIndex: 0, timestamp: Date.now() }, ctx);
    await api.emit(
      "after_provider_response",
      { status: 429, headers: { "retry-after": "60" } },
      ctx,
    );
    const after = Date.now();

    const ev = sink.first("provider_response")!;
    // ratelimit_reset should be approximately now + 60000 ms.
    assert.ok(ev.ratelimit_reset !== null, "ratelimit_reset should be set");
    assert.ok(
      ev.ratelimit_reset! >= before + 60_000 && ev.ratelimit_reset! <= after + 60_000,
      `ratelimit_reset (${ev.ratelimit_reset}) should be ~now+60s`,
    );
    clearSession(sessionFile);
  });

  it("parses anthropic ISO reset timestamp", async () => {
    const sessionFile = "/tmp/apr-iso.jsonl";
    setSession(sessionFile, {
      sessionId: "apr-iso-001",
      headShaStart: null,
      branchStart: null,
      cwd: "/tmp",
    });

    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, HOOK_CTX);
    const ctx = new FakeExtensionContext("/repo", sessionFile);

    await api.emit("turn_start", { turnIndex: 0, timestamp: Date.now() }, ctx);
    await api.emit(
      "after_provider_response",
      {
        status: 200,
        headers: {
          "anthropic-ratelimit-requests-reset": "2026-01-01T00:01:00.000Z",
        },
      },
      ctx,
    );

    const ev = sink.first("provider_response")!;
    assert.ok(ev.ratelimit_reset !== null, "ratelimit_reset should be set");
    assert.equal(ev.ratelimit_reset, Date.parse("2026-01-01T00:01:00.000Z"));
    clearSession(sessionFile);
  });

  it("sets ratelimit_remaining and ratelimit_reset to null when headers are empty", async () => {
    const sessionFile = "/tmp/apr-no-headers.jsonl";
    setSession(sessionFile, {
      sessionId: "apr-no-headers-001",
      headShaStart: null,
      branchStart: null,
      cwd: "/tmp",
    });

    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, HOOK_CTX);
    const ctx = new FakeExtensionContext("/repo", sessionFile);

    await api.emit("turn_start", { turnIndex: 0, timestamp: Date.now() }, ctx);
    await api.emit("after_provider_response", { status: 200, headers: {} }, ctx);

    const ev = sink.first("provider_response")!;
    assert.equal(ev.ratelimit_remaining, null);
    assert.equal(ev.ratelimit_reset, null);
    clearSession(sessionFile);
  });

  it("is a no-op when there is no active turn", async () => {
    const sessionFile = "/tmp/apr-no-turn.jsonl";
    setSession(sessionFile, {
      sessionId: "apr-no-turn-001",
      headShaStart: null,
      branchStart: null,
      cwd: "/tmp",
    });

    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, HOOK_CTX);
    const ctx = new FakeExtensionContext("/repo", sessionFile);

    // No turn_start → no active turn record.
    await api.emit(
      "after_provider_response",
      { status: 200, headers: {} },
      ctx,
    );

    assert.equal(sink.all("provider_response").length, 0);
    clearSession(sessionFile);
  });

  it("links the provider_response to the correct turn_id", async () => {
    const sessionFile = "/tmp/apr-turn-id.jsonl";
    setSession(sessionFile, {
      sessionId: "apr-turn-id-001",
      headShaStart: null,
      branchStart: null,
      cwd: "/tmp",
    });

    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, HOOK_CTX);
    const ctx = new FakeExtensionContext("/repo", sessionFile);

    await api.emit("turn_start", { turnIndex: 0, timestamp: Date.now() }, ctx);
    await api.emit("after_provider_response", { status: 200, headers: {} }, ctx);

    const turnStartEv = sink.first("turn_start")!;
    const providerEv = sink.first("provider_response")!;
    assert.equal(providerEv.turn_id, turnStartEv.id);
    clearSession(sessionFile);
  });
});

// ---------------------------------------------------------------------------
// message_end → stop_reason stash
// ---------------------------------------------------------------------------

describe("hooks/turn — message_end stop_reason stash", () => {
  it("stashes stop_reason from message_end.message.stopReason", async () => {
    const sessionFile = "/tmp/msg-end-stop.jsonl";
    setSession(sessionFile, {
      sessionId: "msg-end-stop-001",
      headShaStart: null,
      branchStart: null,
      cwd: "/tmp",
    });

    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, HOOK_CTX);
    const ctx = new FakeExtensionContext("/repo", sessionFile);

    await api.emit("turn_start", { turnIndex: 0, timestamp: Date.now() }, ctx);
    await api.emit(
      "message_end",
      { message: { role: "assistant", stopReason: "end_turn" } },
      ctx,
    );
    // Verify it reaches turn_end.
    await api.emit(
      "turn_end",
      { turnIndex: 0, message: { role: "assistant" }, toolResults: [] },
      ctx,
    );

    const ev = sink.first("turn_end")!;
    assert.equal(ev.stop_reason, "end_turn");
    clearSession(sessionFile);
  });

  it("ignores message_end events for non-assistant roles", async () => {
    const sessionFile = "/tmp/msg-end-user.jsonl";
    setSession(sessionFile, {
      sessionId: "msg-end-user-001",
      headShaStart: null,
      branchStart: null,
      cwd: "/tmp",
    });

    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, HOOK_CTX);
    const ctx = new FakeExtensionContext("/repo", sessionFile);

    await api.emit("turn_start", { turnIndex: 0, timestamp: Date.now() }, ctx);
    await api.emit(
      "message_end",
      { message: { role: "user", stopReason: "end_turn" } }, // role != assistant
      ctx,
    );
    await api.emit(
      "turn_end",
      { turnIndex: 0, message: { role: "assistant" }, toolResults: [] },
      ctx,
    );

    const ev = sink.first("turn_end")!;
    // stop_reason should remain null since the message_end was from a user.
    assert.equal(ev.stop_reason, null);
    clearSession(sessionFile);
  });
});

// ---------------------------------------------------------------------------
// turn_end
// ---------------------------------------------------------------------------

describe("hooks/turn — turn_end", () => {
  it("emits one turn_end event per turn lifecycle", async () => {
    const sessionFile = "/tmp/turn-end-basic.jsonl";
    setSession(sessionFile, {
      sessionId: "turn-end-basic-001",
      headShaStart: null,
      branchStart: null,
      cwd: "/tmp",
    });

    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, HOOK_CTX);
    const ctx = new FakeExtensionContext("/repo", sessionFile);

    await api.emit("turn_start", { turnIndex: 0, timestamp: Date.now() }, ctx);
    await api.emit(
      "turn_end",
      { turnIndex: 0, message: { role: "assistant" }, toolResults: [] },
      ctx,
    );

    assert.equal(sink.all("turn_end").length, 1);
    clearSession(sessionFile);
  });

  it("turn_end.turn_id matches turn_start.id", async () => {
    const sessionFile = "/tmp/turn-end-id.jsonl";
    setSession(sessionFile, {
      sessionId: "turn-end-id-001",
      headShaStart: null,
      branchStart: null,
      cwd: "/tmp",
    });

    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, HOOK_CTX);
    const ctx = new FakeExtensionContext("/repo", sessionFile);

    await api.emit("turn_start", { turnIndex: 0, timestamp: Date.now() }, ctx);
    await api.emit(
      "turn_end",
      { turnIndex: 0, message: { role: "assistant" }, toolResults: [] },
      ctx,
    );

    const startEv = sink.first("turn_start")!;
    const endEv = sink.first("turn_end")!;
    assert.equal(endEv.turn_id, startEv.id);
    clearSession(sessionFile);
  });

  it("prefers stop_reason from event.message.stopReason over stashed value", async () => {
    const sessionFile = "/tmp/turn-end-stopreason.jsonl";
    setSession(sessionFile, {
      sessionId: "turn-end-sr-001",
      headShaStart: null,
      branchStart: null,
      cwd: "/tmp",
    });

    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, HOOK_CTX);
    const ctx = new FakeExtensionContext("/repo", sessionFile);

    await api.emit("turn_start", { turnIndex: 0, timestamp: Date.now() }, ctx);
    // Stash via message_end.
    await api.emit(
      "message_end",
      { message: { role: "assistant", stopReason: "stashed_reason" } },
      ctx,
    );
    // turn_end overrides with its own message.stopReason.
    await api.emit(
      "turn_end",
      {
        turnIndex: 0,
        message: { role: "assistant", stopReason: "event_reason" },
        toolResults: [],
      },
      ctx,
    );

    const ev = sink.first("turn_end")!;
    assert.equal(ev.stop_reason, "event_reason");
    clearSession(sessionFile);
  });

  // Regression: NULL-MODEL-INVESTIGATION.md.  Pre-fix, turn_end read
  // model_id from the snapshot frozen at turn_start time.  T9's
  // setActiveModel call (during message_end, between turn_start and
  // turn_end) updated activeModels but the turn_end UPDATE never re-read
  // it — so turn 0 of every fresh session whose user did not invoke
  // /model wrote NULL.  This test simulates that exact ordering and
  // asserts the turn_end event picks up the model that was set after
  // turn_start.
  it("turn_end picks up model_id set after turn_start (regression: idx-0 of fresh session)", async () => {
    const sessionFile = "/tmp/turn-end-late-model.jsonl";
    const sessionId = "turn-end-late-model-001";
    setSession(sessionFile, {
      sessionId,
      headShaStart: null,
      branchStart: null,
      cwd: "/tmp",
    });

    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, HOOK_CTX);
    const ctx = new FakeExtensionContext("/repo", sessionFile);

    // turn_start fires WITHOUT any prior model_select — the bug condition.
    await api.emit("turn_start", { turnIndex: 0, timestamp: Date.now() }, ctx);

    // Mid-turn, T9's message_end equivalent runs and sets the active model.
    setActiveModel(sessionId, "claude-haiku-4-5", "anthropic");

    // turn_end fires.  Pre-fix this wrote model_id=null.
    await api.emit(
      "turn_end",
      { turnIndex: 0, message: { role: "assistant" }, toolResults: [] },
      ctx,
    );

    const endEv = sink.first("turn_end")!;
    assert.equal(endEv.model_id, "claude-haiku-4-5",
      "turn_end should pick up model set after turn_start");
    assert.equal(endEv.provider, "anthropic",
      "turn_end should pick up provider set after turn_start");

    clearSession(sessionFile);
  });

  // Companion: an explicit pre-turn model_select should still take effect
  // (we don't want the fix to regress the path that already worked).
  it("turn_end uses model_select that fired BEFORE turn_start", async () => {
    const sessionFile = "/tmp/turn-end-pre-select.jsonl";
    const sessionId = "turn-end-pre-select-001";
    setSession(sessionFile, {
      sessionId,
      headShaStart: null,
      branchStart: null,
      cwd: "/tmp",
    });

    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, HOOK_CTX);
    const ctx = new FakeExtensionContext("/repo", sessionFile);

    // /model fires before turn_start — the path that already worked pre-fix.
    await api.emit(
      "model_select",
      { model: { id: "claude-opus-4-7", provider: "anthropic" }, source: "user" },
      ctx,
    );
    await api.emit("turn_start", { turnIndex: 0, timestamp: Date.now() }, ctx);
    await api.emit(
      "turn_end",
      { turnIndex: 0, message: { role: "assistant" }, toolResults: [] },
      ctx,
    );

    const endEv = sink.first("turn_end")!;
    assert.equal(endEv.model_id, "claude-opus-4-7");
    assert.equal(endEv.provider, "anthropic");

    clearSession(sessionFile);
  });

  // When BOTH paths fire, the later setActiveModel value wins (it reflects
  // what the provider actually returned).
  it("turn_end uses the most recent setActiveModel value when both paths fire", async () => {
    const sessionFile = "/tmp/turn-end-both.jsonl";
    const sessionId = "turn-end-both-001";
    setSession(sessionFile, {
      sessionId,
      headShaStart: null,
      branchStart: null,
      cwd: "/tmp",
    });

    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, HOOK_CTX);
    const ctx = new FakeExtensionContext("/repo", sessionFile);

    await api.emit(
      "model_select",
      { model: { id: "claude-opus-4-7", provider: "anthropic" }, source: "user" },
      ctx,
    );
    await api.emit("turn_start", { turnIndex: 0, timestamp: Date.now() }, ctx);
    // Provider returned a different actual model id (e.g. dated alias).
    setActiveModel(sessionId, "claude-opus-4-7-20251024", "anthropic");
    await api.emit(
      "turn_end",
      { turnIndex: 0, message: { role: "assistant" }, toolResults: [] },
      ctx,
    );

    const endEv = sink.first("turn_end")!;
    assert.equal(endEv.model_id, "claude-opus-4-7-20251024",
      "the actual model returned by the provider should win");

    clearSession(sessionFile);
  });

  it("clears the active turn after turn_end (getActiveTurnId returns null)", async () => {
    const sessionFile = "/tmp/turn-clear.jsonl";
    setSession(sessionFile, {
      sessionId: "turn-clear-001",
      headShaStart: null,
      branchStart: null,
      cwd: "/tmp",
    });

    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, HOOK_CTX);
    const ctx = new FakeExtensionContext("/repo", sessionFile);

    await api.emit("turn_start", { turnIndex: 0, timestamp: Date.now() }, ctx);
    assert.ok(
      getActiveTurnId("turn-clear-001") !== null,
      "turn id should be set after turn_start",
    );

    await api.emit(
      "turn_end",
      { turnIndex: 0, message: { role: "assistant" }, toolResults: [] },
      ctx,
    );

    assert.equal(
      getActiveTurnId("turn-clear-001"),
      null,
      "turn id should be null after turn_end",
    );
    clearSession(sessionFile);
  });

  it("does not throw or emit when turn_end fires without a prior turn_start", async () => {
    const sessionFile = "/tmp/turn-end-orphan.jsonl";
    setSession(sessionFile, {
      sessionId: "turn-end-orphan-001",
      headShaStart: null,
      branchStart: null,
      cwd: "/tmp",
    });

    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, HOOK_CTX);
    const ctx = new FakeExtensionContext("/repo", sessionFile);

    await assert.doesNotReject(
      api.emit(
        "turn_end",
        { turnIndex: 0, message: { role: "assistant" }, toolResults: [] },
        ctx,
      ),
    );
    assert.equal(sink.all("turn_end").length, 0, "no event when no active turn");
    clearSession(sessionFile);
  });
});

// ---------------------------------------------------------------------------
// getActiveTurnId()
// ---------------------------------------------------------------------------

describe("getActiveTurnId()", () => {
  it("returns null before any turn_start fires", () => {
    assert.equal(getActiveTurnId("never-seen-session"), null);
  });

  it("returns the turn ID after turn_start and null after turn_end", async () => {
    const sessionFile = "/tmp/gat-lifecycle.jsonl";
    setSession(sessionFile, {
      sessionId: "gat-lifecycle-001",
      headShaStart: null,
      branchStart: null,
      cwd: "/tmp",
    });

    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, HOOK_CTX);
    const ctx = new FakeExtensionContext("/repo", sessionFile);

    assert.equal(getActiveTurnId("gat-lifecycle-001"), null);

    await api.emit("turn_start", { turnIndex: 0, timestamp: Date.now() }, ctx);
    const turnId = getActiveTurnId("gat-lifecycle-001");
    assert.ok(typeof turnId === "string" && turnId.length > 0, "turn ID set");

    // The ID in the map must match what was emitted.
    const startEv = sink.first("turn_start")!;
    assert.equal(turnId, startEv.id);

    await api.emit(
      "turn_end",
      { turnIndex: 0, message: { role: "assistant" }, toolResults: [] },
      ctx,
    );

    assert.equal(getActiveTurnId("gat-lifecycle-001"), null, "cleared after turn_end");
    clearSession(sessionFile);
  });

  it("returns distinct IDs for sequential turns in the same session", async () => {
    const sessionFile = "/tmp/gat-sequential.jsonl";
    setSession(sessionFile, {
      sessionId: "gat-seq-001",
      headShaStart: null,
      branchStart: null,
      cwd: "/tmp",
    });

    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, HOOK_CTX);
    const ctx = new FakeExtensionContext("/repo", sessionFile);

    await api.emit("turn_start", { turnIndex: 0, timestamp: Date.now() }, ctx);
    const id0 = getActiveTurnId("gat-seq-001")!;
    await api.emit(
      "turn_end",
      { turnIndex: 0, message: { role: "assistant" }, toolResults: [] },
      ctx,
    );

    await api.emit("turn_start", { turnIndex: 1, timestamp: Date.now() }, ctx);
    const id1 = getActiveTurnId("gat-seq-001")!;
    await api.emit(
      "turn_end",
      { turnIndex: 1, message: { role: "assistant" }, toolResults: [] },
      ctx,
    );

    assert.notEqual(id0, id1, "sequential turns should have distinct IDs");
    clearSession(sessionFile);
  });
});

// ---------------------------------------------------------------------------
// Full turn lifecycle end-to-end
// ---------------------------------------------------------------------------

describe("hooks/turn — full lifecycle", () => {
  it("all three event kinds are emitted in the correct sequence", async () => {
    const sessionFile = "/tmp/lifecycle-full.jsonl";
    setSession(sessionFile, {
      sessionId: "lifecycle-full-001",
      headShaStart: null,
      branchStart: null,
      cwd: "/tmp",
    });

    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, HOOK_CTX);
    const ctx = new FakeExtensionContext("/repo", sessionFile);

    // Simulate a model being active before the turn.
    await api.emit(
      "model_select",
      { model: { id: "claude-sonnet-4-5", provider: "anthropic" }, source: "set" },
      ctx,
    );

    // Turn lifecycle.
    await api.emit("turn_start", { turnIndex: 0, timestamp: 1_700_100_000_000 }, ctx);
    await api.emit(
      "after_provider_response",
      {
        status: 200,
        headers: {
          "anthropic-ratelimit-requests-remaining": "99",
          "anthropic-ratelimit-requests-reset": "2026-06-01T00:00:00.000Z",
        },
      },
      ctx,
    );
    await api.emit(
      "message_end",
      {
        message: {
          role: "assistant",
          stopReason: "end_turn",
          usage: { inputTokens: 100, outputTokens: 20 },
        },
      },
      ctx,
    );
    await api.emit(
      "turn_end",
      { turnIndex: 0, message: { role: "assistant" }, toolResults: [] },
      ctx,
    );

    // Verify event counts.
    assert.equal(sink.all("turn_start").length, 1);
    assert.equal(sink.all("provider_response").length, 1);
    assert.equal(sink.all("turn_end").length, 1);

    // Verify turn_start fields.
    const startEv = sink.first("turn_start") as TurnStartEvent;
    assert.equal(startEv.session_id, "lifecycle-full-001");
    assert.equal(startEv.model_id, "claude-sonnet-4-5");
    assert.equal(startEv.provider, "anthropic");
    assert.equal(startEv.started_at, 1_700_100_000_000);

    // Verify provider_response fields.
    const provEv = sink.first("provider_response") as ProviderResponseEvent;
    assert.equal(provEv.turn_id, startEv.id);
    assert.equal(provEv.http_status, 200);
    assert.equal(provEv.ratelimit_remaining, 99);
    assert.equal(provEv.ratelimit_reset, Date.parse("2026-06-01T00:00:00.000Z"));

    // Verify turn_end fields.
    const endEv = sink.first("turn_end") as TurnEndEvent;
    assert.equal(endEv.turn_id, startEv.id);
    assert.equal(endEv.session_id, "lifecycle-full-001");
    assert.equal(endEv.stop_reason, "end_turn");
    assert.equal(endEv.model_id, "claude-sonnet-4-5");

    // Active turn should be cleared.
    assert.equal(getActiveTurnId("lifecycle-full-001"), null);
    clearSession(sessionFile);
  });

  it("two-turn session: each turn gets a distinct ID and events are linked correctly", async () => {
    const sessionFile = "/tmp/lifecycle-two-turns.jsonl";
    setSession(sessionFile, {
      sessionId: "lifecycle-two-001",
      headShaStart: null,
      branchStart: null,
      cwd: "/tmp",
    });

    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, HOOK_CTX);
    const ctx = new FakeExtensionContext("/repo", sessionFile);

    // Turn 0.
    await api.emit("turn_start", { turnIndex: 0, timestamp: Date.now() }, ctx);
    await api.emit("after_provider_response", { status: 200, headers: {} }, ctx);
    await api.emit(
      "message_end",
      { message: { role: "assistant", stopReason: "tool_use" } },
      ctx,
    );
    await api.emit(
      "turn_end",
      { turnIndex: 0, message: { role: "assistant" }, toolResults: [] },
      ctx,
    );

    // Turn 1.
    await api.emit("turn_start", { turnIndex: 1, timestamp: Date.now() + 1000 }, ctx);
    await api.emit("after_provider_response", { status: 200, headers: {} }, ctx);
    await api.emit(
      "message_end",
      { message: { role: "assistant", stopReason: "end_turn" } },
      ctx,
    );
    await api.emit(
      "turn_end",
      { turnIndex: 1, message: { role: "assistant" }, toolResults: [] },
      ctx,
    );

    const starts = sink.all("turn_start");
    const ends = sink.all("turn_end");
    const provs = sink.all("provider_response");

    assert.equal(starts.length, 2, "two turn_start events");
    assert.equal(ends.length, 2, "two turn_end events");
    assert.equal(provs.length, 2, "two provider_response events");

    // IDs are distinct.
    assert.notEqual(starts[0]!.id, starts[1]!.id);

    // Each end links to its own start.
    assert.equal(ends[0]!.turn_id, starts[0]!.id);
    assert.equal(ends[1]!.turn_id, starts[1]!.id);

    // stop_reason preserved per turn.
    assert.equal(ends[0]!.stop_reason, "tool_use");
    assert.equal(ends[1]!.stop_reason, "end_turn");

    clearSession(sessionFile);
  });

  it("does not throw on malformed event payloads", async () => {
    const sessionFile = "/tmp/lifecycle-malformed.jsonl";
    setSession(sessionFile, {
      sessionId: "lifecycle-malformed-001",
      headShaStart: null,
      branchStart: null,
      cwd: "/tmp",
    });

    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, HOOK_CTX);
    const ctx = new FakeExtensionContext("/repo", sessionFile);

    // Null payloads should not throw.
    await assert.doesNotReject(api.emit("turn_start", null, ctx));
    await assert.doesNotReject(api.emit("after_provider_response", null, ctx));
    await assert.doesNotReject(api.emit("message_end", null, ctx));
    await assert.doesNotReject(api.emit("turn_end", null, ctx));

    clearSession(sessionFile);
  });
});
