/**
 * ndjson.test.ts — Tests for NdjsonSink.
 *
 * Covers:
 *  - rawLogDir creation on init
 *  - One JSON line per event, correct filename format
 *  - Prompt privacy modes: "hashed" / "none" strip text; "full" keeps and scrubs it
 *  - Redacted counter is non-empty when rules fire; absent/zero when they don't
 *  - api_key=secret123 scrubbed end-to-end via user pattern
 *  - GitHub PAT scrubbed via DEFAULT_RULES in "full" mode
 *  - Non-prompt events are walkAndRedact'd and written correctly
 *  - flush / close are safe no-ops
 *  - Day rollover: filename is YYYY-MM-DD format
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NdjsonSink } from "./ndjson.ts";
import type {
  AnalyticsConfig,
  PromptEvent,
  SessionStartEvent,
  ToolCallEvent,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an AnalyticsConfig with sensible defaults, allowing per-test privacy
 * overrides.
 */
function makeConfig(
  rawLogDir: string,
  privacy: Partial<AnalyticsConfig["privacy"]> = {},
): AnalyticsConfig {
  return {
    local: { enabled: true, dbPath: ":memory:", rawLogDir },
    privacy: {
      storePrompts: "hashed",
      storeToolArgs: "summary",
      storeToolOutputs: "size-only",
      // User pattern to catch api_key=<value> in tests.
      // Compiled to /api_key=\S+/g; replacement: [REDACTED:user:api_key=\S+]
      redactPatterns: ["api_key=\\S+"],
      ...privacy,
    },
    git: { enabled: false, fetchPR: false, ghTimeoutMs: 2000 },
  };
}

/**
 * Build a PromptEvent.  `text_len` and `text_sha256` are pre-populated as
 * a hook would do them; `text` is optional (only present when the hook
 * includes raw content).
 */
function makePromptEvent(text?: string): PromptEvent {
  return {
    kind: "prompt",
    ts: Date.now(),
    id: crypto.randomUUID(),
    session_id: "sess-test-1",
    source: "user",
    command: null,
    slash_kind: null,
    text_len: text?.length ?? 30,
    text_sha256: "cafebabe00000000000000000000000000000000000000000000000000000000",
    image_count: 0,
    ...(text !== undefined ? { text } : {}),
  };
}

/**
 * Read and parse every JSON line from today's NDJSON file in `dir`.
 */
