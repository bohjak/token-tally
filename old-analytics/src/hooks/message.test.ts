/**
 * hooks/message.test.ts — Unit tests for hooks/message.ts (T9).
 *
 * Covers:
 *   - register() subscribes without throwing
 *   - message_end for role=assistant emits LlmMessageEvent
 *   - message_end for role=user is silently skipped (no event emitted)
 *   - message_end for role=toolResult is silently skipped
 *   - camelCase usage fields (pi reality) map correctly to snake_case event fields
 *   - missing usage fields default to 0
 *   - stopReason (camelCase) maps to stop_reason
 *   - stop_reason (snake_case fallback) is accepted
 *   - total_duration_ms is computed from turn_start → message_end delta
 *   - total_duration_ms falls back to message.timestamp when no turn_start seen
 *   - total_duration_ms is null when no timing data available
 *   - time_to_first_token_ms is always null
 *   - turn_end cleans up timing state (no stale timings on next turn)
 *   - no session registered → no event emitted
 *   - no turn active (turnId null) → event still emitted with turn_id="unknown"
 *   - handler errors are caught and console.warn'd (never throws)
 *   - event has correct FK fields: id, turn_id, session_id, role
 *   - full lifecycle: turn_start → message_end → turn_end
 *
 * Run: node --test src/hooks/message.test.ts
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

import { register } from "./message.ts";
import { setSession, clearSession } from "./session-state.ts";
import type {
  AnalyticsConfig,
  AnalyticsEvent,
  AnalyticsSink,
  LlmMessageEvent,
} from "../sinks/types.ts";
import type { HookContext, PiContextStub } from "./types.ts";
import type { ExecFn } from "../git/capture.ts";
import { FakeExtensionAPI, FakeExtensionContext } from "../test-harness/harness.ts";

// ---------------------------------------------------------------------------
// Test infrastructure
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

  clear(): void {
    this.events.length = 0;
  }
}

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

function makeCtx(sessionFile: string | null): PiContextStub {
  return {
    cwd: "/tmp/test-repo",
    sessionManager: { getSessionFile: () => sessionFile },
    signal: undefined,
  };
}

/** Build a realistic pi AssistantMessage usage block (camelCase, as per pi types). */
function makeUsage(overrides?: Partial<{
  input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
  costInput: number; costOutput: number; costCacheRead: number; costCacheWrite: number; costTotal: number;
}>) {
  return {
    input:       overrides?.input        ?? 100,
    output:      overrides?.output       ?? 200,
    cacheRead:   overrides?.cacheRead    ?? 50,
    cacheWrite:  overrides?.cacheWrite   ?? 25,
    totalTokens: overrides?.totalTokens  ?? 375,
    cost: {
      input:      overrides?.costInput     ?? 0.001,
      output:     overrides?.costOutput    ?? 0.004,
      cacheRead:  overrides?.costCacheRead ?? 0.0005,
      cacheWrite: overrides?.costCacheWrite?? 0.0003,
      total:      overrides?.costTotal     ?? 0.0058,
    },
  };
}

/** Build a minimal message_end payload for an assistant message. */
function makeMessageEndPayload(opts: {
  role?: string;
  stopReason?: string;
  stop_reason?: string;
  usage?: ReturnType<typeof makeUsage>;
  timestamp?: number;
  model?: string;
  provider?: string;
}) {
  return {
    message: {
      role:       opts.role ?? "assistant",
      stopReason: opts.stopReason,
      stop_reason: opts.stop_reason,
      usage:      opts.usage,
      timestamp:  opts.timestamp,
      model:      opts.model,
      provider:   opts.provider,
    },
  };
}

