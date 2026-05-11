/**
 * scenarios.ts — Reusable pre-recorded pi event sequences for the test harness.
 *
 * Each scenario factory:
 *   1. Seeds appropriate exec() replies on the FakeExtensionAPI so that hooks
 *      (T6–T10) that call pi.exec / captureRepoSnapshot / detectGitOps can
 *      receive realistic responses.
 *   2. Emits a complete pi event sequence via api.emit() in the same order
 *      that pi would fire them during a real session.
 *
 * Scenarios do NOT depend on T6–T10 hooks — they only call api.emit().
 * The integration tests (T18) are responsible for registering hooks before
 * running a scenario.
 *
 * Event order per pi's lifecycle docs:
 *   session_start
 *   input → before_agent_start
 *   [for each turn:]
 *     turn_start → after_provider_response
 *     [for each tool call:]
 *       tool_execution_start → tool_call → tool_result → tool_execution_end
 *     message_end → turn_end
 *   session_shutdown
 */

import { FakeExtensionAPI, FakeExtensionContext } from "./harness.ts";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function uuid(): string {
  return crypto.randomUUID();
}

function now(): number {
  return Date.now();
}

/**
 * Builds a fake LLM usage block matching the shape T9 (message.ts) reads.
 * All token fields use camelCase to match pi's real event shape.
 */
function usage(
  inputTokens: number,
  outputTokens: number,
  costTotal: number,
): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
} {
  const costInput = +(costTotal * 0.75).toFixed(6);
  const costOutput = +(costTotal - costInput).toFixed(6);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: {
      input: costInput,
      output: costOutput,
      cacheRead: 0,
      cacheWrite: 0,
      total: costTotal,
    },
  };
}

/**
 * Seed the default set of git exec replies needed by T6/T11 (captureRepoSnapshot)
 * and T12 (detectGitOps follow-up calls). Call before emitting session_start.
 *
 * All values are overrideable — callers can call setExecReplyExact() after
 * this function to change specific replies.
 */
export function seedDefaultGitReplies(
  api: FakeExtensionAPI,
  opts: {
    repoRoot?: string;
    remote?: string;
    branch?: string;
    headSha?: string;
    dirtyCount?: string;
    prNumber?: number;
    prUrl?: string;
  } = {},
): void {
  const repoRoot = opts.repoRoot ?? "/tmp/test-repo";
  const remote = opts.remote ?? "https://github.com/test/repo.git";
  const branch = opts.branch ?? "main";
  const headSha = opts.headSha ?? "abc1234567890abcdef1234567890abcdef12345";
  const dirtyCount = opts.dirtyCount ?? "0";

  // Exact matches for git rev-parse sub-commands (disambiguate --show-toplevel,
  // --abbrev-ref HEAD, and HEAD since all share args[0] = "rev-parse").
  api.setExecReplyExact("git", ["rev-parse", "--show-toplevel"], {
    stdout: `${repoRoot}\n`,
    stderr: "",
    exitCode: 0,
  });
  api.setExecReplyExact("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    stdout: `${branch}\n`,
    stderr: "",
    exitCode: 0,
  });
  api.setExecReplyExact("git", ["rev-parse", "HEAD"], {
    stdout: `${headSha}\n`,
    stderr: "",
    exitCode: 0,
  });

  // Subcommand-level fallbacks for other git calls.
  api.setExecReply("git", "config", {
    stdout: `${remote}\n`,
    stderr: "",
    exitCode: 0,
  });
  api.setExecReply("git", "status", {
    stdout: `${dirtyCount}\n`,
    stderr: "",
    exitCode: 0,
  });
  api.setExecReply("git", "log", { stdout: "", stderr: "", exitCode: 0 });
  api.setExecReply("git", "merge-base", { stdout: "", stderr: "", exitCode: 0 });

  // gh pr view — no PR found by default.
  if (opts.prNumber != null && opts.prUrl != null) {
    api.setExecReply("gh", "pr", {
      stdout: JSON.stringify({ number: opts.prNumber, url: opts.prUrl, title: "Test PR" }),
      stderr: "",
      exitCode: 0,
    });
  } else {
    api.setExecReply("gh", "pr", {
      stdout: "",
      stderr: "no pull requests found",
      exitCode: 1,
    });
  }
}