function readEvents(dir: string): unknown[] {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const file = path.join(dir, `events-${yyyy}-${mm}-${dd}.ndjson`);
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("NdjsonSink - creates rawLogDir (including nested) on init", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ndjson-mkdir-"));
  const rawLogDir = path.join(base, "nested", "raw");
  try {
    const sink = new NdjsonSink();
    await sink.init(makeConfig(rawLogDir));
    assert.ok(fs.existsSync(rawLogDir), "rawLogDir must exist after init");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("NdjsonSink - writes one JSON line per event", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ndjson-lines-"));
  try {
    const sink = new NdjsonSink();
    await sink.init(makeConfig(dir));
    sink.write(makePromptEvent());
    sink.write(makePromptEvent());
    sink.write(makePromptEvent());
    await sink.close();

    const events = readEvents(dir);
    assert.equal(events.length, 3, "three events expected");
    for (const ev of events) {
      assert.equal((ev as { kind: string }).kind, "prompt");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("NdjsonSink - filename matches events-YYYY-MM-DD.ndjson", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ndjson-fname-"));
  try {
    const sink = new NdjsonSink();
    await sink.init(makeConfig(dir));
    sink.write(makePromptEvent());
    await sink.close();

    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1, "exactly one file produced");
    assert.match(
      files[0]!,
      /^events-\d{4}-\d{2}-\d{2}\.ndjson$/,
      "filename must be events-YYYY-MM-DD.ndjson",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Prompt privacy modes ─────────────────────────────────────────────────────

test("NdjsonSink - prompt privacy 'hashed': text absent, sha256 preserved", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ndjson-hashed-"));
  try {
    const sink = new NdjsonSink();
    await sink.init(makeConfig(dir, { storePrompts: "hashed" }));
    // Hook includes the raw text — sink must strip it.
    sink.write(makePromptEvent("hello api_key=secret123 world"));
    await sink.close();

    const [ev] = readEvents(dir) as [Record<string, unknown>];
    assert.equal(ev["kind"], "prompt");
    assert.ok(!("text" in ev), "hashed mode: text field must be absent");
    assert.ok(
      typeof ev["text_sha256"] === "string" && ev["text_sha256"].length > 0,
      "hashed mode: text_sha256 must be preserved",
    );
    // Secret must not appear anywhere in the serialized event.
    assert.ok(
      !JSON.stringify(ev).includes("secret123"),
      "hashed mode: secret must not leak",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("NdjsonSink - prompt privacy 'none': text absent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ndjson-none-"));
  try {
    const sink = new NdjsonSink();
    await sink.init(makeConfig(dir, { storePrompts: "none" }));
    sink.write(makePromptEvent("sensitive api_key=topsecret123 data"));
    await sink.close();

    const [ev] = readEvents(dir) as [Record<string, unknown>];
    assert.ok(!("text" in ev), "none mode: text field must be absent");
    assert.ok(
      !JSON.stringify(ev).includes("topsecret123"),
      "none mode: secret must not leak",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("NdjsonSink - prompt privacy 'full': text present, api_key=secret123 scrubbed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ndjson-full-"));
  try {
    const sink = new NdjsonSink();
    await sink.init(makeConfig(dir, { storePrompts: "full" }));
    sink.write(makePromptEvent("hello api_key=secret123 world"));
    await sink.close();

    const [ev] = readEvents(dir) as [Record<string, unknown>];
    assert.ok("text" in ev, "full mode: text field must be present");
    assert.ok(
      typeof ev["text"] === "string" && (ev["text"] as string).includes("hello"),
      "full mode: non-secret content is preserved",
    );
    assert.ok(
      !(ev["text"] as string).includes("secret123"),
      "full mode: secret value must be scrubbed",
    );
    assert.ok(
      (ev["text"] as string).includes("[REDACTED"),
      "full mode: REDACTED placeholder must be present",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Redacted counter ─────────────────────────────────────────────────────────

test("NdjsonSink - redacted counter is non-empty when a rule fires", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ndjson-counter-"));
  try {
    const sink = new NdjsonSink();
    await sink.init(makeConfig(dir, { storePrompts: "full" }));
    // User pattern "api_key=\\S+" will match "api_key=secret123".
    sink.write(makePromptEvent("use api_key=secret123 in tests"));
    await sink.close();

    const [ev] = readEvents(dir) as [Record<string, unknown>];
    assert.ok(
      ev["redacted"] !== undefined && ev["redacted"] !== null,
      "redacted field must be present",
    );
    const hits = ev["redacted"] as Record<string, number>;
    const total = Object.values(hits).reduce((a, b) => a + b, 0);
    assert.ok(total > 0, `redacted counter must be > 0, got ${total}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("NdjsonSink - redacted counter absent/zero when no rule fires", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ndjson-nofire-"));
  try {
    const sink = new NdjsonSink();
    // No user patterns; default rules won't fire on benign text.
    await sink.init(
      makeConfig(dir, {
        storePrompts: "full",
        redactPatterns: [],
      }),
    );
    sink.write(makePromptEvent("hello world no secrets here at all"));
    await sink.close();

    const [ev] = readEvents(dir) as [Record<string, unknown>];
    // Either no `redacted` field at all, or an empty / zero-valued object.
    if (ev["redacted"] !== undefined) {
      const hits = ev["redacted"] as Record<string, number>;
      const total = Object.values(hits).reduce((a, b) => a + b, 0);
      assert.equal(total, 0, "no hits expected for benign text");
    }
    // Non-secret text is preserved.
    assert.ok(
      typeof ev["text"] === "string" && (ev["text"] as string).includes("hello world"),
      "clean text must be preserved",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── DEFAULT_RULES integration ─────────────────────────────────────────────────

test("NdjsonSink - GitHub PAT scrubbed via DEFAULT_RULES in 'full' mode", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ndjson-ghpat-"));
  try {
    const sink = new NdjsonSink();
    // No user patterns; relies on DEFAULT_RULES github-token rule.
    await sink.init(
      makeConfig(dir, {
        storePrompts: "full",
        redactPatterns: [],
      }),
    );
    // 40-char suffix satisfies the rule's ≥36-char requirement.
    const fakeToken = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    sink.write(makePromptEvent(`Use token ${fakeToken} to authenticate`));
    await sink.close();

    const [ev] = readEvents(dir) as [Record<string, unknown>];
    const text = ev["text"] as string;
    assert.ok(!text.includes(fakeToken), "github PAT must be scrubbed");
    assert.ok(text.includes("[REDACTED"), "REDACTED placeholder must be present");

    const hits = (ev["redacted"] ?? {}) as Record<string, number>;
    assert.ok(
      (hits["github-token"] ?? 0) >= 1,
      "github-token rule must have fired",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Non-prompt event types ────────────────────────────────────────────────────

test("NdjsonSink - session_start event written with all fields intact", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ndjson-session-"));
  try {
    const sink = new NdjsonSink();
    await sink.init(makeConfig(dir));

    const sessionEv: SessionStartEvent = {
      kind: "session_start",
      ts: 1000,
      id: "s1",
      parent_session_id: null,
      parent_session_file: null,
      started_at: 1000,
      cwd: "/home/user/project",
      pi_version: "1.2.3",
      hostname: "myhost",
      repo_root: "/home/user/project",
      repo_remote: "https://github.com/user/repo",
      repo_owner: "user",
      repo_name: "repo",
      branch_start: "main",
      head_sha_start: "abc123",
      dirty_at_start: 0,
    };
    sink.write(sessionEv);
    await sink.close();

    const [ev] = readEvents(dir) as [Record<string, unknown>];
    assert.equal(ev["kind"], "session_start");
    assert.equal(ev["id"], "s1");
    assert.equal(ev["repo_remote"], "https://github.com/user/repo");
    assert.equal(ev["branch_start"], "main");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("NdjsonSink - tool_call event written; universal rules applied", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ndjson-toolcall-"));
  try {
    const sink = new NdjsonSink();
    await sink.init(makeConfig(dir));

    const toolEv: ToolCallEvent = {
      kind: "tool_call",
      ts: 2000,
      id: "tc1",
      turn_id: "turn1",
      session_id: "sess1",
      tool_call_id: "tci-1",
      name: "read",
      started_at: 2000,
      ended_at: 2100,
      duration_ms: 100,
      is_error: false,
      input_bytes: 42,
      output_bytes: 512,
      error_kind: null,
    };
    sink.write(toolEv);
    await sink.close();

    const [ev] = readEvents(dir) as [Record<string, unknown>];
    assert.equal(ev["kind"], "tool_call");
    assert.equal(ev["name"], "read");
    assert.equal(ev["duration_ms"], 100);
    assert.equal(ev["is_error"], false);
    assert.equal(ev["output_bytes"], 512);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── No-op operations ──────────────────────────────────────────────────────────

test("NdjsonSink - flush and close are safe no-ops (may be called multiple times)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ndjson-noop-"));
  try {
    const sink = new NdjsonSink();
    await sink.init(makeConfig(dir));
    await sink.flush();
    await sink.close();
    // Second calls after close must also be safe.
    await sink.flush();
    await sink.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Privacy: prompt without text field ──────────────────────────────────────

test("NdjsonSink - prompt event without text field is written unchanged (hashed mode)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ndjson-notext-"));
  try {
    const sink = new NdjsonSink();
    await sink.init(makeConfig(dir, { storePrompts: "hashed" }));
    // Emitting an event with no `text` (hook chose not to include it).
    sink.write(makePromptEvent()); // no text arg
    await sink.close();

    const [ev] = readEvents(dir) as [Record<string, unknown>];
    assert.equal(ev["kind"], "prompt");
    assert.ok(!("text" in ev), "no text field expected");
    assert.ok(typeof ev["text_sha256"] === "string");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("NdjsonSink - prompt event without text field in 'full' mode still written", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ndjson-notext-full-"));
  try {
    const sink = new NdjsonSink();
    await sink.init(makeConfig(dir, { storePrompts: "full" }));
    // Hook chose not to include text (edge case).
    sink.write(makePromptEvent()); // no text
    await sink.close();

    const [ev] = readEvents(dir) as [Record<string, unknown>];
    assert.equal(ev["kind"], "prompt");
    // text absent is fine — we don't inject a text field
    assert.ok(!("text" in ev) || typeof ev["text"] === "string");
    assert.equal(ev["text_sha256"], "cafebabe00000000000000000000000000000000000000000000000000000000");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
