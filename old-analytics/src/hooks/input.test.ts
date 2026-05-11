/**
 * hooks/input.test.ts — Unit tests for the input hook.
 *
 * Tests are self-contained: session state is seeded directly via T6's
 * setSession() so no live pi process is required. A minimal CollectorSink
 * captures emitted analytics events for assertion.
 *
 * Run: node --test src/hooks/input.test.ts
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import {
  register,
  getLatestPromptId,
  getLatestPromptStartTs,
} from "./input.ts";
import { setSession } from "./session-state.ts";
import type { AnalyticsEvent, AnalyticsConfig, AnalyticsSink } from "../sinks/types.ts";
import type { HookContext, PiContextStub } from "./types.ts";
import type { ExecFn } from "../git/capture.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal sink that collects every event written to it. */
class CollectorSink implements AnalyticsSink {
  readonly events: AnalyticsEvent[] = [];
  async init(): Promise<void> {}
  write(event: AnalyticsEvent): void { this.events.push(event); }
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
}

type AnyHandler = (event: unknown, ctx: PiContextStub) => Promise<unknown> | unknown;

/**
 * Minimal fake ExtensionAPI that satisfies PiAPIStub.
 * Stores listeners in a Map and dispatches them via emit().
 */
function makeFakeApi() {
  const listeners = new Map<string, AnyHandler[]>();
  return {
    on(event: string, handler: AnyHandler): void {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
    },
    async emit(
      event: string,
      payload: unknown,
      ctx: PiContextStub,
    ): Promise<unknown[]> {
      const list = listeners.get(event) ?? [];
      const results: unknown[] = [];
      for (const h of list) {
        results.push(await h(payload, ctx));
      }
      return results;
    },
  };
}

/** Build a minimal pi context stub for a given session file. */
function makePiCtx(sessionFile: string | null): PiContextStub {
  return {
    cwd: "/tmp/test-repo",
    sessionManager: {
      getSessionFile: () => sessionFile,
    },
    signal: undefined,
  };
}