// ---------------------------------------------------------------------------
// basicSession
// ---------------------------------------------------------------------------

/**
 * Minimal complete session with a single `read` tool call.
 *
 * Events emitted:
 *   session_start → input → before_agent_start → turn_start →
 *   after_provider_response → tool_execution_start → tool_call →
 *   tool_result → tool_execution_end → message_end → turn_end →
 *   session_shutdown
 *
 * Expected sink state after this scenario:
 *   sessions=1, prompts=1, turns=1, llm_messages=1, tool_calls=1,
 *   files_touched=1, cost_total > 0
 */
export async function basicSession(
  api: FakeExtensionAPI,
  ctx?: FakeExtensionContext,
): Promise<void> {
  const resolvedCtx = ctx ?? new FakeExtensionContext();
  seedDefaultGitReplies(api);

  const toolCallId = uuid();
  const t = now();

  await api.emit("session_start", { reason: "startup" }, resolvedCtx);

  await api.emit(
    "input",
    { text: "List files in this directory.", images: [], source: "interactive" },
    resolvedCtx,
  );

  await api.emit(
    "before_agent_start",
    {
      prompt: "List files in this directory.",
      images: [],
      systemPrompt: "",
    },
    resolvedCtx,
  );

  await api.emit("turn_start", { turnIndex: 0, timestamp: t }, resolvedCtx);

  await api.emit(
    "after_provider_response",
    {
      status: 200,
      headers: {
        "anthropic-ratelimit-requests-remaining": "100",
        "anthropic-ratelimit-tokens-remaining": "90000",
      },
    },
    resolvedCtx,
  );

  // Tool: read
  await api.emit(
    "tool_execution_start",
    {
      toolCallId,
      toolName: "read",
      args: { path: "/tmp/test-repo/README.md" },
    },
    resolvedCtx,
  );

  await api.emit(
    "tool_call",
    { toolCallId, toolName: "read", input: { path: "/tmp/test-repo/README.md" } },
    resolvedCtx,
  );

  await api.emit(
    "tool_result",
    {
      toolCallId,
      toolName: "read",
      input: { path: "/tmp/test-repo/README.md" },
      content: [{ type: "text", text: "# Test Repo\n\nA test repository.\n" }],
      details: { path: "/tmp/test-repo/README.md" },
      isError: false,
    },
    resolvedCtx,
  );

  await api.emit(
    "tool_execution_end",
    {
      toolCallId,
      toolName: "read",
      result: { content: [{ type: "text", text: "# Test Repo\n\nA test repository.\n" }] },
      isError: false,
    },
    resolvedCtx,
  );

  await api.emit(
    "message_end",
    {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "The directory contains README.md." }],
        usage: usage(100, 20, 0.0004),
        stopReason: "end_turn",
      },
    },
    resolvedCtx,
  );

  await api.emit(
    "turn_end",
    { turnIndex: 0, message: { role: "assistant" }, toolResults: [] },
    resolvedCtx,
  );

  await api.emit(
    "session_shutdown",
    { reason: "quit", targetSessionFile: undefined },
    resolvedCtx,
  );
}

// ---------------------------------------------------------------------------
// multiTurnWithToolError
// ---------------------------------------------------------------------------

/**
 * Two turns: turn 0 has a bash tool error, turn 1 succeeds on retry.
 *
 * Expected sink state: turns=2, tool_calls=2, exactly one with is_error=1.
 */