// Counter for unique session files across test groups
let sessionCounter = 0;
function uniqueSession(): { file: string; id: string } {
  sessionCounter++;
  const file = `/tmp/test-session-msg-${sessionCounter}.json`;
  const id = `session-msg-${sessionCounter}`;
  return { file, id };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("hooks/message — register()", () => {
  it("registers without throwing", () => {
    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    assert.doesNotThrow(() => register(api as any, sink, HOOK_CTX));
  });

  it("registers before_provider_request, turn_start, turn_end, and message_end listeners", () => {
    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api as any, sink, HOOK_CTX);
    // The harness exposes listeners via its internal map
    const events = (api as any).listeners as Map<string, unknown[]>;
    assert.ok(events.has("before_provider_request"), "should register before_provider_request");
    assert.ok(events.has("turn_start"),   "should register turn_start");
    assert.ok(events.has("turn_end"),     "should register turn_end");
    assert.ok(events.has("message_end"),  "should register message_end");
  });
});

describe("hooks/message — message_end role filtering", () => {
  let api: FakeExtensionAPI;
  let sink: CollectorSink;
  let sess: ReturnType<typeof uniqueSession>;
  let ctx: PiContextStub;

  beforeEach(() => {
    api  = new FakeExtensionAPI();
    sink = new CollectorSink();
    sess = uniqueSession();
    ctx  = makeCtx(sess.file);
    setSession(sess.file, { sessionId: sess.id, headShaStart: null, branchStart: null, cwd: "/tmp" });
    register(api as any, sink, HOOK_CTX);
  });

  it("skips user messages — no event emitted", async () => {
    await api.emit("message_end", makeMessageEndPayload({ role: "user" }), ctx);
    assert.equal(sink.all("llm_message").length, 0);
  });

  it("skips toolResult messages — no event emitted", async () => {
    await api.emit("message_end", makeMessageEndPayload({ role: "toolResult" }), ctx);
    assert.equal(sink.all("llm_message").length, 0);
  });

  it("emits LlmMessageEvent for assistant messages", async () => {
    await api.emit("message_end", makeMessageEndPayload({ usage: makeUsage() }), ctx);
    assert.equal(sink.all("llm_message").length, 1);
  });
});

describe("hooks/message — no session registered", () => {
  it("emits nothing when session is unknown", async () => {
    const api  = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api as any, sink, HOOK_CTX);
    // Use a session file that was never registered via setSession()
    const ctx = makeCtx("/tmp/unregistered-session.json");
    await api.emit("message_end", makeMessageEndPayload({ usage: makeUsage() }), ctx);
    assert.equal(sink.all("llm_message").length, 0);
  });
});

