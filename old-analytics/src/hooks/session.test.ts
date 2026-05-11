/**
 * session.test.ts — Tests for hooks/session.ts (T6).
 *
 * Uses FakeExtensionAPI / FakeExtensionContext from T17 to drive event
 * handlers without a real pi process. Uses a CaptureSink (records written
 * events) instead of SqliteSink/NdjsonSink for isolation.
 *
 * Coverage:
 *   - session_start emits session_start event immediately with null git fields
 *   - session_start fires captureRepoSnapshot → emits session_patch asynchronously
 *   - session_start fires fetchPrForBranch (when fetchPR=true) → emits pr_association
 *   - session_shutdown emits session_end with exit_reason
 *   - session_shutdown emits commit_made + file_touched for diff range
 *   - model_select emits model_select event
 *   - thinking_level_select emits thinking_level_select event
 *   - session state is cleared after session_shutdown
 *   - getActiveSessionId returns correct ID after session_start
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import {
  FakeExtensionAPI,
  FakeExtensionContext,
} from "../test-harness/harness.ts";
import { seedDefaultGitReplies } from "../test-harness/scenarios.ts";
import { register } from "./session.ts";
import { getActiveSessionId } from "./session-state.ts";
import type {
  AnalyticsConfig,
  AnalyticsEvent,
  AnalyticsSink,
} from "../sinks/types.ts";
import type { ExecFn } from "../git/capture.ts";

// ---------------------------------------------------------------------------
// CaptureSink — records all written events for assertion
// ---------------------------------------------------------------------------

class CaptureSink implements AnalyticsSink {
  readonly events: AnalyticsEvent[] = [];

  async init(_config: AnalyticsConfig): Promise<void> {}

  write(event: AnalyticsEvent): void {
    this.events.push(event);
  }

  async flush(): Promise<void> {}
  async close(): Promise<void> {}

  /** Find all events of a given kind. */
  all<K extends AnalyticsEvent["kind"]>(
    kind: K,
  ): Extract<AnalyticsEvent, { kind: K }>[] {
    return this.events.filter(
      (e): e is Extract<AnalyticsEvent, { kind: K }> => e.kind === kind,
    );
  }

  /** Find the first event of a given kind, or undefined. */
  first<K extends AnalyticsEvent["kind"]>(
    kind: K,
  ): Extract<AnalyticsEvent, { kind: K }> | undefined {
    return this.all(kind)[0];
  }
}

// ---------------------------------------------------------------------------
// Test config
// ---------------------------------------------------------------------------

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
  git: {
    enabled: true,
    fetchPR: true,
    ghTimeoutMs: 2000,
  },
};

// Adapter: FakeExtensionAPI.exec returns { code } but ExecFn expects { exitCode }.
function makeExecFn(api: FakeExtensionAPI): ExecFn {
  return async (cmd, args, opts) => {
    const result = await api.exec(cmd, args, opts);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.code,
    };
  };
}

// ---------------------------------------------------------------------------
// Helpers to pause for micro-tasks so fire-and-forget .then() callbacks run
// ---------------------------------------------------------------------------