export async function multiTurnWithToolError(
  api: FakeExtensionAPI,
  ctx?: FakeExtensionContext,
): Promise<void> {
  const resolvedCtx = ctx ?? new FakeExtensionContext();
  seedDefaultGitReplies(api);

  const t = now();

  await api.emit("session_start", { reason: "startup" }, resolvedCtx);

  await api.emit(
    "input",
    { text: "Run the tests.", images: [], source: "interactive" },
    resolvedCtx,
  );
  await api.emit(
    "before_agent_start",
    { prompt: "Run the tests.", images: [], systemPrompt: "" },
    resolvedCtx,
  );

  // ── Turn 0 — bash with error ────────────────────────────────────────────
  const tc0 = uuid();
  await api.emit("turn_start", { turnIndex: 0, timestamp: t }, resolvedCtx);
  await api.emit("after_provider_response", { status: 200, headers: {} }, resolvedCtx);

  await api.emit(
    "tool_execution_start",
    { toolCallId: tc0, toolName: "bash", args: { command: "npm test" } },
    resolvedCtx,
  );
  await api.emit(
    "tool_call",
    { toolCallId: tc0, toolName: "bash", input: { command: "npm test" } },
    resolvedCtx,
  );
  await api.emit(
    "tool_result",
    {
      toolCallId: tc0,
      toolName: "bash",
      input: { command: "npm test" },
      content: [{ type: "text", text: "Error: 2 tests failed\n" }],
      details: { exitCode: 1 },
      isError: true,
    },
    resolvedCtx,
  );
  await api.emit(
    "tool_execution_end",
    {
      toolCallId: tc0,
      toolName: "bash",
      result: { content: [{ type: "text", text: "Error: 2 tests failed\n" }] },
      isError: true,
    },
    resolvedCtx,
  );
  await api.emit(
    "message_end",
    {
      message: {
        role: "assistant",
        usage: usage(80, 15, 0.000315),
        stopReason: "tool_use",
      },
    },
    resolvedCtx,
  );
  await api.emit(
    "turn_end",
    { turnIndex: 0, message: { role: "assistant" }, toolResults: [] },
    resolvedCtx,
  );

  // ── Turn 1 — bash success (retry with --bail) ───────────────────────────
  const tc1 = uuid();
  await api.emit("turn_start", { turnIndex: 1, timestamp: t + 2000 }, resolvedCtx);
  await api.emit("after_provider_response", { status: 200, headers: {} }, resolvedCtx);

  await api.emit(
    "tool_execution_start",
    { toolCallId: tc1, toolName: "bash", args: { command: "npm test -- --bail" } },
    resolvedCtx,
  );
  await api.emit(
    "tool_call",
    { toolCallId: tc1, toolName: "bash", input: { command: "npm test -- --bail" } },
    resolvedCtx,
  );
  await api.emit(
    "tool_result",
    {
      toolCallId: tc1,
      toolName: "bash",
      input: { command: "npm test -- --bail" },
      content: [{ type: "text", text: "Tests passed: 42\n" }],
      details: { exitCode: 0 },
      isError: false,
    },
    resolvedCtx,
  );
  await api.emit(
    "tool_execution_end",
    {
      toolCallId: tc1,
      toolName: "bash",
      result: { content: [{ type: "text", text: "Tests passed: 42\n" }] },
      isError: false,
    },
    resolvedCtx,
  );
  await api.emit(
    "message_end",
    {
      message: {
        role: "assistant",
        usage: usage(120, 30, 0.00051),
        stopReason: "end_turn",
      },
    },
    resolvedCtx,
  );
  await api.emit(
    "turn_end",
    { turnIndex: 1, message: { role: "assistant" }, toolResults: [] },
    resolvedCtx,
  );

  await api.emit("session_shutdown", { reason: "quit" }, resolvedCtx);
}

// ---------------------------------------------------------------------------
// bashCommitPushPr
// ---------------------------------------------------------------------------

/**
 * Single turn where the LLM runs a bash command that commits, pushes, and
 * creates a PR in one chained invocation.
 *
 * Expected sink state:
 *   commits_made row, tool_side_effect records for git-push + gh-pr-create,
 *   branch still "feat/analytics" at session end.
 */
