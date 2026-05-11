/**
 * hooks/tool.test.ts — Unit tests for hooks/tool.ts (T10).
 *
 * Bootstrap strategy:
 *  - Session state is seeded directly via setSession() so getActiveSessionId()
 *    resolves without needing a live session hook.
 *  - Turn state: most tests run without an active turn, so turn_id falls
 *    back to "unknown". The scenario test wires all hooks.
 *  - Git exec calls in tool.ts go through hookCtx.exec (NOT the
 *    FakeExtensionAPI). Tests control SHA capture by providing a custom
 *    ExecFn in makeHookCtx(). The scenario test bridges api.exec → hookCtx.exec
 *    so seedDefaultGitReplies() takes effect.
 *
 * Covers:
 *   - register() subscribes three listeners without throwing
 *   - read tool → ToolCallEvent (tool_call_id, name, is_error, input_bytes, duration)
 *   - read tool → FileTouchedEvent (op=read, correct path and bytes)
 *   - write tool → FileTouchedEvent (op=write, bytes=byteLengthUtf8(content))
 *   - edit tool → FileTouchedEvent (op=edit, bytes=sum of newText lengths)
 *   - sensitive path read → FileTouchedEvent.sensitive=true
 *   - storeToolOutputs=none → output_bytes=0 on ToolCallEvent
 *   - storeToolArgs=none → write/edit FileTouchedEvent bytes=0
 *   - bash git commit → CommitMadeEvent with captured SHA
 *   - bash git commit → CommitMadeEvent with empty SHA when exec fails
 *   - git.enabled=false → no CommitMadeEvent emitted
 *   - bash git checkout -b → BranchTransitionEvent (to_branch, from_branch)
 *   - bash git push → ToolSideEffectEvent (effect=git-push)
 *   - bash gh pr create → ToolSideEffectEvent (effect=gh-pr-create)
 *   - chained commit + push → both CommitMadeEvent and ToolSideEffectEvent
 *   - is_error=true → ToolCallEvent.is_error=true, error_kind from content
 *   - error_kind=null when content is empty
 *   - no active session → events emitted with session_id="unknown", no throw
 *   - orphan tool_execution_end (no matching start) → no ToolCallEvent, no throw
 *   - bashCommitPushPr scenario → all expected event kinds present
 *
 * Run: node --test src/hooks/tool.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { register } from "./tool.ts";
import { setSession, clearSession } from "./session-state.ts";
import type {
  AnalyticsConfig,
  AnalyticsEvent,
  AnalyticsSink,
  ToolCallEvent,
  FileTouchedEvent,
  CommitMadeEvent,
  BranchTransitionEvent,
  ToolSideEffectEvent,
} from "../sinks/types.ts";
import type { HookContext } from "./types.ts";
import type { ExecFn } from "../git/capture.ts";
import { byteLengthUtf8 } from "../redact/index.ts";
import {
  FakeExtensionAPI,
  FakeExtensionContext,
} from "../test-harness/harness.ts";
import {
  bashCommitPushPr,
  seedDefaultGitReplies,
} from "../test-harness/scenarios.ts";

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

/** Minimal sink that collects every analytics event for assertion. */
class CollectorSink implements AnalyticsSink {
  readonly events: AnalyticsEvent[] = [];

  async init(): Promise<void> {}

  write(event: AnalyticsEvent): void {
    this.events.push(event);
  }

  async flush(): Promise<void> {}
  async close(): Promise<void> {}

  all<K extends AnalyticsEvent["kind"]>(
    kind: K,
  ): Extract<AnalyticsEvent, { kind: K }>[] {
    return this.events.filter(
      (e): e is Extract<AnalyticsEvent, { kind: K }> => e.kind === kind,
    );
  }

  first<K extends AnalyticsEvent["kind"]>(
    kind: K,
  ): Extract<AnalyticsEvent, { kind: K }> | undefined {
    return this.all(kind)[0];
  }

  clear(): void {
    this.events.length = 0;
  }
}

