/**
 * harness.test.ts — Self-tests for the FakeExtensionAPI / FakeExtensionContext
 * test rig.
 *
 * These tests verify the harness machinery itself (listener dispatch, exec
 * lookup, recording stubs, FakeUi queues). They do NOT test T6–T10 hooks —
 * those are covered by T18 (integration.test.ts).
 *
 * Run with:
 *   node --test src/test-harness/harness.test.ts
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  FakeExtensionAPI,
  FakeExtensionContext,
  FakeUi,
  FakeSessionManager,
} from "./harness.ts";
import * as scenarios from "./scenarios.ts";

// ---------------------------------------------------------------------------
// FakeExtensionAPI — event dispatch
// ---------------------------------------------------------------------------

describe("FakeExtensionAPI — listener dispatch", () => {
  test("registers a listener and delivers the payload to it", async () => {
    const api = new FakeExtensionAPI();
    const received: unknown[] = [];

    api.on("session_start", (event) => {
      received.push(event);
    });

    await api.emit("session_start", { reason: "startup" });

    assert.equal(received.length, 1);
    assert.deepEqual(received[0], { reason: "startup" });
  });

  test("returns empty array when no listeners are registered for the event", async () => {
    const api = new FakeExtensionAPI();
    const results = await api.emit("no_such_event", { x: 1 });
    assert.deepEqual(results, []);
  });

  test("runs multiple listeners in registration order", async () => {
    const api = new FakeExtensionAPI();
    const order: number[] = [];

    api.on("turn_start", () => { order.push(1); });
    api.on("turn_start", () => { order.push(2); });
    api.on("turn_start", () => { order.push(3); });

    await api.emit("turn_start", { turnIndex: 0 });

    assert.deepEqual(order, [1, 2, 3]);
  });

  test("awaits each async listener before starting the next", async () => {
    const api = new FakeExtensionAPI();
    const log: string[] = [];

    api.on("input", async () => {
      log.push("A:start");
      await new Promise<void>((r) => setTimeout(r, 10));
      log.push("A:end");
    });

    api.on("input", () => {
      // If emit didn't await the first listener, this would run before A:end.
      log.push("B:sync");
    });

    await api.emit("input", { text: "hello" });

    assert.deepEqual(log, ["A:start", "A:end", "B:sync"]);
  });

  test("collects and returns each listener's return value", async () => {
    const api = new FakeExtensionAPI();
    api.on("message_end", () => 42);
    api.on("message_end", async () => "hello");
    api.on("message_end", () => undefined);

    const results = await api.emit("message_end", {});
    assert.deepEqual(results, [42, "hello", undefined]);
  });

  test("passes the provided ctx to every listener", async () => {
    const api = new FakeExtensionAPI();
    const ctx = new FakeExtensionContext("/custom/cwd");
    const cwds: string[] = [];

    api.on("session_start", (_event, c) => { cwds.push(c.cwd); });
    api.on("session_start", (_event, c) => { cwds.push(c.cwd); });

    await api.emit("session_start", {}, ctx);
    assert.deepEqual(cwds, ["/custom/cwd", "/custom/cwd"]);
  });

  test("creates a default FakeExtensionContext when ctx is omitted", async () => {
    const api = new FakeExtensionAPI();
    let received: FakeExtensionContext | undefined;

    api.on("session_start", (_event, c) => {
      received = c;
    });

    await api.emit("session_start", {});
    assert.ok(received instanceof FakeExtensionContext, "ctx is FakeExtensionContext");
  });

  test("independent emits on different event names don't interfere", async () => {
    const api = new FakeExtensionAPI();
    const a: string[] = [];
    const b: string[] = [];

    api.on("turn_start", () => { a.push("turn_start"); });
    api.on("turn_end", () => { b.push("turn_end"); });

    await api.emit("turn_start", {});
    await api.emit("turn_end", {});

    assert.deepEqual(a, ["turn_start"]);
    assert.deepEqual(b, ["turn_end"]);
  });
});

// ---------------------------------------------------------------------------
// FakeExtensionAPI — exec()
// ---------------------------------------------------------------------------

describe("FakeExtensionAPI — exec()", () => {
  test("setExecReply(cmd, firstArg) matches all calls sharing cmd+args[0]", async () => {
    const api = new FakeExtensionAPI();
    api.setExecReply("git", "rev-parse", { stdout: "/repo\n", stderr: "", exitCode: 0 });

    const r1 = await api.exec("git", ["rev-parse", "--show-toplevel"]);
    const r2 = await api.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"]);

    assert.equal(r1.stdout, "/repo\n");
    assert.equal(r2.stdout, "/repo\n");
    assert.equal(r1.code, 0);
    assert.equal(r1.killed, false);
  });

  test("setExecReplyExact takes priority over subcommand match", async () => {
    const api = new FakeExtensionAPI();
    api.setExecReply("git", "rev-parse", { stdout: "fallback\n", stderr: "", exitCode: 0 });
    api.setExecReplyExact("git", ["rev-parse", "HEAD"], {
      stdout: "abc123\n",
      stderr: "",
      exitCode: 0,
    });

    const exactMatch = await api.exec("git", ["rev-parse", "HEAD"]);
    assert.equal(exactMatch.stdout, "abc123\n");

    const subMatch = await api.exec("git", ["rev-parse", "--show-toplevel"]);
    assert.equal(subMatch.stdout, "fallback\n");
  });

  test("falls back to default reply when no key matches", async () => {
    const api = new FakeExtensionAPI();
    api.setDefaultExecReply({ stdout: "default\n", stderr: "e", exitCode: 127 });

    const result = await api.exec("unknown_cmd", ["arg"]);
    assert.equal(result.stdout, "default\n");
    assert.equal(result.code, 127);
  });

  test("returns empty stdout / code 0 when nothing is seeded", async () => {
    const api = new FakeExtensionAPI();
    const result = await api.exec("git", ["status"]);
    assert.equal(result.stdout, "");
    assert.equal(result.code, 0);
    assert.equal(result.killed, false);
  });

  test("non-zero exitCode maps to code in the return object", async () => {
    const api = new FakeExtensionAPI();
    api.setExecReply("gh", "pr", { stdout: "", stderr: "no PRs", exitCode: 1 });

    const result = await api.exec("gh", ["pr", "view"]);
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "no PRs");
  });
});

// ---------------------------------------------------------------------------
// FakeExtensionAPI — registration recording
// ---------------------------------------------------------------------------

describe("FakeExtensionAPI — registration stubs", () => {
  test("registerTool records all calls", () => {
    const api = new FakeExtensionAPI();
    api.registerTool({ name: "tool_a" });
    api.registerTool({ name: "tool_b" });
    assert.equal(api.registrations.tools.length, 2);
    assert.deepEqual(
      (api.registrations.tools[0] as { name: string }).name,
      "tool_a",
    );
  });

  test("registerCommand records name and options", () => {
    const api = new FakeExtensionAPI();
    api.registerCommand("usage", { description: "show usage" });
    assert.equal(api.registrations.commands.length, 1);
    assert.equal(api.registrations.commands[0].name, "usage");
  });

  test("registerShortcut, registerFlag, registerProvider record calls", () => {
    const api = new FakeExtensionAPI();
    api.registerShortcut("ctrl+k", {});
    api.registerFlag("verbose", { type: "boolean" });
    api.registerProvider("my-proxy", { baseUrl: "http://localhost" });
    assert.equal(api.registrations.shortcuts.length, 1);
    assert.equal(api.registrations.flags.length, 1);
    assert.equal(api.registrations.providers.length, 1);
  });

  test("appendEntry, sendMessage, sendUserMessage record calls", () => {
    const api = new FakeExtensionAPI();
    api.appendEntry("analytics-state", { count: 5 });
    api.sendMessage({ customType: "info" });
    api.sendUserMessage("hello world");

    assert.equal(api.calls.appendEntry.length, 1);
    assert.deepEqual(api.calls.appendEntry[0], {
      customType: "analytics-state",
      data: { count: 5 },
    });
    assert.equal(api.calls.sendMessage.length, 1);
    assert.equal(api.calls.sendUserMessage.length, 1);
  });

  test("setSessionName and setLabel record calls", () => {
    const api = new FakeExtensionAPI();
    api.setSessionName("my session");
    api.setLabel("entry-1", "checkpoint");
    api.setLabel("entry-2", undefined);

    assert.deepEqual(api.calls.setSessionName, ["my session"]);
    assert.equal(api.calls.setLabel.length, 2);
    assert.equal(api.calls.setLabel[1].label, undefined);
  });
});

// ---------------------------------------------------------------------------
// FakeExtensionAPI — flags / commands seeding
// ---------------------------------------------------------------------------

describe("FakeExtensionAPI — flags and commands", () => {
  test("getFlag returns seeded value and undefined for unknown keys", () => {
    const api = new FakeExtensionAPI();
    api.seedFlag("verbose", true);
    api.seedFlag("count", 42);

    assert.equal(api.getFlag("verbose"), true);
    assert.equal(api.getFlag("count"), 42);
    assert.equal(api.getFlag("missing"), undefined);
  });

  test("getCommands returns seeded list", () => {
    const api = new FakeExtensionAPI();
    api.seedCommands([{ name: "usage" }, { name: "doctor" }]);
    const cmds = api.getCommands();
    assert.equal(cmds.length, 2);
  });
});

// ---------------------------------------------------------------------------
// FakeExtensionContext
// ---------------------------------------------------------------------------

describe("FakeExtensionContext", () => {
  test("cwd is settable", () => {
    const ctx = new FakeExtensionContext("/initial");
    assert.equal(ctx.cwd, "/initial");
    ctx.cwd = "/updated";
    assert.equal(ctx.cwd, "/updated");
  });

  test("isIdle() defaults to true, setIdle() changes it", () => {
    const ctx = new FakeExtensionContext();
    assert.equal(ctx.isIdle(), true);
    ctx.setIdle(false);
    assert.equal(ctx.isIdle(), false);
  });

  test("hasPendingMessages() defaults to false, setPendingMessages() changes it", () => {
    const ctx = new FakeExtensionContext();
    assert.equal(ctx.hasPendingMessages(), false);
    ctx.setPendingMessages(true);
    assert.equal(ctx.hasPendingMessages(), true);
  });

  test("hasUI defaults to true", () => {
    const ctx = new FakeExtensionContext();
    assert.equal(ctx.hasUI, true);
  });

  test("signal is undefined by default", () => {
    const ctx = new FakeExtensionContext();
    assert.equal(ctx.signal, undefined);
  });

  test("waitForIdle increments counter", async () => {
    const ctx = new FakeExtensionContext();
    await ctx.waitForIdle();
    await ctx.waitForIdle();
    assert.equal(ctx.commandCalls.waitForIdle, 2);
  });

  test("reload() increments counter", async () => {
    const ctx = new FakeExtensionContext();
    await ctx.reload();
    assert.equal(ctx.commandCalls.reload, 1);
  });

  test("shutdown() increments counter", () => {
    const ctx = new FakeExtensionContext();
    ctx.shutdown();
    ctx.shutdown();
    assert.equal(ctx.commandCalls.shutdown, 2);
  });

  test("fork() records entryId and options", async () => {
    const ctx = new FakeExtensionContext();
    const result = await ctx.fork("entry-abc", { position: "before" });
    assert.deepEqual(result, { cancelled: false });
    assert.equal(ctx.commandCalls.fork.length, 1);
    assert.equal(ctx.commandCalls.fork[0].entryId, "entry-abc");
    assert.deepEqual(ctx.commandCalls.fork[0].opts, { position: "before" });
  });

  test("switchSession() records path and options", async () => {
    const ctx = new FakeExtensionContext();
    await ctx.switchSession("/path/to/session.jsonl", { some: "opt" });
    assert.equal(ctx.commandCalls.switchSession.length, 1);
    assert.equal(
      ctx.commandCalls.switchSession[0].sessionPath,
      "/path/to/session.jsonl",
    );
  });

  test("navigateTree() records targetId", async () => {
    const ctx = new FakeExtensionContext();
    await ctx.navigateTree("node-123");
    assert.equal(ctx.commandCalls.navigateTree.length, 1);
    assert.equal(ctx.commandCalls.navigateTree[0].targetId, "node-123");
  });
});

// ---------------------------------------------------------------------------
// FakeUi
// ---------------------------------------------------------------------------

describe("FakeUi", () => {
  test("notify() records call with default type", () => {
    const ui = new FakeUi();
    ui.notify("hello");
    assert.equal(ui.calls.length, 1);
    assert.deepEqual(ui.calls[0], { kind: "notify", message: "hello", type: "info" });
  });

  test("setStatus() records id and text", () => {
    const ui = new FakeUi();
    ui.setStatus("my-ext", "Processing...");
    assert.deepEqual(ui.calls[0], { kind: "setStatus", id: "my-ext", text: "Processing..." });
  });

  test("setWidget() records id and lines", () => {
    const ui = new FakeUi();
    ui.setWidget("w1", ["Line 1", "Line 2"]);
    assert.deepEqual(ui.calls[0], { kind: "setWidget", id: "w1", lines: ["Line 1", "Line 2"] });
  });

  test("confirm() returns seeded answers in FIFO order", async () => {
    const ui = new FakeUi();
    ui.seedConfirm(false, true, false);

    assert.equal(await ui.confirm("T", "M"), false);
    assert.equal(await ui.confirm("T", "M"), true);
    assert.equal(await ui.confirm("T", "M"), false);
  });

  test("confirm() defaults to true when queue is exhausted", async () => {
    const ui = new FakeUi();
    // No seeds — should return true.
    assert.equal(await ui.confirm("T", "M"), true);
  });

  test("select() returns seeded answer then null when exhausted", async () => {
    const ui = new FakeUi();
    ui.seedSelect("option-b");

    assert.equal(await ui.select("Pick", ["a", "b"]), "option-b");
    assert.equal(await ui.select("Pick", ["a", "b"]), null);
  });

  test("input() returns seeded answer then null when exhausted", async () => {
    const ui = new FakeUi();
    ui.seedInput("my text");

    assert.equal(await ui.input("Label"), "my text");
    assert.equal(await ui.input("Label"), null);
  });
});

// ---------------------------------------------------------------------------
// FakeSessionManager
// ---------------------------------------------------------------------------

describe("FakeSessionManager", () => {
  test("constructor sets sessionFile", () => {
    const sm = new FakeSessionManager("/tmp/s.jsonl");
    assert.equal(sm.getSessionFile(), "/tmp/s.jsonl");
  });

  test("setSessionFile() changes the value", () => {
    const sm = new FakeSessionManager(null);
    assert.equal(sm.getSessionFile(), null);
    sm.setSessionFile("/new/path.jsonl");
    assert.equal(sm.getSessionFile(), "/new/path.jsonl");
  });

  test("addEntry() appends and updates leafId when entry has id", () => {
    const sm = new FakeSessionManager();
    sm.addEntry({ type: "message", id: "entry-1" });
    sm.addEntry({ type: "message", id: "entry-2" });

    assert.equal(sm.getEntries().length, 2);
    assert.equal(sm.getLeafId(), "entry-2");
  });

  test("addEntry() without id does not update leafId", () => {
    const sm = new FakeSessionManager();
    sm.addEntry({ type: "message", id: "first" });
    sm.addEntry({ type: "custom" }); // no id
    assert.equal(sm.getLeafId(), "first");
  });

  test("getLeafEntry() returns the entry matching leafId", () => {
    const sm = new FakeSessionManager();
    sm.addEntry({ type: "message", id: "e1", content: "hello" });
    sm.addEntry({ type: "message", id: "e2", content: "world" });

    const leaf = sm.getLeafEntry();
    assert.ok(leaf != null);
    assert.equal(leaf.id, "e2");
  });

  test("getBranch() returns same array as getEntries()", () => {
    const sm = new FakeSessionManager();
    sm.addEntry({ type: "x", id: "a" });
    sm.addEntry({ type: "y", id: "b" });

    assert.deepEqual(sm.getBranch(), sm.getEntries());
  });

  test("reset() clears all entries and leafId", () => {
    const sm = new FakeSessionManager();
    sm.addEntry({ type: "x", id: "a" });
    sm.reset();
    assert.equal(sm.getEntries().length, 0);
    assert.equal(sm.getLeafId(), null);
  });

  test("getEntries() returns a copy — mutations don't affect internal state", () => {
    const sm = new FakeSessionManager();
    sm.addEntry({ type: "x", id: "a" });
    const entries = sm.getEntries();
    entries.push({ type: "injected" });

    assert.equal(sm.getEntries().length, 1, "internal state unchanged");
  });
});

// ---------------------------------------------------------------------------
// scenarios self-tests — verify events reach registered listeners
// ---------------------------------------------------------------------------

describe("scenarios — event delivery", () => {
  test("basicSession emits all expected event types", async () => {
    const api = new FakeExtensionAPI();
    const seen = new Set<string>();
    const EXPECTED = [
      "session_start",
      "input",
      "before_agent_start",
      "turn_start",
      "after_provider_response",
      "tool_execution_start",
      "tool_call",
      "tool_result",
      "tool_execution_end",
      "message_end",
      "turn_end",
      "session_shutdown",
    ];

    for (const evt of EXPECTED) {
      api.on(evt, () => { seen.add(evt); });
    }

    await scenarios.basicSession(api);

    for (const evt of EXPECTED) {
      assert.ok(seen.has(evt), `expected ${evt} to be emitted`);
    }
  });

  test("basicSession: tool_result carries isError=false and tool path", async () => {
    const api = new FakeExtensionAPI();
    let toolResultPayload: unknown;

    api.on("tool_result", (event) => { toolResultPayload = event; });

    await scenarios.basicSession(api);

    assert.ok(toolResultPayload != null);
    const p = toolResultPayload as {
      toolName: string;
      isError: boolean;
      input: { path: string };
    };
    assert.equal(p.toolName, "read");
    assert.equal(p.isError, false);
    assert.ok(p.input.path.endsWith("README.md"));
  });

  test("multiTurnWithToolError emits exactly two turn_start events", async () => {
    const api = new FakeExtensionAPI();
    let turnCount = 0;
    api.on("turn_start", () => { turnCount++; });

    await scenarios.multiTurnWithToolError(api);

    assert.equal(turnCount, 2);
  });

  test("multiTurnWithToolError: first tool call has isError=true, second false", async () => {
    const api = new FakeExtensionAPI();
    const errorFlags: boolean[] = [];

    api.on("tool_result", (event) => {
      const e = event as { isError: boolean };
      errorFlags.push(e.isError);
    });

    await scenarios.multiTurnWithToolError(api);

    assert.deepEqual(errorFlags, [true, false]);
  });

  test("bashCommitPushPr: only bash tool calls are emitted", async () => {
    const api = new FakeExtensionAPI();
    const toolNames: string[] = [];

    api.on("tool_call", (event) => {
      const e = event as { toolName: string };
      toolNames.push(e.toolName);
    });

    await scenarios.bashCommitPushPr(api);

    assert.ok(toolNames.length >= 1, "at least one tool call");
    assert.ok(toolNames.every((n) => n === "bash"), "all tool calls are bash");
  });

  test("bashCommitPushPr: bash command contains git commit, push, and gh pr create", async () => {
    const api = new FakeExtensionAPI();
    let cmd = "";

    api.on("tool_call", (event) => {
      const e = event as { toolName: string; input: { command?: string } };
      if (e.toolName === "bash") cmd = e.input.command ?? "";
    });

    await scenarios.bashCommitPushPr(api);

    assert.ok(cmd.includes("git commit"), "contains git commit");
    assert.ok(cmd.includes("git push"), "contains git push");
    assert.ok(cmd.includes("gh pr create"), "contains gh pr create");
  });

  test("sessionFork emits session_start with reason 'startup' then 'fork'", async () => {
    const api = new FakeExtensionAPI();
    const startReasons: string[] = [];

    api.on("session_start", (event) => {
      const e = event as { reason: string };
      startReasons.push(e.reason);
    });

    const { parentFile, forkFile } = await scenarios.sessionFork(api);

    assert.deepEqual(startReasons, ["startup", "fork"]);
    assert.ok(typeof parentFile === "string" && parentFile.length > 0);
    assert.ok(typeof forkFile === "string" && forkFile.length > 0);
    assert.notEqual(parentFile, forkFile);
  });

  test("sessionFork: fork session_start carries previousSessionFile", async () => {
    const api = new FakeExtensionAPI();
    let forkPayload: unknown;

    api.on("session_start", (event) => {
      const e = event as { reason: string };
      if (e.reason === "fork") forkPayload = event;
    });

    const { parentFile } = await scenarios.sessionFork(api);

    const p = forkPayload as { reason: string; previousSessionFile: string };
    assert.equal(p.previousSessionFile, parentFile);
  });

  test("privacyModes: input event carries the secret text verbatim", async () => {
    const api = new FakeExtensionAPI();
    let inputText = "";

    api.on("input", (event) => {
      const e = event as { text: string };
      inputText = e.text;
    });

    await scenarios.privacyModes(api, "full");

    assert.ok(
      inputText.includes("api_key=secret123"),
      "raw secret is present in input event payload",
    );
  });

  test("branchSwitchMidSession emits exactly two turn_start events", async () => {
    const api = new FakeExtensionAPI();
    let turnCount = 0;
    api.on("turn_start", () => { turnCount++; });

    await scenarios.branchSwitchMidSession(api);

    assert.equal(turnCount, 2);
  });

  test("branchSwitchMidSession: bash commands include checkout and commit+push", async () => {
    const api = new FakeExtensionAPI();
    const cmds: string[] = [];

    api.on("tool_call", (event) => {
      const e = event as { toolName: string; input: { command?: string } };
      if (e.toolName === "bash" && e.input.command) cmds.push(e.input.command);
    });

    await scenarios.branchSwitchMidSession(api);

    assert.ok(cmds.some((c) => c.includes("git checkout")), "checkout present");
    assert.ok(cmds.some((c) => c.includes("git commit")), "commit present");
    assert.ok(cmds.some((c) => c.includes("git push")), "push present");
  });

  test("session_shutdown reason is preserved for each scenario", async () => {
    // Verify scenarios don't swallow or mutate the reason field.
    const api = new FakeExtensionAPI();
    const shutdownReasons: string[] = [];
    api.on("session_shutdown", (event) => {
      const e = event as { reason: string };
      shutdownReasons.push(e.reason);
    });

    await scenarios.basicSession(api);
    await scenarios.multiTurnWithToolError(api);

    assert.deepEqual(shutdownReasons, ["quit", "quit"]);
  });
});