export async function bashCommitPushPr(
  api: FakeExtensionAPI,
  ctx?: FakeExtensionContext,
): Promise<void> {
  const resolvedCtx = ctx ?? new FakeExtensionContext();

  const headSha = "deadbeef1234567890abcdef1234567890abcdef";
  seedDefaultGitReplies(api, { branch: "feat/analytics", headSha });

  // After git commit, HEAD advances to headSha.
  api.setExecReplyExact("git", ["rev-parse", "HEAD"], {
    stdout: `${headSha}\n`,
    stderr: "",
    exitCode: 0,
  });
  // gh pr create succeeds.
  api.setExecReplyExact("gh", ["pr", "create", "--fill"], {
    stdout: "https://github.com/test/repo/pull/42\n",
    stderr: "",
    exitCode: 0,
  });

  const t = now();
  const toolCallId = uuid();
  const bashCmd =
    "git add . && git commit -m 'feat: add analytics' && git push -u origin feat/analytics && gh pr create --fill";

  await api.emit("session_start", { reason: "startup" }, resolvedCtx);
  await api.emit(
    "input",
    { text: "Commit, push, and open a PR.", images: [], source: "interactive" },
    resolvedCtx,
  );
  await api.emit(
    "before_agent_start",
    { prompt: "Commit, push, and open a PR.", images: [], systemPrompt: "" },
    resolvedCtx,
  );
  await api.emit("turn_start", { turnIndex: 0, timestamp: t }, resolvedCtx);
  await api.emit("after_provider_response", { status: 200, headers: {} }, resolvedCtx);

  await api.emit(
    "tool_execution_start",
    { toolCallId, toolName: "bash", args: { command: bashCmd } },
    resolvedCtx,
  );
  await api.emit(
    "tool_call",
    { toolCallId, toolName: "bash", input: { command: bashCmd } },
    resolvedCtx,
  );
  await api.emit(
    "tool_result",
    {
      toolCallId,
      toolName: "bash",
      input: { command: bashCmd },
      content: [{ type: "text", text: "https://github.com/test/repo/pull/42\n" }],
      details: { exitCode: 0 },
      isError: false,
    },
    resolvedCtx,
  );
  await api.emit(
    "tool_execution_end",
    {
      toolCallId,
      toolName: "bash",
      result: { content: [{ type: "text", text: "https://github.com/test/repo/pull/42\n" }] },
      isError: false,
    },
    resolvedCtx,
  );
  await api.emit(
    "message_end",
    {
      message: {
        role: "assistant",
        usage: usage(200, 50, 0.00085),
        stopReason: "end_turn",
      },
    },
    resolvedCtx,
  );
  await api.emit(
    "turn_end",
    { turnIndex: 0, message: { role: "assistant" }, toolResults: [] },
    resolvedCtx,
  );
  await api.emit("session_shutdown", { reason: "quit" }, resolvedCtx);
}

// ---------------------------------------------------------------------------
// sessionFork
// ---------------------------------------------------------------------------

/**
 * Models a fork flow:
 *   session_start (startup, parentCtx) → work → session_shutdown (fork) →
 *   session_start (fork, forkCtx, previousSessionFile=parentFile) →
 *   session_shutdown (quit)
 *
 * Returns the parent and fork session file paths for assertion.
 *
 * Expected sink state: sessions=2, second row has non-null parent_session_id
 * and parent_session_file.
 */