describe("hooks/message — token and cost field mapping", () => {
  let api: FakeExtensionAPI;
  let sink: CollectorSink;
  let sess: ReturnType<typeof uniqueSession>;
  let ctx: PiContextStub;

  beforeEach(() => {
    api  = new FakeExtensionAPI();
    sink = new CollectorSink();
    sess = uniqueSession();
    ctx  = makeCtx(sess.file);
    setSession(sess.file, { sessionId: sess.id, headShaStart: null, branchStart: null, cwd: "/tmp" });
    register(api as any, sink, HOOK_CTX);
  });

  it("maps camelCase usage fields to snake_case event fields", async () => {
    const usage = makeUsage({
      input: 111, output: 222, cacheRead: 33, cacheWrite: 44,
      costInput: 0.001, costOutput: 0.002, costCacheRead: 0.0003, costCacheWrite: 0.0004, costTotal: 0.0037,
    });
    await api.emit("message_end", makeMessageEndPayload({ usage }), ctx);
    const ev = sink.first("llm_message")!;
    assert.equal(ev.input_tokens,       111,    "input_tokens");
    assert.equal(ev.output_tokens,      222,    "output_tokens");
    assert.equal(ev.cache_read_tokens,  33,     "cache_read_tokens");
    assert.equal(ev.cache_write_tokens, 44,     "cache_write_tokens");
    assert.ok(Math.abs(ev.cost_input      - 0.001)   < 1e-9, "cost_input");
    assert.ok(Math.abs(ev.cost_output     - 0.002)   < 1e-9, "cost_output");
    assert.ok(Math.abs(ev.cost_cache_read - 0.0003)  < 1e-9, "cost_cache_read");
    assert.ok(Math.abs(ev.cost_cache_write- 0.0004)  < 1e-9, "cost_cache_write");
    assert.ok(Math.abs(ev.cost_total      - 0.0037)  < 1e-9, "cost_total");
  });

  it("defaults missing usage fields to 0", async () => {
    // No usage block at all
    await api.emit("message_end", makeMessageEndPayload({}), ctx);
    const ev = sink.first("llm_message")!;
    assert.equal(ev.input_tokens,       0, "missing input → 0");
    assert.equal(ev.output_tokens,      0, "missing output → 0");
    assert.equal(ev.cache_read_tokens,  0, "missing cacheRead → 0");
    assert.equal(ev.cache_write_tokens, 0, "missing cacheWrite → 0");
    assert.equal(ev.cost_total,         0, "missing cost.total → 0");
  });

  it("records 5m cache write retention from Anthropic payload cache_control", async () => {
    await api.emit("before_provider_request", {
      payload: {
        system: [
          { type: "text", text: "system", cache_control: { type: "ephemeral" } },
        ],
      },
    }, ctx);

    await api.emit("message_end", makeMessageEndPayload({ usage: makeUsage() }), ctx);

    const ev = sink.first("llm_message") as LlmMessageEvent;
    assert.equal(ev.cache_write_retention, "5m");
  });

  it("records 1h cache write retention from Anthropic payload ttl", async () => {
    await api.emit("before_provider_request", {
      payload: {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hi", cache_control: { type: "ephemeral", ttl: "1h" } },
            ],
          },
        ],
      },
    }, ctx);

    await api.emit("message_end", makeMessageEndPayload({ usage: makeUsage() }), ctx);

    const ev = sink.first("llm_message") as LlmMessageEvent;
    assert.equal(ev.cache_write_retention, "1h");
  });

  it("defaults cache write retention to null when no cache_control was observed", async () => {
    await api.emit("before_provider_request", { payload: { model: "gpt" } }, ctx);
    await api.emit("message_end", makeMessageEndPayload({ usage: makeUsage() }), ctx);

    const ev = sink.first("llm_message") as LlmMessageEvent;
    assert.equal(ev.cache_write_retention, null);
  });

  it("defaults partial usage (missing cacheRead/Write) to 0", async () => {
    const usage = {
      input: 10, output: 20,
      // cacheRead and cacheWrite intentionally omitted
      totalTokens: 30,
      cost: { input: 0.01, output: 0.02, total: 0.03 },
    } as any;
    await api.emit("message_end", makeMessageEndPayload({ usage }), ctx);
    const ev = sink.first("llm_message")!;
    assert.equal(ev.cache_read_tokens,  0, "missing cacheRead → 0");
    assert.equal(ev.cache_write_tokens, 0, "missing cacheWrite → 0");
    assert.equal(ev.cost_cache_read,    0, "missing cost.cacheRead → 0");
    assert.equal(ev.cost_cache_write,   0, "missing cost.cacheWrite → 0");
  });
});