/** No-op exec — returns empty success for all calls. */
const noop_exec: ExecFn = async () => ({ stdout: "", stderr: "", exitCode: 0 });

const BASE_CONFIG: AnalyticsConfig = {
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

function makeHookCtx(exec: ExecFn = noop_exec): HookContext {
  return { config: BASE_CONFIG, exec };
}

function configWith(overrides: Partial<AnalyticsConfig["privacy"]>): HookContext {
  return {
    config: {
      ...BASE_CONFIG,
      privacy: { ...BASE_CONFIG.privacy, ...overrides },
    },
    exec: noop_exec,
  };
}

/** Counter for unique session files per test, avoiding state bleed. */
let _counter = 0;
function uniqueSession(): { file: string; id: string } {
  _counter++;
  return {
    file: `/tmp/tool-test-${_counter}.jsonl`,
    id: `tool-session-${_counter}`,
  };
}

/**
 * Fire tool_execution_start → tool_result → tool_execution_end in order.
 * api.emit() awaits each listener, including the async tool_result handler
 * that captures git SHAs, so all side-effects complete before this returns.
 */
async function fireToolCall(
  api: FakeExtensionAPI,
  ctx: FakeExtensionContext,
  opts: {
    toolCallId?: string;
    toolName: string;
    args: Record<string, unknown>;
    /** input for tool_result (defaults to args) */
    input?: Record<string, unknown>;
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  },
): Promise<string> {
  const toolCallId = opts.toolCallId ?? crypto.randomUUID();
  const input = opts.input ?? opts.args;
  const content = opts.content ?? [];
  const isError = opts.isError ?? false;

  await api.emit(
    "tool_execution_start",
    { toolCallId, toolName: opts.toolName, args: opts.args },
    ctx,
  );
  await api.emit(
    "tool_result",
    { toolCallId, toolName: opts.toolName, input, content, isError },
    ctx,
  );
  await api.emit(
    "tool_execution_end",
    {
      toolCallId,
      toolName: opts.toolName,
      result: { content },
      isError,
    },
    ctx,
  );
  return toolCallId;
}

// ---------------------------------------------------------------------------
// register()
// ---------------------------------------------------------------------------

describe("hooks/tool — register()", () => {
  it("registers without throwing", () => {
    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    assert.doesNotThrow(() => register(api, sink, makeHookCtx()));
  });

  it("registers listeners for all three tool events", () => {
    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, makeHookCtx());
    assert.ok(
      (api.listeners.get("tool_execution_start")?.length ?? 0) >= 1,
      "tool_execution_start listener missing",
    );
    assert.ok(
      (api.listeners.get("tool_result")?.length ?? 0) >= 1,
      "tool_result listener missing",
    );
    assert.ok(
      (api.listeners.get("tool_execution_end")?.length ?? 0) >= 1,
      "tool_execution_end listener missing",
    );
  });
});

// ---------------------------------------------------------------------------
// ToolCallEvent — basic fields (read tool)
// ---------------------------------------------------------------------------