export async function sessionFork(
  api: FakeExtensionAPI,
  ctx?: FakeExtensionContext,
): Promise<{ parentFile: string; forkFile: string }> {
  const parentFile = "/tmp/parent-session.jsonl";
  const forkFile = "/tmp/fork-session.jsonl";

  const parentCtx =
    ctx ?? new FakeExtensionContext("/tmp/test-repo", parentFile);
  seedDefaultGitReplies(api);

  await api.emit("session_start", { reason: "startup" }, parentCtx);
  await api.emit(
    "input",
    { text: "Plan the feature.", images: [], source: "interactive" },
    parentCtx,
  );
  await api.emit(
    "before_agent_start",
    { prompt: "Plan the feature.", images: [], systemPrompt: "" },
    parentCtx,
  );
  await api.emit("turn_start", { turnIndex: 0, timestamp: now() }, parentCtx);
  await api.emit("after_provider_response", { status: 200, headers: {} }, parentCtx);
  await api.emit(
    "message_end",
    {
      message: {
        role: "assistant",
        usage: usage(60, 40, 0.00038),
        stopReason: "end_turn",
      },
    },
    parentCtx,
  );
  await api.emit(
    "turn_end",
    { turnIndex: 0, message: { role: "assistant" }, toolResults: [] },
    parentCtx,
  );
  await api.emit(
    "session_shutdown",
    { reason: "fork", targetSessionFile: forkFile },
    parentCtx,
  );

  // Fork session — new context with the fork's session file.
  const forkCtx = new FakeExtensionContext("/tmp/test-repo", forkFile);
  await api.emit(
    "session_start",
    { reason: "fork", previousSessionFile: parentFile },
    forkCtx,
  );
  await api.emit(
    "session_shutdown",
    { reason: "quit", targetSessionFile: undefined },
    forkCtx,
  );

  return { parentFile, forkFile };
}

// ---------------------------------------------------------------------------
// privacyModes
// ---------------------------------------------------------------------------

/**
 * Single prompt containing a fake secret (api_key=secret123) under a given
 * privacy mode. The config the hook uses should be seeded by the caller;
 * this scenario just ensures the event payload carries the raw text so hooks
 * can apply redaction.
 *
 * T18 uses this to assert:
 *   - mode="full":   NDJSON contains text; SQLite never stores raw text.
 *   - mode="hashed": NDJSON has no text; redact hits are recorded.
 *   - mode="none":   neither text nor hash stored.
 *   - All modes: "api_key=secret123" never appears verbatim.
 */
export async function privacyModes(
  api: FakeExtensionAPI,
  _mode: "full" | "hashed" | "none",
  ctx?: FakeExtensionContext,
): Promise<void> {
  const resolvedCtx = ctx ?? new FakeExtensionContext();
  seedDefaultGitReplies(api);

  // The secret text that redaction rules should catch.
  const secretText =
    "Please do not store this api_key=secret123 in plain text. Thanks.";
  const t = now();

  await api.emit("session_start", { reason: "startup" }, resolvedCtx);
  await api.emit(
    "input",
    { text: secretText, images: [], source: "interactive" },
    resolvedCtx,
  );
  await api.emit(
    "before_agent_start",
    { prompt: secretText, images: [], systemPrompt: "" },
    resolvedCtx,
  );
  await api.emit("turn_start", { turnIndex: 0, timestamp: t }, resolvedCtx);
  await api.emit("after_provider_response", { status: 200, headers: {} }, resolvedCtx);
  await api.emit(
    "message_end",
    {
      message: {
        role: "assistant",
        usage: usage(30, 10, 0.00014),
        stopReason: "end_turn",
      },
    },
    resolvedCtx,
  );
  await api.emit(
    "turn_end",
    { turnIndex: 0, message: { role: "assistant" }, toolResults: [] },
    resolvedCtx,
  );
  await api.emit("session_shutdown", { reason: "quit" }, resolvedCtx);
}

// ---------------------------------------------------------------------------
// branchSwitchMidSession
// ---------------------------------------------------------------------------

/**
 * Session starts on `main`, switches to `feat/x` via bash in turn 0, then
 * commits and pushes in turn 1.
 *
 * Expected sink state:
 *   branch_start="main", branch_end="feat/x",
 *   branch_transitions row (from=main, to=feat/x),
 *   at least one commits_made row.
 */