describe("hooks/message — stop_reason extraction", () => {
  let api: FakeExtensionAPI;
  let sink: CollectorSink;
  let sess: ReturnType<typeof uniqueSession>;
  let ctx: PiContextStub;

  beforeEach(() => {
    api  = new FakeExtensionAPI();
    sink = new CollectorSink();
    sess = uniqueSession();
    ctx  = makeCtx(sess.file);
    setSession(sess.file, { sessionId: sess.id, headShaStart: null, branchStart: null, cwd: "/tmp" });
    register(api as any, sink, HOOK_CTX);
  });

  it("maps stopReason (camelCase) to stop_reason", async () => {
    await api.emit("message_end", makeMessageEndPayload({ stopReason: "stop" }), ctx);
    assert.equal(sink.first("llm_message")!.stop_reason, "stop");
  });

  it("maps stop_reason (snake_case fallback) to stop_reason", async () => {
    await api.emit("message_end", makeMessageEndPayload({ stop_reason: "toolUse" }), ctx);
    assert.equal(sink.first("llm_message")!.stop_reason, "toolUse");
  });

  it("prefers stopReason over stop_reason when both present", async () => {
    await api.emit("message_end", {
      message: {
        role: "assistant",
        stopReason: "stop",
        stop_reason: "length", // should be ignored
      },
    }, ctx);
    assert.equal(sink.first("llm_message")!.stop_reason, "stop");
  });

  it("sets stop_reason to null when neither field is present", async () => {
    await api.emit("message_end", makeMessageEndPayload({}), ctx);
    assert.equal(sink.first("llm_message")!.stop_reason, null);
  });
});

describe("hooks/message — timing", () => {
  let api: FakeExtensionAPI;
  let sink: CollectorSink;
  let sess: ReturnType<typeof uniqueSession>;
  let ctx: PiContextStub;

  beforeEach(() => {
    api  = new FakeExtensionAPI();
    sink = new CollectorSink();
    sess = uniqueSession();
    ctx  = makeCtx(sess.file);
    setSession(sess.file, { sessionId: sess.id, headShaStart: null, branchStart: null, cwd: "/tmp" });
    register(api as any, sink, HOOK_CTX);
  });

  it("time_to_first_token_ms is always null", async () => {
    // Emit turn_start first to seed timing map
    await api.emit("turn_start", { turnIndex: 0, timestamp: Date.now() }, ctx);
    await api.emit("message_end", makeMessageEndPayload({ usage: makeUsage() }), ctx);
    const ev = sink.first("llm_message")!;
    assert.equal(ev.time_to_first_token_ms, null,
      "time_to_first_token_ms is never available from pi payload");
  });

  it("total_duration_ms is a non-negative number after turn_start", async () => {
    // Small delay to ensure measurable elapsed time
    await api.emit("turn_start", { turnIndex: 0, timestamp: Date.now() }, ctx);
    await new Promise(r => setTimeout(r, 5));
    await api.emit("message_end", makeMessageEndPayload({ usage: makeUsage() }), ctx);
    const ev = sink.first("llm_message")!;
    assert.ok(ev.total_duration_ms !== null, "should have a duration");
    assert.ok(ev.total_duration_ms! >= 0,    "duration should be non-negative");
    // Sanity upper bound: the test runs in <1s
    assert.ok(ev.total_duration_ms! < 1000,  "duration should be <1s in test");
  });

  it("total_duration_ms falls back to message.timestamp when no turn_start seen", async () => {
    // Do NOT emit turn_start — simulate late hook registration
    const msgTimestamp = Date.now() - 150; // message was "created" 150ms ago
    await api.emit("message_end", makeMessageEndPayload({
      usage: makeUsage(),
      timestamp: msgTimestamp,
    }), ctx);
    const ev = sink.first("llm_message")!;
    assert.ok(ev.total_duration_ms !== null, "should use fallback");
    // Should be close to 150ms (within 50ms tolerance for CI timing variance)
    assert.ok(ev.total_duration_ms! >= 100, "fallback duration should be ~150ms");
    assert.ok(ev.total_duration_ms! < 500,  "fallback duration should not be unreasonably large");
  });

  it("total_duration_ms is null when no timing data is available", async () => {
    // No turn_start, no message.timestamp
    await api.emit("message_end", makeMessageEndPayload({ usage: makeUsage() }), ctx);
    const ev = sink.first("llm_message")!;
    assert.equal(ev.total_duration_ms, null,
      "should be null when no timing information is available");
  });

  it("turn_end clears timing so the next turn starts fresh", async () => {
    // First turn
    await api.emit("turn_start",   { turnIndex: 0, timestamp: Date.now() }, ctx);
    await api.emit("message_end",  makeMessageEndPayload({ usage: makeUsage() }), ctx);
    await api.emit("turn_end",     { turnIndex: 0, message: {}, toolResults: [] }, ctx);

    // Clear collected events to isolate the second turn
    sink.clear();

    // Second turn — no turn_start emitted, so timing should fall back
    await api.emit("message_end", makeMessageEndPayload({ usage: makeUsage() }), ctx);
    const ev2 = sink.first("llm_message")!;
    // Without a new turn_start, total_duration_ms should be null (no msg.timestamp either)
    assert.equal(ev2.total_duration_ms, null,
      "timing map should be cleared after turn_end");
  });
});