describe("hooks/tool — ToolCallEvent (read tool)", () => {
  let api: FakeExtensionAPI;
  let sink: CollectorSink;
  let sess: { file: string; id: string };
  let ctx: FakeExtensionContext;

  beforeEach(() => {
    api = new FakeExtensionAPI();
    sink = new CollectorSink();
    sess = uniqueSession();
    ctx = new FakeExtensionContext("/tmp/test-repo", sess.file);
    setSession(sess.file, {
      sessionId: sess.id,
      headShaStart: null,
      branchStart: null,
      cwd: "/tmp/test-repo",
    });
    register(api, sink, makeHookCtx());
  });

  afterEach(() => {
    clearSession(sess.file);
  });

  it("emits exactly one ToolCallEvent", async () => {
    await fireToolCall(api, ctx, {
      toolName: "read",
      args: { path: "/tmp/test-repo/README.md" },
      content: [{ type: "text", text: "# Hello\n" }],
    });
    assert.equal(sink.all("tool_call").length, 1);
  });

  it("ToolCallEvent has correct tool_call_id and name", async () => {
    const toolCallId = "tc-explicit-id";
    await fireToolCall(api, ctx, {
      toolCallId,
      toolName: "read",
      args: { path: "/tmp/test-repo/README.md" },
      content: [{ type: "text", text: "content" }],
    });
    const ev = sink.first("tool_call")!;
    assert.equal(ev.tool_call_id, toolCallId);
    assert.equal(ev.name, "read");
  });

  it("ToolCallEvent.is_error=false for a successful call", async () => {
    await fireToolCall(api, ctx, {
      toolName: "read",
      args: { path: "/tmp/test-repo/README.md" },
      isError: false,
    });
    assert.equal(sink.first("tool_call")!.is_error, false);
  });

  it("ToolCallEvent.input_bytes > 0 (serialized args)", async () => {
    await fireToolCall(api, ctx, {
      toolName: "read",
      args: { path: "/tmp/test-repo/src/main.ts" },
    });
    const ev = sink.first("tool_call")!;
    assert.ok(ev.input_bytes > 0, `input_bytes should be > 0, got ${ev.input_bytes}`);
  });

  it("ToolCallEvent.session_id matches seeded session", async () => {
    await fireToolCall(api, ctx, {
      toolName: "read",
      args: { path: "/tmp/README.md" },
    });
    assert.equal(sink.first("tool_call")!.session_id, sess.id);
  });

  it("ToolCallEvent timing: started_at <= ended_at, duration_ms >= 0", async () => {
    const before = Date.now();
    await fireToolCall(api, ctx, {
      toolName: "read",
      args: { path: "/tmp/README.md" },
      content: [{ type: "text", text: "content" }],
    });
    const after = Date.now();
    const ev = sink.first("tool_call")!;
    assert.ok(ev.started_at >= before, "started_at should be after test started");
    assert.ok(ev.ended_at >= ev.started_at, "ended_at should be >= started_at");
    assert.ok(ev.ended_at <= after + 50, "ended_at should be close to now");
    assert.ok(ev.duration_ms >= 0, "duration_ms should be non-negative");
  });

  it("output_bytes equals content text byte length (size-only mode)", async () => {
    const text = "hello world content";
    await fireToolCall(api, ctx, {
      toolName: "read",
      args: { path: "/tmp/README.md" },
      content: [{ type: "text", text }],
    });
    assert.equal(sink.first("tool_call")!.output_bytes, byteLengthUtf8(text));
  });

  it("output_bytes=0 when storeToolOutputs=none", async () => {
    const api2 = new FakeExtensionAPI();
    const sink2 = new CollectorSink();
    register(api2, sink2, configWith({ storeToolOutputs: "none" }));
    await fireToolCall(api2, ctx, {
      toolName: "read",
      args: { path: "/tmp/README.md" },
      content: [{ type: "text", text: "lots of content here" }],
    });
    assert.equal(sink2.first("tool_call")!.output_bytes, 0);
  });
});

// ---------------------------------------------------------------------------
// FileTouchedEvent — read
// ---------------------------------------------------------------------------