export async function branchSwitchMidSession(
  api: FakeExtensionAPI,
  ctx?: FakeExtensionContext,
): Promise<void> {
  const resolvedCtx = ctx ?? new FakeExtensionContext();

  // Initial state: on main.
  seedDefaultGitReplies(api, { branch: "main" });

  // After `git checkout -b feat/x`, rev-parse --abbrev-ref HEAD returns feat/x.
  const newBranchSha = "feedc0de1234567890abcdef1234567890abcdef";
  api.setExecReplyExact("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    stdout: "feat/x\n",
    stderr: "",
    exitCode: 0,
  });
  api.setExecReplyExact("git", ["rev-parse", "HEAD"], {
    stdout: `${newBranchSha}\n`,
    stderr: "",
    exitCode: 0,
  });

  const t = now();

  await api.emit("session_start", { reason: "startup" }, resolvedCtx);
  await api.emit(
    "input",
    {
      text: "Create a feature branch, make a commit, and push.",
      images: [],
      source: "interactive",
    },
    resolvedCtx,
  );
  await api.emit(
    "before_agent_start",
    { prompt: "Create a feature branch and commit.", images: [], systemPrompt: "" },
    resolvedCtx,
  );

  // ── Turn 0: create branch ─────────────────────────────────────────────────
  const tc0 = uuid();
  await api.emit("turn_start", { turnIndex: 0, timestamp: t }, resolvedCtx);
  await api.emit("after_provider_response", { status: 200, headers: {} }, resolvedCtx);

  await api.emit(
    "tool_execution_start",
    { toolCallId: tc0, toolName: "bash", args: { command: "git checkout -b feat/x" } },
    resolvedCtx,
  );
  await api.emit(
    "tool_call",
    { toolCallId: tc0, toolName: "bash", input: { command: "git checkout -b feat/x" } },
    resolvedCtx,
  );
  await api.emit(
    "tool_result",
    {
      toolCallId: tc0,
      toolName: "bash",
      input: { command: "git checkout -b feat/x" },
      content: [{ type: "text", text: "Switched to a new branch 'feat/x'\n" }],
      details: { exitCode: 0 },
      isError: false,
    },
    resolvedCtx,
  );
  await api.emit(
    "tool_execution_end",
    {
      toolCallId: tc0,
      toolName: "bash",
      result: {},
      isError: false,
    },
    resolvedCtx,
  );
  await api.emit(
    "message_end",
    {
      message: {
        role: "assistant",
        usage: usage(90, 20, 0.00037),
        stopReason: "tool_use",
      },
    },
    resolvedCtx,
  );
  await api.emit(
    "turn_end",
    { turnIndex: 0, message: { role: "assistant" }, toolResults: [] },
    resolvedCtx,
  );

  // ── Turn 1: commit and push ───────────────────────────────────────────────
  const tc1 = uuid();
  const commitAndPush =
    "git add . && git commit -m 'feat: initial commit' && git push -u origin feat/x";
  await api.emit("turn_start", { turnIndex: 1, timestamp: t + 3000 }, resolvedCtx);
  await api.emit("after_provider_response", { status: 200, headers: {} }, resolvedCtx);

  await api.emit(
    "tool_execution_start",
    { toolCallId: tc1, toolName: "bash", args: { command: commitAndPush } },
    resolvedCtx,
  );
  await api.emit(
    "tool_call",
    { toolCallId: tc1, toolName: "bash", input: { command: commitAndPush } },
    resolvedCtx,
  );
  await api.emit(
    "tool_result",
    {
      toolCallId: tc1,
      toolName: "bash",
      input: { command: commitAndPush },
      content: [
        { type: "text", text: "Branch 'feat/x' set up to track 'origin/feat/x'.\n" },
      ],
      details: { exitCode: 0 },
      isError: false,
    },
    resolvedCtx,
  );
  await api.emit(
    "tool_execution_end",
    {
      toolCallId: tc1,
      toolName: "bash",
      result: {},
      isError: false,
    },
    resolvedCtx,
  );
  await api.emit(
    "message_end",
    {
      message: {
        role: "assistant",
        usage: usage(110, 25, 0.000455),
        stopReason: "end_turn",
      },
    },
    resolvedCtx,
  );
  await api.emit(
    "turn_end",
    { turnIndex: 1, message: { role: "assistant" }, toolResults: [] },
    resolvedCtx,
  );

  await api.emit("session_shutdown", { reason: "quit" }, resolvedCtx);
}