describe("hooks/message — FK fields and event shape", () => {
  let api: FakeExtensionAPI;
  let sink: CollectorSink;
  let sess: ReturnType<typeof uniqueSession>;
  let ctx: PiContextStub;

  beforeEach(() => {
    api  = new FakeExtensionAPI();
    sink = new CollectorSink();
    sess = uniqueSession();
    ctx  = makeCtx(sess.file);
    setSession(sess.file, { sessionId: sess.id, headShaStart: null, branchStart: null, cwd: "/tmp" });
    register(api as any, sink, HOOK_CTX);
  });

  it("event carries the correct session_id", async () => {
    await api.emit("message_end", makeMessageEndPayload({ usage: makeUsage() }), ctx);
    const ev = sink.first("llm_message")!;
    assert.equal(ev.session_id, sess.id);
  });

  it("event has a non-empty id (UUID)", async () => {
    await api.emit("message_end", makeMessageEndPayload({ usage: makeUsage() }), ctx);
    const ev = sink.first("llm_message")!;
    assert.ok(typeof ev.id === "string" && ev.id.length > 0, "id should be a non-empty string");
  });

  it("event has role=assistant", async () => {
    await api.emit("message_end", makeMessageEndPayload({ usage: makeUsage() }), ctx);
    const ev = sink.first("llm_message")!;
    assert.equal(ev.role, "assistant");
  });

  it("turn_id is 'unknown' when no active turn is in T8's registry", async () => {
    // T8 was not registered — no active turn exists
    await api.emit("message_end", makeMessageEndPayload({ usage: makeUsage() }), ctx);
    const ev = sink.first("llm_message")!;
    assert.equal(ev.turn_id, "unknown",
      "should use 'unknown' sentinel when turn is not active");
  });

  it("ts is a recent Unix ms timestamp", async () => {
    const before = Date.now();
    await api.emit("message_end", makeMessageEndPayload({ usage: makeUsage() }), ctx);
    const after = Date.now();
    const ev = sink.first("llm_message")!;
    assert.ok(ev.ts >= before, "ts should not be before the call");
    assert.ok(ev.ts <= after,  "ts should not be in the future");
  });

  it("event kind is 'llm_message'", async () => {
    await api.emit("message_end", makeMessageEndPayload({ usage: makeUsage() }), ctx);
    assert.equal(sink.first("llm_message")!.kind, "llm_message");
  });
});

describe("hooks/message — error resilience", () => {
  it("does not throw when the event payload is null", async () => {
    const api  = new FakeExtensionAPI();
    const sink = new CollectorSink();
    const sess = uniqueSession();
    const ctx  = makeCtx(sess.file);
    setSession(sess.file, { sessionId: sess.id, headShaStart: null, branchStart: null, cwd: "/tmp" });
    register(api as any, sink, HOOK_CTX);
    // Should not throw — handler must be resilient
    await assert.doesNotReject(() => api.emit("message_end", null, ctx));
    assert.equal(sink.all("llm_message").length, 0);
  });

  it("does not throw when message field is missing", async () => {
    const api  = new FakeExtensionAPI();
    const sink = new CollectorSink();
    const sess = uniqueSession();
    const ctx  = makeCtx(sess.file);
    setSession(sess.file, { sessionId: sess.id, headShaStart: null, branchStart: null, cwd: "/tmp" });
    register(api as any, sink, HOOK_CTX);
    await assert.doesNotReject(() => api.emit("message_end", {}, ctx));
    assert.equal(sink.all("llm_message").length, 0);
  });
});