describe("hooks/tool — FileTouchedEvent (read)", () => {
  let api: FakeExtensionAPI;
  let sink: CollectorSink;
  let sess: { file: string; id: string };
  let ctx: FakeExtensionContext;

  beforeEach(() => {
    api = new FakeExtensionAPI();
    sink = new CollectorSink();
    sess = uniqueSession();
    ctx = new FakeExtensionContext("/tmp/test-repo", sess.file);
    setSession(sess.file, {
      sessionId: sess.id,
      headShaStart: null,
      branchStart: null,
      cwd: "/tmp/test-repo",
    });
    register(api, sink, makeHookCtx());
  });

  afterEach(() => clearSession(sess.file));

  it("emits a FileTouchedEvent with op=read and the correct path", async () => {
    const path = "/tmp/test-repo/src/main.ts";
    await fireToolCall(api, ctx, {
      toolName: "read",
      args: { path },
      content: [{ type: "text", text: "const x = 1;\n" }],
    });
    const ft = sink.first("file_touched")!;
    assert.ok(ft, "should have file_touched event");
    assert.equal(ft.op, "read");
    assert.equal(ft.path, path);
  });

  it("FileTouchedEvent.sensitive=false for ordinary paths", async () => {
    await fireToolCall(api, ctx, {
      toolName: "read",
      args: { path: "/tmp/test-repo/README.md" },
      content: [{ type: "text", text: "readme" }],
    });
    assert.equal(sink.first("file_touched")!.sensitive, false);
  });

  it("FileTouchedEvent.bytes matches content text length", async () => {
    const text = "file body here";
    await fireToolCall(api, ctx, {
      toolName: "read",
      args: { path: "/tmp/test-repo/README.md" },
      content: [{ type: "text", text }],
    });
    assert.equal(sink.first("file_touched")!.bytes, byteLengthUtf8(text));
  });
});

// ---------------------------------------------------------------------------
// FileTouchedEvent — write
// ---------------------------------------------------------------------------

describe("hooks/tool — FileTouchedEvent (write)", () => {
  let api: FakeExtensionAPI;
  let sink: CollectorSink;
  let sess: { file: string; id: string };
  let ctx: FakeExtensionContext;

  beforeEach(() => {
    api = new FakeExtensionAPI();
    sink = new CollectorSink();
    sess = uniqueSession();
    ctx = new FakeExtensionContext("/tmp/test-repo", sess.file);
    setSession(sess.file, {
      sessionId: sess.id,
      headShaStart: null,
      branchStart: null,
      cwd: "/tmp/test-repo",
    });
    register(api, sink, makeHookCtx());
  });

  afterEach(() => clearSession(sess.file));

  it("emits FileTouchedEvent with op=write and correct byte count", async () => {
    const path = "/tmp/test-repo/output.ts";
    const content = "export const x = 42;\n";
    const args = { path, content };
    await fireToolCall(api, ctx, { toolName: "write", args, input: args });
    const ft = sink.first("file_touched")!;
    assert.equal(ft.op, "write");
    assert.equal(ft.path, path);
    assert.equal(ft.bytes, byteLengthUtf8(content));
  });

  it("write bytes=0 when storeToolArgs=none", async () => {
    const api2 = new FakeExtensionAPI();
    const sink2 = new CollectorSink();
    register(api2, sink2, configWith({ storeToolArgs: "none" }));
    const args = { path: "/tmp/test-repo/foo.ts", content: "export const x = 42;\n" };
    await fireToolCall(api2, ctx, { toolName: "write", args, input: args });
    assert.equal(sink2.first("file_touched")!.bytes, 0);
  });
});

// ---------------------------------------------------------------------------
// FileTouchedEvent — edit
// ---------------------------------------------------------------------------

describe("hooks/tool — FileTouchedEvent (edit)", () => {
  let api: FakeExtensionAPI;
  let sink: CollectorSink;
  let sess: { file: string; id: string };
  let ctx: FakeExtensionContext;

  beforeEach(() => {
    api = new FakeExtensionAPI();
    sink = new CollectorSink();
    sess = uniqueSession();
    ctx = new FakeExtensionContext("/tmp/test-repo", sess.file);
    setSession(sess.file, {
      sessionId: sess.id,
      headShaStart: null,
      branchStart: null,
      cwd: "/tmp/test-repo",
    });
    register(api, sink, makeHookCtx());
  });

  afterEach(() => clearSession(sess.file));

  it("emits FileTouchedEvent with op=edit and bytes=sum of newText lengths", async () => {
    const path = "/tmp/test-repo/src/main.ts";
    const edits = [
      { oldText: "const x = 1;", newText: "const x = 2;" },
      { oldText: "const y = 1;", newText: "const y = 99;\nconst z = 0;" },
    ];
    const args = { path, edits };
    await fireToolCall(api, ctx, { toolName: "edit", args, input: args });
    const ft = sink.first("file_touched")!;
    assert.equal(ft.op, "edit");
    assert.equal(ft.path, path);
    const expected = edits.reduce(
      (sum, e) => sum + byteLengthUtf8(e.newText),
      0,
    );
    assert.equal(ft.bytes, expected);
  });
});