/** Default analytics config for most tests. storePrompts = "hashed". */
const defaultConfig: AnalyticsConfig = {
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

/** No-op ExecFn for HookContext (not used by the input hook). */
const noop_exec: ExecFn = async () => ({ stdout: "", stderr: "", exitCode: 0 });

/** Build a minimal HookContext. */
function makeCtx(overrides?: Partial<AnalyticsConfig["privacy"]>): HookContext {
  const config: AnalyticsConfig = overrides
    ? { ...defaultConfig, privacy: { ...defaultConfig.privacy, ...overrides } }
    : defaultConfig;
  return { config, exec: noop_exec };
}

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const SESSION_FILE = "/tmp/test-input-hook.jsonl";
const SESSION_ID = "test-session-input-001";

before(() => {
  setSession(SESSION_FILE, {
    sessionId: SESSION_ID,
    headShaStart: null,
    branchStart: null,
    cwd: "/tmp/test-repo",
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("hooks/input — register()", () => {
  it("registers listeners without throwing", () => {
    const api = makeFakeApi();
    const sink = new CollectorSink();
    assert.doesNotThrow(() => register(api, sink, makeCtx()));
  });
});

describe("hooks/input — `input` event handling", () => {
  it("emits one prompt event per input", async () => {
    const api = makeFakeApi();
    const sink = new CollectorSink();
    register(api, sink, makeCtx());

    const piCtx = makePiCtx(SESSION_FILE);
    await api.emit("input", { text: "hello world", source: "interactive" }, piCtx);

    assert.equal(sink.events.length, 1);
    assert.equal(sink.events[0].kind, "prompt");
  });

  it("populates session_id from session-state registry", async () => {
    const api = makeFakeApi();
    const sink = new CollectorSink();
    register(api, sink, makeCtx());

    const piCtx = makePiCtx(SESSION_FILE);
    await api.emit("input", { text: "test", source: "interactive" }, piCtx);

    const evt = sink.events[0];
    assert.ok(evt.kind === "prompt");
    assert.equal(evt.session_id, SESSION_ID);
  });

  it("falls back to 'unknown' when session is not registered", async () => {
    const api = makeFakeApi();
    const sink = new CollectorSink();
    register(api, sink, makeCtx());

    const piCtx = makePiCtx("/tmp/unregistered-session.jsonl");
    await api.emit("input", { text: "hello", source: "rpc" }, piCtx);

    const evt = sink.events[0];
    assert.ok(evt.kind === "prompt");
    assert.equal(evt.session_id, "unknown");
  });

  it("sets source from the event", async () => {
    const api = makeFakeApi();
    const sink = new CollectorSink();
    register(api, sink, makeCtx());

    const piCtx = makePiCtx(SESSION_FILE);
    await api.emit("input", { text: "rpc input", source: "rpc" }, piCtx);

    const evt = sink.events[0];
    assert.ok(evt.kind === "prompt");
    assert.equal(evt.source, "rpc");
  });

  it("counts attached images", async () => {
    const api = makeFakeApi();
    const sink = new CollectorSink();
    register(api, sink, makeCtx());

    const piCtx = makePiCtx(SESSION_FILE);
    await api.emit(
      "input",
      { text: "describe these", source: "interactive", images: [{}, {}, {}] },
      piCtx,
    );

    const evt = sink.events[0];
    assert.ok(evt.kind === "prompt");
    assert.equal(evt.image_count, 3);
  });

  it("image_count is 0 when images is absent", async () => {
    const api = makeFakeApi();
    const sink = new CollectorSink();
    register(api, sink, makeCtx());

    const piCtx = makePiCtx(SESSION_FILE);
    await api.emit("input", { text: "no images", source: "interactive" }, piCtx);

    const evt = sink.events[0];
    assert.ok(evt.kind === "prompt");
    assert.equal(evt.image_count, 0);
  });

  it("always populates text_sha256 (non-empty hex string)", async () => {
    const api = makeFakeApi();
    const sink = new CollectorSink();
    register(api, sink, makeCtx());

    const piCtx = makePiCtx(SESSION_FILE);
    await api.emit("input", { text: "any text", source: "interactive" }, piCtx);

    const evt = sink.events[0];
    assert.ok(evt.kind === "prompt");
    assert.match(evt.text_sha256, /^[0-9a-f]{64}$/i, "sha256 should be 64 hex chars");
  });

  it("always populates text_len with byte length", async () => {
    const api = makeFakeApi();
    const sink = new CollectorSink();
    register(api, sink, makeCtx());

    const piCtx = makePiCtx(SESSION_FILE);
    const text = "hello"; // 5 ASCII bytes
    await api.emit("input", { text, source: "interactive" }, piCtx);

    const evt = sink.events[0];
    assert.ok(evt.kind === "prompt");
    assert.equal(evt.text_len, 5);
  });

  describe("slash-command classification", () => {
    it("sets command = null for plain text", async () => {
      const api = makeFakeApi();
      const sink = new CollectorSink();
      register(api, sink, makeCtx());

      await api.emit(
        "input",
        { text: "just a question", source: "interactive" },
        makePiCtx(SESSION_FILE),
      );

      const evt = sink.events[0];
      assert.ok(evt.kind === "prompt");
      assert.equal(evt.command, null);
      assert.equal(evt.slash_kind, null);
    });

    it("extracts command token for plain slash command", async () => {
      const api = makeFakeApi();
      const sink = new CollectorSink();
      register(api, sink, makeCtx());

      await api.emit(
        "input",
        { text: "/usage --json", source: "interactive" },
        makePiCtx(SESSION_FILE),
      );

      const evt = sink.events[0];
      assert.ok(evt.kind === "prompt");
      assert.equal(evt.command, "/usage");
      assert.equal(evt.slash_kind, null, "non-skill slash commands should have null kind");
    });

    it("classifies skill-style commands (colon separator)", async () => {
      const api = makeFakeApi();
      const sink = new CollectorSink();
      register(api, sink, makeCtx());

      await api.emit(
        "input",
        { text: "/skill:myskill some extra args", source: "interactive" },
        makePiCtx(SESSION_FILE),
      );

      const evt = sink.events[0];
      assert.ok(evt.kind === "prompt");
      assert.equal(evt.command, "/skill:myskill");
      assert.equal(evt.slash_kind, "skill");
    });

    it("classifies any colon-containing command as skill", async () => {
      const api = makeFakeApi();
      const sink = new CollectorSink();
      register(api, sink, makeCtx());

      await api.emit(
        "input",
        { text: "/template:review-pr", source: "interactive" },
        makePiCtx(SESSION_FILE),
      );

      const evt = sink.events[0];
      assert.ok(evt.kind === "prompt");
      assert.equal(evt.slash_kind, "skill");
    });

    it("handles slash-only command (just '/')", async () => {
      const api = makeFakeApi();
      const sink = new CollectorSink();
      register(api, sink, makeCtx());

      await api.emit(
        "input",
        { text: "/", source: "interactive" },
        makePiCtx(SESSION_FILE),
      );

      const evt = sink.events[0];
      assert.ok(evt.kind === "prompt");
      assert.equal(evt.command, "/");
      assert.equal(evt.slash_kind, null);
    });
  });

  describe("privacy modes", () => {
    it("storePrompts='hashed' → no text field in event", async () => {
      const api = makeFakeApi();
      const sink = new CollectorSink();
      register(api, sink, makeCtx({ storePrompts: "hashed" }));

      await api.emit(
        "input",
        { text: "sensitive info", source: "interactive" },
        makePiCtx(SESSION_FILE),
      );

      const evt = sink.events[0];
      assert.ok(evt.kind === "prompt");
      assert.equal(evt.text, undefined, "text should be absent in hashed mode");
      assert.ok(evt.text_sha256.length > 0, "sha256 still populated");
    });

    it("storePrompts='none' → no text field in event", async () => {
      const api = makeFakeApi();
      const sink = new CollectorSink();
      register(api, sink, makeCtx({ storePrompts: "none" }));

      await api.emit(
        "input",
        { text: "private content", source: "interactive" },
        makePiCtx(SESSION_FILE),
      );

      const evt = sink.events[0];
      assert.ok(evt.kind === "prompt");
      assert.equal(evt.text, undefined, "text should be absent in none mode");
    });

    it("storePrompts='full' → text field present and unredacted when clean", async () => {
      const api = makeFakeApi();
      const sink = new CollectorSink();
      register(api, sink, makeCtx({ storePrompts: "full" }));

      const input = "explain recursion to me";
      await api.emit(
        "input",
        { text: input, source: "interactive" },
        makePiCtx(SESSION_FILE),
      );

      const evt = sink.events[0];
      assert.ok(evt.kind === "prompt");
      assert.equal(evt.text, input);
      assert.ok(evt.redacted !== undefined, "redacted counter present in full mode");
    });

    it("storePrompts='full' + GitHub token → token is redacted", async () => {
      const api = makeFakeApi();
      const sink = new CollectorSink();
      register(api, sink, makeCtx({ storePrompts: "full" }));

      // GitHub token pattern: gh[ousprt]_ + 36+ alphanumeric chars.
      // Use 36 A's to meet the minimum length.
      const rawToken = "ghp_" + "A".repeat(36);
      const secret = `use this: ${rawToken}`;
      await api.emit(
        "input",
        { text: secret, source: "interactive" },
        makePiCtx(SESSION_FILE),
      );

      const evt = sink.events[0];
      assert.ok(evt.kind === "prompt");
      // The raw token (exact ghp_AAAA... string) must not appear verbatim.
      assert.ok(
        !evt.text?.includes(rawToken),
        "Raw GitHub token should be replaced by a [REDACTED] marker",
      );
      // The redaction marker should appear in its place.
      assert.ok(
        evt.text?.includes("[REDACTED:github-token]"),
        "[REDACTED:github-token] marker should appear",
      );
      // sha256 is always populated
      assert.ok(evt.text_sha256.length > 0);
    });

    it("user redactPatterns are applied", async () => {
      const api = makeFakeApi();
      const sink = new CollectorSink();
      register(
        api,
        sink,
        makeCtx({ storePrompts: "full", redactPatterns: ["MYPASSWORD"] }),
      );

      await api.emit(
        "input",
        { text: "login with MYPASSWORD123", source: "interactive" },
        makePiCtx(SESSION_FILE),
      );

      const evt = sink.events[0];
      assert.ok(evt.kind === "prompt");
      // The engine replaces matches with "[REDACTED:user:MYPASSWORD]" (marker
      // includes the rule name).  Assert by checking the hit counter fired.
      assert.ok(
        evt.redacted && (evt.redacted["user:MYPASSWORD"] ?? 0) > 0,
        "custom redact pattern should record a hit in evt.redacted",
      );
      // The exact verbatim string "MYPASSWORD123" should not appear — the match
      // consumed "MYPASSWORD", leaving only "123" after the marker.
      assert.ok(
        !evt.text?.includes("MYPASSWORD123"),
        "original verbatim secret (MYPASSWORD123) should not appear in stored text",
      );
    });
  });

  it("does not throw when event payload is malformed (null)", async () => {
    const api = makeFakeApi();
    const sink = new CollectorSink();
    register(api, sink, makeCtx());

    // Malformed payload should not propagate a rejection — error is caught internally
    await assert.doesNotReject(
      api.emit("input", null, makePiCtx(SESSION_FILE)),
    );
    // No event should have been emitted
    assert.equal(sink.events.length, 0);
  });
});

describe("hooks/input — `before_agent_start` event handling", () => {
  it("records agent-start timestamp in the map", async () => {
    const api = makeFakeApi();
    const sink = new CollectorSink();
    register(api, sink, makeCtx());

    const piCtx = makePiCtx(SESSION_FILE);

    // Emit input first so a prompt exists
    await api.emit("input", { text: "a question", source: "interactive" }, piCtx);

    const before = Date.now();
    await api.emit("before_agent_start", { prompt: "a question" }, piCtx);
    const after = Date.now();

    const ts = getLatestPromptStartTs(SESSION_ID);
    assert.ok(ts !== null, "timestamp should be set after before_agent_start");
    assert.ok(ts >= before && ts <= after, "timestamp should fall within test window");
  });

  it("does not record timestamp when session is unregistered", async () => {
    const api = makeFakeApi();
    const sink = new CollectorSink();
    register(api, sink, makeCtx());

    const unknownSessionId = "unknown-session-99";
    const piCtx = makePiCtx("/tmp/unknown-session.jsonl");

    await api.emit("before_agent_start", { prompt: "hi" }, piCtx);

    assert.equal(
      getLatestPromptStartTs(unknownSessionId),
      null,
      "unregistered session should not have a timestamp",
    );
  });

  it("does not throw on malformed event payload", async () => {
    const api = makeFakeApi();
    const sink = new CollectorSink();
    register(api, sink, makeCtx());

    await assert.doesNotReject(
      api.emit("before_agent_start", null, makePiCtx(SESSION_FILE)),
    );
  });
});

describe("getLatestPromptId()", () => {
  it("returns the ID of the most recently emitted prompt", async () => {
    const api = makeFakeApi();
    const sink = new CollectorSink();
    register(api, sink, makeCtx());

    const piCtx = makePiCtx(SESSION_FILE);
    await api.emit("input", { text: "what is 2+2?", source: "interactive" }, piCtx);

    const promptId = getLatestPromptId(SESSION_ID);
    assert.ok(promptId !== null, "should return a prompt ID");

    // The returned ID must match the id in the emitted event
    const emitted = sink.events[0];
    assert.ok(emitted.kind === "prompt");
    assert.equal(promptId, emitted.id);
  });

  it("updates to the latest prompt after multiple inputs", async () => {
    const api = makeFakeApi();
    const sink = new CollectorSink();
    register(api, sink, makeCtx());

    const piCtx = makePiCtx(SESSION_FILE);
    await api.emit("input", { text: "first", source: "interactive" }, piCtx);
    await api.emit("input", { text: "second", source: "interactive" }, piCtx);

    assert.equal(sink.events.length, 2);
    const latestEvt = sink.events[1];
    assert.ok(latestEvt.kind === "prompt");

    const promptId = getLatestPromptId(SESSION_ID);
    assert.equal(promptId, latestEvt.id, "should return the SECOND prompt's id");
  });

  it("returns null for a session that has never emitted a prompt", () => {
    const id = getLatestPromptId("completely-unknown-session-id");
    assert.equal(id, null);
  });
});