describe("hooks/message — full turn lifecycle", () => {
  it("turn_start → message_end → turn_end produces one llm_message with duration", async () => {
    const api  = new FakeExtensionAPI();
    const sink = new CollectorSink();
    const sess = uniqueSession();
    const ctx  = makeCtx(sess.file);
    setSession(sess.file, { sessionId: sess.id, headShaStart: null, branchStart: null, cwd: "/tmp" });
    register(api as any, sink, HOOK_CTX);

    await api.emit("turn_start", { turnIndex: 0, timestamp: Date.now() }, ctx);
    await new Promise(r => setTimeout(r, 10)); // allow measurable elapsed time
    await api.emit("message_end", makeMessageEndPayload({
      usage: makeUsage({ input: 50, output: 100, costTotal: 0.002 }),
      stopReason: "stop",
    }), ctx);
    await api.emit("turn_end", { turnIndex: 0, message: {}, toolResults: [] }, ctx);

    assert.equal(sink.all("llm_message").length, 1);
    const ev = sink.first("llm_message")!;
    assert.equal(ev.input_tokens,  50);
    assert.equal(ev.output_tokens, 100);
    assert.ok(Math.abs(ev.cost_total - 0.002) < 1e-9);
    assert.equal(ev.stop_reason,  "stop");
    assert.ok(ev.total_duration_ms !== null && ev.total_duration_ms >= 5,
      "duration should reflect the simulated 10ms delay");
    assert.equal(ev.time_to_first_token_ms, null);
    assert.equal(ev.session_id, sess.id);
  });
});

describe("hooks/message — model_id and provider on LlmMessageEvent", () => {
  it("emits model_id and provider from message.model / message.provider", async () => {
    const api  = new FakeExtensionAPI();
    const sink = new CollectorSink();
    const sess = uniqueSession();
    const ctx  = makeCtx(sess.file);
    setSession(sess.file, { sessionId: sess.id, headShaStart: null, branchStart: null, cwd: "/tmp" });
    register(api as any, sink, HOOK_CTX);

    await api.emit("turn_start", { turnIndex: 0 }, ctx);
    await api.emit("message_end", makeMessageEndPayload({
      usage: makeUsage({ input: 10, output: 20, costTotal: 0.001 }),
      model: "claude-opus-4-5",
      provider: "anthropic",
    }), ctx);

    const ev = sink.first("llm_message")! as LlmMessageEvent;
    assert.equal(ev.model_id, "claude-opus-4-5", "model_id populated from msg.model");
    assert.equal(ev.provider, "anthropic",       "provider populated from msg.provider");
  });

  it("emits null model_id when message has no model field", async () => {
    const api  = new FakeExtensionAPI();
    const sink = new CollectorSink();
    const sess = uniqueSession();
    const ctx  = makeCtx(sess.file);
    setSession(sess.file, { sessionId: sess.id, headShaStart: null, branchStart: null, cwd: "/tmp" });
    register(api as any, sink, HOOK_CTX);

    await api.emit("turn_start", { turnIndex: 0 }, ctx);
    await api.emit("message_end", makeMessageEndPayload({
      usage: makeUsage({ input: 10, output: 20, costTotal: 0.001 }),
      // no model / provider
    }), ctx);

    const ev = sink.first("llm_message")! as LlmMessageEvent;
    assert.strictEqual(ev.model_id, null, "model_id is null when absent");
    assert.strictEqual(ev.provider, null, "provider is null when absent");
  });
});