// ---------------------------------------------------------------------------
// Sensitive paths
// ---------------------------------------------------------------------------

describe("hooks/tool — sensitive path suppression", () => {
  let api: FakeExtensionAPI;
  let sink: CollectorSink;
  let sess: { file: string; id: string };
  let ctx: FakeExtensionContext;

  beforeEach(() => {
    api = new FakeExtensionAPI();
    sink = new CollectorSink();
    sess = uniqueSession();
    ctx = new FakeExtensionContext("/tmp/test-repo", sess.file);
    setSession(sess.file, {
      sessionId: sess.id,
      headShaStart: null,
      branchStart: null,
      cwd: "/tmp/test-repo",
    });
    register(api, sink, makeHookCtx());
  });

  afterEach(() => clearSession(sess.file));

  it("sensitive=true for ~/.ssh/id_rsa", async () => {
    const path = "/home/user/.ssh/id_rsa";
    await fireToolCall(api, ctx, {
      toolName: "read",
      args: { path },
      content: [{ type: "text", text: "-----BEGIN RSA PRIVATE KEY-----\n..." }],
    });
    const ft = sink.first("file_touched")!;
    assert.equal(ft.sensitive, true);
    assert.equal(ft.path, path);
  });

  it("sensitive=true for .env files", async () => {
    await fireToolCall(api, ctx, {
      toolName: "read",
      args: { path: "/tmp/test-repo/.env" },
      content: [{ type: "text", text: "API_KEY=abc123\n" }],
    });
    assert.equal(sink.first("file_touched")!.sensitive, true);
  });

  it("sensitive=false for a normal source file", async () => {
    // environment.ts should NOT match the .env rule (pattern requires
    // .env followed by . or end-of-string, or .env at a path separator)
    await fireToolCall(api, ctx, {
      toolName: "read",
      args: { path: "/tmp/test-repo/src/environment.ts" },
      content: [{ type: "text", text: "export const env = process.env;\n" }],
    });
    assert.equal(sink.first("file_touched")!.sensitive, false);
  });
});

// ---------------------------------------------------------------------------
// Bash: git-commit → CommitMadeEvent
// ---------------------------------------------------------------------------