/** Flush all pending micro-tasks (Promise.resolve chains). */
async function flushMicrotasks(): Promise<void> {
  // Two await cycles: one to flush the initial .then(), one for any nested .then()s.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("T6 hooks/session", () => {
  describe("session_start", () => {
    it("emits session_start event immediately with null git fields", async () => {
      const api = new FakeExtensionAPI();
      const ctx = new FakeExtensionContext("/tmp/test-repo", "/tmp/s1.jsonl");
      const sink = new CaptureSink();
      seedDefaultGitReplies(api);

      register(api, sink, { config: TEST_CONFIG, exec: makeExecFn(api) });
      await api.emit("session_start", { reason: "startup" }, ctx);

      const ev = sink.first("session_start");
      assert.ok(ev, "session_start event should be emitted");
      assert.equal(ev.cwd, "/tmp/test-repo");
      assert.equal(ev.parent_session_file, null);
      assert.ok(typeof ev.id === "string" && ev.id.length > 0);
      // Git fields are null at emission time (captured asynchronously).
      assert.equal(ev.repo_root, null);
      assert.equal(ev.branch_start, null);
    });

    it("carries previousSessionFile in parent_session_file for fork", async () => {
      const api = new FakeExtensionAPI();
      const ctx = new FakeExtensionContext("/tmp/test-repo", "/tmp/fork.jsonl");
      const sink = new CaptureSink();
      seedDefaultGitReplies(api);

      register(api, sink, { config: TEST_CONFIG, exec: makeExecFn(api) });
      await api.emit(
        "session_start",
        { reason: "fork", previousSessionFile: "/tmp/parent.jsonl" },
        ctx,
      );

      const ev = sink.first("session_start");
      assert.ok(ev);
      assert.equal(ev.parent_session_file, "/tmp/parent.jsonl");
    });

    it("emits session_patch after captureRepoSnapshot resolves", async () => {
      const api = new FakeExtensionAPI();
      const ctx = new FakeExtensionContext("/tmp/test-repo", "/tmp/s2.jsonl");
      const sink = new CaptureSink();
      seedDefaultGitReplies(api, {
        repoRoot: "/tmp/test-repo",
        remote: "https://github.com/user/repo.git",
        branch: "main",
        headSha: "abc123",
      });

      register(api, sink, { config: TEST_CONFIG, exec: makeExecFn(api) });
      await api.emit("session_start", { reason: "startup" }, ctx);
      await flushMicrotasks();

      const patch = sink.first("session_patch");
      assert.ok(patch, "session_patch should be emitted after git capture");
      assert.equal(patch.branch_start, "main");
      assert.equal(patch.head_sha_start, "abc123");
      assert.equal(patch.repo_owner, "user");
      assert.equal(patch.repo_name, "repo");
    });

    it("emits pr_association when fetchPR=true and a PR is found", async () => {
      const api = new FakeExtensionAPI();
      const ctx = new FakeExtensionContext("/tmp/test-repo", "/tmp/s3.jsonl");
      const sink = new CaptureSink();
      seedDefaultGitReplies(api, {
        branch: "feat/x",
        prNumber: 42,
        prUrl: "https://github.com/user/repo/pull/42",
      });

      register(api, sink, { config: TEST_CONFIG, exec: makeExecFn(api) });
      await api.emit("session_start", { reason: "startup" }, ctx);
      await flushMicrotasks();

      const assoc = sink.first("pr_association");
      assert.ok(assoc, "pr_association should be emitted when PR is found");
      assert.equal(assoc.pr_number, 42);
      assert.equal(assoc.confidence, 0.8);
      assert.equal(assoc.reason, "branch-match");
    });

    it("does NOT emit pr_association when fetchPR=false", async () => {
      const api = new FakeExtensionAPI();
      const ctx = new FakeExtensionContext("/tmp/test-repo", "/tmp/s4.jsonl");
      const sink = new CaptureSink();
      const cfg = {
        ...TEST_CONFIG,
        git: { ...TEST_CONFIG.git, fetchPR: false },
      };
      seedDefaultGitReplies(api, {
        prNumber: 42,
        prUrl: "https://github.com/user/repo/pull/42",
      });

      register(api, sink, { config: cfg, exec: makeExecFn(api) });
      await api.emit("session_start", { reason: "startup" }, ctx);
      await flushMicrotasks();

      assert.equal(sink.all("pr_association").length, 0);
    });

    it("does NOT emit session_patch when git is disabled", async () => {
      const api = new FakeExtensionAPI();
      const ctx = new FakeExtensionContext("/tmp/test-repo", "/tmp/s5.jsonl");
      const sink = new CaptureSink();
      const cfg = {
        ...TEST_CONFIG,
        git: { ...TEST_CONFIG.git, enabled: false },
      };

      register(api, sink, { config: cfg, exec: makeExecFn(api) });
      await api.emit("session_start", { reason: "startup" }, ctx);
      await flushMicrotasks();

      assert.equal(sink.all("session_patch").length, 0);
    });
  });

  describe("session_shutdown", () => {
    it("emits session_end with exit_reason", async () => {
      const api = new FakeExtensionAPI();
      const ctx = new FakeExtensionContext(
        "/tmp/test-repo",
        "/tmp/shut1.jsonl",
      );
      const sink = new CaptureSink();
      seedDefaultGitReplies(api);

      register(api, sink, { config: TEST_CONFIG, exec: makeExecFn(api) });
      await api.emit("session_start", { reason: "startup" }, ctx);
      await flushMicrotasks();
      await api.emit("session_shutdown", { reason: "quit" }, ctx);

      const end = sink.first("session_end");
      assert.ok(end, "session_end should be emitted");
      assert.equal(end.exit_reason, "quit");
      assert.ok(end.session_id.length > 0);
    });

    it("session_end session_id matches session_start id", async () => {
      const api = new FakeExtensionAPI();
      const ctx = new FakeExtensionContext(
        "/tmp/test-repo",
        "/tmp/shut2.jsonl",
      );
      const sink = new CaptureSink();
      seedDefaultGitReplies(api);

      register(api, sink, { config: TEST_CONFIG, exec: makeExecFn(api) });
      await api.emit("session_start", { reason: "startup" }, ctx);
      await api.emit("session_shutdown", { reason: "quit" }, ctx);

      const start = sink.first("session_start");
      const end = sink.first("session_end");
      assert.ok(start && end);
      assert.equal(start.id, end.session_id);
    });

    it("clears session state after shutdown", async () => {
      const api = new FakeExtensionAPI();
      const sessionFile = "/tmp/shut3.jsonl";
      const ctx = new FakeExtensionContext("/tmp/test-repo", sessionFile);
      const sink = new CaptureSink();
      seedDefaultGitReplies(api);

      register(api, sink, { config: TEST_CONFIG, exec: makeExecFn(api) });
      await api.emit("session_start", { reason: "startup" }, ctx);
      assert.ok(getActiveSessionId(sessionFile), "session should be registered");
      await api.emit("session_shutdown", { reason: "quit" }, ctx);
      assert.equal(
        getActiveSessionId(sessionFile),
        null,
        "session should be cleared after shutdown",
      );
    });

    it("emits commit_made events from diff range", async () => {
      const api = new FakeExtensionAPI();
      const ctx = new FakeExtensionContext(
        "/tmp/test-repo",
        "/tmp/shut4.jsonl",
      );
      const sink = new CaptureSink();

      const startSha = "aaa0000000000000000000000000000000000000";
      const endSha = "bbb0000000000000000000000000000000000000";

      // Seed startSha for the session_start fire-and-forget git capture.
      // DO NOT override HEAD yet — let the initial capture see startSha.
      seedDefaultGitReplies(api, { headSha: startSha, branch: "main" });
      // getDiffSummary uses git log — seed it now so it's ready at shutdown.
      api.setExecReply("git", "log", {
        stdout: [
          `COMMIT_SEP|${endSha}|feat: add analytics`,
          "",
          "5\t2\tsrc/index.ts",
          "",
        ].join("\n"),
        stderr: "",
        exitCode: 0,
      });

      register(api, sink, { config: TEST_CONFIG, exec: makeExecFn(api) });
      await api.emit("session_start", { reason: "startup" }, ctx);
      // Flush so session_start's fire-and-forget captureRepoSnapshot runs and
      // stores headShaStart = startSha in the session snapshot.
      await flushMicrotasks();

      // NOW override HEAD so the shutdown captureRepoSnapshot returns endSha.
      // This simulates a commit being made during the session.
      api.setExecReplyExact("git", ["rev-parse", "HEAD"], {
        stdout: `${endSha}\n`,
        stderr: "",
        exitCode: 0,
      });

      await api.emit("session_shutdown", { reason: "quit" }, ctx);

      const commits = sink.all("commit_made");
      assert.ok(commits.length >= 1, "should emit at least one commit_made");
      assert.equal(commits[0]!.sha, endSha);
      assert.equal(commits[0]!.subject, "feat: add analytics");

      const files = sink.all("file_touched");
      const diffFiles = files.filter((f) => f.op === "bash-derived");
      assert.ok(diffFiles.length >= 1, "should emit file_touched for diff files");
      assert.equal(diffFiles[0]!.path, "src/index.ts");
    });
  });

  describe("model_select", () => {
    it("emits model_select event with model info", async () => {
      const api = new FakeExtensionAPI();
      const ctx = new FakeExtensionContext(
        "/tmp/test-repo",
        "/tmp/model1.jsonl",
      );
      const sink = new CaptureSink();
      seedDefaultGitReplies(api);

      register(api, sink, { config: TEST_CONFIG, exec: makeExecFn(api) });
      await api.emit("session_start", { reason: "startup" }, ctx);
      await api.emit(
        "model_select",
        {
          model: { id: "claude-opus-4-20250514", provider: "anthropic" },
          source: "set",
        },
        ctx,
      );

      const ev = sink.first("model_select");
      assert.ok(ev, "model_select event should be emitted");
      assert.equal(ev.model_id, "claude-opus-4-20250514");
      assert.equal(ev.provider, "anthropic");
    });

    it("ignores model_select before session_start", async () => {
      const api = new FakeExtensionAPI();
      const ctx = new FakeExtensionContext(
        "/tmp/test-repo",
        "/tmp/model2.jsonl",
      );
      const sink = new CaptureSink();

      register(api, sink, { config: TEST_CONFIG, exec: makeExecFn(api) });
      // No session_start — model_select should be silently ignored
      await api.emit(
        "model_select",
        { model: { id: "claude-opus-4-20250514", provider: "anthropic" }, source: "set" },
        ctx,
      );

      assert.equal(sink.all("model_select").length, 0);
    });
  });

  describe("thinking_level_select", () => {
    it("emits thinking_level_select event", async () => {
      const api = new FakeExtensionAPI();
      const ctx = new FakeExtensionContext(
        "/tmp/test-repo",
        "/tmp/thinking1.jsonl",
      );
      const sink = new CaptureSink();
      seedDefaultGitReplies(api);

      register(api, sink, { config: TEST_CONFIG, exec: makeExecFn(api) });
      await api.emit("session_start", { reason: "startup" }, ctx);
      await api.emit(
        "thinking_level_select",
        { level: "high", previousLevel: "low" },
        ctx,
      );

      const ev = sink.first("thinking_level_select");
      assert.ok(ev, "thinking_level_select event should be emitted");
      assert.equal(ev.thinking_level, "high");
    });
  });

  describe("session fork flow", () => {
    it("tracks two sessions independently", async () => {
      const api = new FakeExtensionAPI();
      const parentCtx = new FakeExtensionContext(
        "/tmp/test-repo",
        "/tmp/parent.jsonl",
      );
      const forkCtx = new FakeExtensionContext(
        "/tmp/test-repo",
        "/tmp/fork.jsonl",
      );
      const sink = new CaptureSink();
      seedDefaultGitReplies(api);

      register(api, sink, { config: TEST_CONFIG, exec: makeExecFn(api) });

      // Parent session
      await api.emit("session_start", { reason: "startup" }, parentCtx);
      await api.emit(
        "session_shutdown",
        { reason: "fork", targetSessionFile: "/tmp/fork.jsonl" },
        parentCtx,
      );

      // Fork session
      await api.emit(
        "session_start",
        { reason: "fork", previousSessionFile: "/tmp/parent.jsonl" },
        forkCtx,
      );
      await api.emit(
        "session_shutdown",
        { reason: "quit" },
        forkCtx,
      );

      const starts = sink.all("session_start");
      const ends = sink.all("session_end");
      assert.equal(starts.length, 2, "two session_start events");
      assert.equal(ends.length, 2, "two session_end events");

      // IDs must be distinct
      assert.notEqual(starts[0]!.id, starts[1]!.id);

      // Fork carries previousSessionFile
      const forkStart = starts.find((s) => s.parent_session_file !== null);
      assert.ok(forkStart, "fork session should carry parent_session_file");
      assert.equal(forkStart.parent_session_file, "/tmp/parent.jsonl");
    });
  });
});