describe("hooks/tool — bash git-commit → CommitMadeEvent", () => {
  afterEach(() => {
    // Sessions are unique per test; nothing to clean globally.
  });

  it("emits CommitMadeEvent with captured SHA", async () => {
    const sess = uniqueSession();
    const ctx = new FakeExtensionContext("/tmp/test-repo", sess.file);
    setSession(sess.file, {
      sessionId: sess.id,
      headShaStart: null,
      branchStart: null,
      cwd: "/tmp/test-repo",
    });

    const knownSha = "abc1234567890abcdef1234567890abcdef12345";
    const mockExec: ExecFn = async (cmd, args) => {
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
        return { stdout: `${knownSha}\n`, stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, makeHookCtx(mockExec));

    await fireToolCall(api, ctx, {
      toolName: "bash",
      args: { command: 'git commit -m "feat: add analytics"' },
      input: { command: 'git commit -m "feat: add analytics"' },
      content: [{ type: "text", text: "[main abc1234] feat: add analytics\n" }],
    });

    const commits = sink.all("commit_made");
    assert.equal(commits.length, 1);
    assert.equal(commits[0].sha, knownSha);
    assert.equal(commits[0].subject, "feat: add analytics");
    assert.equal(commits[0].session_id, sess.id);
    clearSession(sess.file);
  });

  it("CommitMadeEvent has empty sha when exec fails", async () => {
    const sess = uniqueSession();
    const ctx = new FakeExtensionContext("/tmp/test-repo", sess.file);
    setSession(sess.file, {
      sessionId: sess.id,
      headShaStart: null,
      branchStart: null,
      cwd: "/tmp/test-repo",
    });

    // Non-zero exit code → getCurrentHeadSha returns null
    const failExec: ExecFn = async () => ({
      stdout: "",
      stderr: "not a git repo",
      exitCode: 128,
    });

    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, makeHookCtx(failExec));

    await fireToolCall(api, ctx, {
      toolName: "bash",
      args: { command: 'git commit -m "fix: something"' },
      input: { command: 'git commit -m "fix: something"' },
    });

    const commits = sink.all("commit_made");
    assert.equal(commits.length, 1);
    // Partial data (empty SHA) is better than no data — per PLAN.md.
    assert.equal(commits[0].sha, "");
    clearSession(sess.file);
  });

  it("no CommitMadeEvent when git.enabled=false", async () => {
    const sess = uniqueSession();
    const ctx = new FakeExtensionContext("/tmp/test-repo", sess.file);
    setSession(sess.file, {
      sessionId: sess.id,
      headShaStart: null,
      branchStart: null,
      cwd: "/tmp/test-repo",
    });

    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    const disabledGit: AnalyticsConfig = {
      ...BASE_CONFIG,
      git: { ...BASE_CONFIG.git, enabled: false },
    };
    register(api, sink, { config: disabledGit, exec: noop_exec });

    await fireToolCall(api, ctx, {
      toolName: "bash",
      args: { command: 'git commit -m "feat: nope"' },
      input: { command: 'git commit -m "feat: nope"' },
    });

    assert.equal(sink.all("commit_made").length, 0);
    clearSession(sess.file);
  });
});

// ---------------------------------------------------------------------------
// Bash: branch-transition → BranchTransitionEvent
// ---------------------------------------------------------------------------

describe("hooks/tool — bash branch-transition → BranchTransitionEvent", () => {
  let api: FakeExtensionAPI;
  let sink: CollectorSink;
  let sess: { file: string; id: string };
  let ctx: FakeExtensionContext;

  beforeEach(() => {
    api = new FakeExtensionAPI();
    sink = new CollectorSink();
    sess = uniqueSession();
    ctx = new FakeExtensionContext("/tmp/test-repo", sess.file);
    // branchStart="main" — getCurrentBranch() uses this as from_branch
    setSession(sess.file, {
      sessionId: sess.id,
      headShaStart: null,
      branchStart: "main",
      cwd: "/tmp/test-repo",
    });
    register(api, sink, makeHookCtx());
  });

  afterEach(() => clearSession(sess.file));

  it("git checkout -b emits BranchTransitionEvent with to_branch set", async () => {
    await fireToolCall(api, ctx, {
      toolName: "bash",
      args: { command: "git checkout -b feat/x" },
      input: { command: "git checkout -b feat/x" },
      content: [{ type: "text", text: "Switched to a new branch 'feat/x'\n" }],
    });
    const bt = sink.first("branch_transition")!;
    assert.ok(bt, "should have a branch_transition event");
    assert.equal(bt.to_branch, "feat/x");
    assert.equal(bt.session_id, sess.id);
  });

  it("BranchTransitionEvent.from_branch comes from session snapshot.branchStart", async () => {
    await fireToolCall(api, ctx, {
      toolName: "bash",
      args: { command: "git checkout -b feat/y" },
      input: { command: "git checkout -b feat/y" },
    });
    assert.equal(sink.first("branch_transition")!.from_branch, "main");
  });
});

// ---------------------------------------------------------------------------
// Bash: side-effects → ToolSideEffectEvent
// ---------------------------------------------------------------------------

describe("hooks/tool — bash side-effects → ToolSideEffectEvent", () => {
  let api: FakeExtensionAPI;
  let sink: CollectorSink;
  let sess: { file: string; id: string };
  let ctx: FakeExtensionContext;

  beforeEach(() => {
    api = new FakeExtensionAPI();
    sink = new CollectorSink();
    sess = uniqueSession();
    ctx = new FakeExtensionContext("/tmp/test-repo", sess.file);
    setSession(sess.file, {
      sessionId: sess.id,
      headShaStart: null,
      branchStart: null,
      cwd: "/tmp/test-repo",
    });
    register(api, sink, makeHookCtx());
  });

  afterEach(() => clearSession(sess.file));

  it("git push emits ToolSideEffectEvent with effect=git-push", async () => {
    await fireToolCall(api, ctx, {
      toolName: "bash",
      args: { command: "git push -u origin feat/x" },
      input: { command: "git push -u origin feat/x" },
      content: [{ type: "text", text: "Branch 'feat/x' tracked\n" }],
    });
    const effects = sink.all("tool_side_effect");
    const push = effects.find((e) => e.effect === "git-push");
    assert.ok(push, "should have a git-push side effect");
    assert.equal(push!.session_id, sess.id);
  });

  it("gh pr create emits ToolSideEffectEvent with effect=gh-pr-create", async () => {
    await fireToolCall(api, ctx, {
      toolName: "bash",
      args: { command: "gh pr create --fill" },
      input: { command: "gh pr create --fill" },
      content: [{ type: "text", text: "https://github.com/test/repo/pull/1\n" }],
    });
    const effects = sink.all("tool_side_effect");
    const prCreate = effects.find((e) => e.effect === "gh-pr-create");
    assert.ok(prCreate, "should have a gh-pr-create side effect");
  });

  it("chained commit+push emits CommitMadeEvent and git-push ToolSideEffectEvent", async () => {
    const knownSha = "deadbeef1234567890abcdef1234567890abcdef";
    const chainExec: ExecFn = async (cmd, args) => {
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
        return { stdout: `${knownSha}\n`, stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    // Re-register with the exec that returns a SHA
    const api2 = new FakeExtensionAPI();
    const sink2 = new CollectorSink();
    register(api2, sink2, makeHookCtx(chainExec));

    await fireToolCall(api2, ctx, {
      toolName: "bash",
      args: { command: "git add . && git commit -m 'fix: typo' && git push" },
      input: { command: "git add . && git commit -m 'fix: typo' && git push" },
    });

    assert.equal(sink2.all("commit_made").length, 1, "should have 1 commit_made");
    assert.ok(
      sink2.all("tool_side_effect").some((e) => e.effect === "git-push"),
      "should have git-push side effect",
    );
  });
});

// ---------------------------------------------------------------------------
// Error path
// ---------------------------------------------------------------------------

describe("hooks/tool — error path (is_error=true)", () => {
  let api: FakeExtensionAPI;
  let sink: CollectorSink;
  let sess: { file: string; id: string };
  let ctx: FakeExtensionContext;

  beforeEach(() => {
    api = new FakeExtensionAPI();
    sink = new CollectorSink();
    sess = uniqueSession();
    ctx = new FakeExtensionContext("/tmp/test-repo", sess.file);
    setSession(sess.file, {
      sessionId: sess.id,
      headShaStart: null,
      branchStart: null,
      cwd: "/tmp/test-repo",
    });
    register(api, sink, makeHookCtx());
  });

  afterEach(() => clearSession(sess.file));

  it("ToolCallEvent.is_error=true when the call errors", async () => {
    await fireToolCall(api, ctx, {
      toolName: "bash",
      args: { command: "npm run build" },
      input: { command: "npm run build" },
      content: [{ type: "text", text: "Error: build failed\n" }],
      isError: true,
    });
    assert.equal(sink.first("tool_call")!.is_error, true);
  });

  it("error_kind=not_found when content contains ENOENT", async () => {
    await fireToolCall(api, ctx, {
      toolName: "read",
      args: { path: "/nonexistent/file.ts" },
      content: [
        { type: "text", text: "Error: ENOENT: no such file or directory\n" },
      ],
      isError: true,
    });
    const ev = sink.first("tool_call")!;
    assert.equal(ev.is_error, true);
    assert.equal(ev.error_kind, "not_found");
  });

  it("error_kind=null when content is empty", async () => {
    await fireToolCall(api, ctx, {
      toolName: "bash",
      args: { command: "false" },
      content: [],
      isError: true,
    });
    assert.equal(sink.first("tool_call")!.error_kind, null);
  });
});

// ---------------------------------------------------------------------------
// Graceful degradation — no active session
// ---------------------------------------------------------------------------

describe("hooks/tool — no active session", () => {
  it("does not throw; emits events with session_id=unknown", async () => {
    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    register(api, sink, makeHookCtx());

    // Deliberately use a session file that has no setSession() call.
    const orphanCtx = new FakeExtensionContext(
      "/tmp/test-repo",
      "/tmp/unregistered-session.jsonl",
    );

    await assert.doesNotReject(async () => {
      await fireToolCall(api, orphanCtx, {
        toolName: "read",
        args: { path: "/tmp/test-repo/README.md" },
        content: [{ type: "text", text: "content" }],
      });
    });

    const ev = sink.first("tool_call");
    assert.ok(ev, "should still emit a tool_call event with no session");
    assert.equal(ev!.session_id, "unknown");
  });

  it("orphan tool_execution_end (no start) → no ToolCallEvent, no throw", async () => {
    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();
    const sess = uniqueSession();
    setSession(sess.file, {
      sessionId: sess.id,
      headShaStart: null,
      branchStart: null,
      cwd: "/tmp",
    });
    register(api, sink, makeHookCtx());

    const ctx = new FakeExtensionContext("/tmp", sess.file);

    await assert.doesNotReject(async () => {
      await api.emit(
        "tool_execution_end",
        {
          toolCallId: "orphan-no-start",
          toolName: "read",
          result: { content: [] },
          isError: false,
        },
        ctx,
      );
    });

    // No ToolCallEvent should be emitted (no matching start record).
    assert.equal(sink.all("tool_call").length, 0);
    clearSession(sess.file);
  });
});

// ---------------------------------------------------------------------------
// Full bashCommitPushPr scenario (T17)
// ---------------------------------------------------------------------------

describe("hooks/tool — bashCommitPushPr scenario", () => {
  it("emits tool_call, commit_made, git-push, and gh-pr-create events", async () => {
    const api = new FakeExtensionAPI();
    const sink = new CollectorSink();

    // Bridge api.exec → hookCtx.exec so that seedDefaultGitReplies() affects
    // the SHA capture inside tool.ts's git-commit handler.
    const bridgeExec: ExecFn = async (cmd, args, opts) => {
      const res = await api.exec(cmd, args, opts);
      return { stdout: res.stdout, stderr: res.stderr, exitCode: res.code };
    };

    // Only register the tool hook — session_id will be "unknown" because no
    // session hook is wired, but the tool events are what we're asserting on.
    register(api, sink, { config: BASE_CONFIG, exec: bridgeExec });

    const ctx = new FakeExtensionContext(
      "/tmp/test-repo",
      "/tmp/scenario-bash-commit-push.jsonl",
    );

    // The scenario seeds exec replies (including git rev-parse HEAD → the known SHA)
    // and fires all events through the api.
    await bashCommitPushPr(api, ctx);

    // All assertions — event ordering is: tool_execution_end arrives last, so
    // by the time bashCommitPushPr resolves, everything is emitted.
    assert.ok(
      sink.all("tool_call").length >= 1,
      "should have at least one tool_call event",
    );
    assert.equal(
      sink.all("commit_made").length,
      1,
      "should have exactly 1 commit_made event (from git commit detection)",
    );
    const effects = sink.all("tool_side_effect");
    assert.ok(
      effects.some((e) => e.effect === "git-push"),
      "should have a git-push ToolSideEffectEvent",
    );
    assert.ok(
      effects.some((e) => e.effect === "gh-pr-create"),
      "should have a gh-pr-create ToolSideEffectEvent",
    );
  });
});
