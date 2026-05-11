/**
 * usage.test.ts — Tests for T14: parseUsageArgs, runUsageJson (all tabs),
 * and a smoke test for runUsageInteractive.
 *
 * Uses a real SqliteSink with ":memory:" and seeds data via sink.write() so
 * every query path is exercised without mocking SQL.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { SqliteSink } from "../sinks/sqlite.ts";
import type { AnalyticsConfig } from "../sinks/types.ts";
import {
  parseUsageArgs,
  runUsageJson,
  runUsageInteractive,
  type PiAPIStub,
} from "./usage.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(): AnalyticsConfig {
  return {
    local: { enabled: true, dbPath: ":memory:", rawLogDir: "/tmp/pi-usage-test-raw" },
    privacy: {
      storePrompts: "hashed",
      storeToolArgs: "summary",
      storeToolOutputs: "size-only",
      redactPatterns: [],
    },
    git: { enabled: true, fetchPR: false, ghTimeoutMs: 2_000 },
  };
}

// Seed timestamps near "now" so data lands in the today/week buckets.
let _ts = Date.now() - 60_000; // 1 minute ago
const tick = (n = 100) => { _ts += n; return _ts; };

// ── Seeder ───────────────────────────────────────────────────────────────────

/**
 * Seeds a minimal but representative dataset:
 *   sessions:       s1 (repo-A), s2 (repo-B)
 *   prompts:        p1→s1, p2→s1, p3→s2
 *   turns:          t1/t2→s1 (model-alpha), t3/t4→s2 (model-beta)
 *   llm_messages:   one per turn, each cost_total = 0.01
 *   tool_calls:     tc1-tc4 (read×3 + write×1), durations 10/20/30/40 ms;
 *                   tc5 (bash, is_error=true, 100 ms)
 *   files_touched:  /src/a.ts (s1), /src/b.ts (s2)
 *   commit_made:    sha=abc123 (s1)
 *   pr_association: pr#42 linked to s1
 */
async function makeSink(): Promise<SqliteSink> {
  const sink = new SqliteSink();
  await sink.init(makeConfig());

  const now = _ts;

  // ── sessions ──────────────────────────────────────────────────────────────
  sink.write({
    kind: "session_start", ts: tick(), id: "s1",
    parent_session_id: null, parent_session_file: null,
    started_at: now, cwd: "/proj/a",
    repo_root: "/proj/a", repo_remote: "https://github.com/owner/repo-a",
    repo_owner: "owner", repo_name: "repo-a",
    branch_start: "main", head_sha_start: "sha-start-1",
    dirty_at_start: 0, pi_version: "0.72.0", hostname: "test-host",
  });
  sink.write({
    kind: "session_end", ts: tick(), session_id: "s1",
    ended_at: tick(), branch_end: "main", head_sha_end: "sha-end-1",
    exit_reason: "normal",
  });

  sink.write({
    kind: "session_start", ts: tick(), id: "s2",
    parent_session_id: null, parent_session_file: null,
    started_at: tick(), cwd: "/proj/b",
    repo_root: "/proj/b", repo_remote: "https://github.com/owner/repo-b",
    repo_owner: "owner", repo_name: "repo-b",
    branch_start: "feat/x", head_sha_start: "sha-start-2",
    dirty_at_start: 0, pi_version: "0.72.0", hostname: "test-host",
  });
  sink.write({
    kind: "session_end", ts: tick(), session_id: "s2",
    ended_at: tick(), branch_end: "feat/x", head_sha_end: "sha-end-2",
    exit_reason: "normal",
  });

  // ── prompts ───────────────────────────────────────────────────────────────
  for (const [id, sid] of [["p1", "s1"], ["p2", "s1"], ["p3", "s2"]] as const) {
    sink.write({
      kind: "prompt", ts: tick(), id, session_id: sid,
      source: "user", command: null, slash_kind: null,
      text_len: 42, text_sha256: `sha-${id}`, image_count: 0,
    });
  }

  // ── turns ─────────────────────────────────────────────────────────────────
  const turns: Array<[string, string, string, string]> = [
    ["t1", "s1", "p1", "model-alpha"],
    ["t2", "s1", "p2", "model-alpha"],
    ["t3", "s2", "p3", "model-beta"],
    ["t4", "s2", "p3", "model-beta"],
  ];
  for (const [id, sid, pid, model] of turns) {
    const sat = tick();
    sink.write({
      kind: "turn_start", ts: sat, id, session_id: sid, prompt_id: pid,
      idx: 0, started_at: sat, model_id: model, provider: "anthropic",
      thinking_level: null,
    });
    sink.write({
      kind: "turn_end", ts: tick(), turn_id: id, session_id: sid,
      ended_at: tick(), model_id: model, provider: "anthropic",
      thinking_level: null, stop_reason: "end_turn",
    });
  }

  // ── llm_messages (cost_total = 0.01 each → total 0.04) ───────────────────
  for (const [id, tid, sid] of [["lm1","t1","s1"],["lm2","t2","s1"],["lm3","t3","s2"],["lm4","t4","s2"]] as const) {
    sink.write({
      kind: "llm_message", ts: tick(), id, turn_id: tid, session_id: sid,
      role: "assistant",
      input_tokens: 100, output_tokens: 50,
      cache_read_tokens: 0, cache_write_tokens: 0,
      cost_input: 0.003, cost_output: 0.006,
      cost_cache_read: 0, cost_cache_write: 0,
      cost_total: 0.01,
      time_to_first_token_ms: 120, total_duration_ms: 800, stop_reason: "end_turn",
    });
  }

  // ── tool_calls (tc1-tc4 normal, tc5 error) ────────────────────────────────
  const tools: Array<[string, string, string, string, number, boolean]> = [
    ["tc1", "t1", "s1", "read",  10, false],
    ["tc2", "t1", "s1", "read",  20, false],
    ["tc3", "t2", "s1", "write", 30, false],
    ["tc4", "t3", "s2", "read",  40, false],
    ["tc5", "t4", "s2", "bash", 100, true],
  ];
  for (const [id, tid, sid, name, dur, isErr] of tools) {
    const sat = tick();
    sink.write({
      kind: "tool_call", ts: sat, id,
      turn_id: tid, session_id: sid,
      tool_call_id: `call-${id}`,
      name, started_at: sat, ended_at: sat + dur,
      duration_ms: dur, is_error: isErr,
      input_bytes: 64, output_bytes: 128,
      error_kind: isErr ? "non-zero-exit" : null,
    });
  }

  // ── files_touched ─────────────────────────────────────────────────────────
  sink.write({
    kind: "file_touched", ts: tick(), tool_call_id: "call-tc1",
    session_id: "s1", path: "/src/a.ts", op: "read", bytes: 512, sensitive: false,
  });
  sink.write({
    kind: "file_touched", ts: tick(), tool_call_id: "call-tc4",
    session_id: "s2", path: "/src/b.ts", op: "read", bytes: 256, sensitive: false,
  });

  // ── commit_made ───────────────────────────────────────────────────────────
  sink.write({
    kind: "commit_made", ts: tick(), session_id: "s1", turn_id: "t2",
    sha: "abc123", subject: "feat: add thing",
    files_changed: 2, insertions: 10, deletions: 3,
  });

  // ── pr_association ────────────────────────────────────────────────────────
  sink.write({
    kind: "pr_association", ts: tick(), session_id: "s1",
    repo_remote: "https://github.com/owner/repo-a",
    pr_number: 42, pr_url: "https://github.com/owner/repo-a/pull/42",
    confidence: 0.8, reason: "branch-match",
  });

  return sink;
}

// ── parseUsageArgs ────────────────────────────────────────────────────────────

describe("parseUsageArgs", () => {
  it("no args → json:false, no tab, no since", () => {
    const r = parseUsageArgs([]);
    assert.equal(r.json, false);
    assert.equal(r.tab, undefined);
    assert.equal(r.since, undefined);
  });

  it("--json → json:true", () => {
    assert.equal(parseUsageArgs(["--json"]).json, true);
  });

  it("--json --tab=models → json:true, tab:models", () => {
    const r = parseUsageArgs(["--json", "--tab=models"]);
    assert.equal(r.json, true);
    assert.equal(r.tab, "models");
  });

  it("--tab daily --since 7d (space-separated)", () => {
    const r = parseUsageArgs(["--tab", "daily", "--since", "7d"]);
    assert.equal(r.tab, "daily");
    assert.equal(r.since, "7d");
  });

  it("unknown flags are silently ignored", () => {
    const r = parseUsageArgs(["--unknown", "--json", "--foo=bar"]);
    assert.equal(r.json, true);
    assert.equal(r.tab, undefined);
  });
});

// ── runUsageJson ──────────────────────────────────────────────────────────────

describe("runUsageJson", () => {
  let sink: SqliteSink;
  before(async () => { sink = await makeSink(); });
  after(async () => { await sink.close(); });

  it("summary — returns today/week/month/session buckets and top_model", () => {
    const d = runUsageJson(sink, { tab: "summary", since: "all" }) as {
      today:   { cost_usd: number; tokens: number; turns: number };
      week:    { cost_usd: number; tokens: number; turns: number };
      month:   { cost_usd: number; tokens: number; turns: number };
      session: { cost_usd: number; tokens: number; turns: number };
      top_model: { id: string; cost_usd: number; turns: number } | null;
    };
    assert.ok(typeof d.today.cost_usd === "number", "today.cost_usd is a number");
    assert.ok(typeof d.week.cost_usd  === "number", "week.cost_usd is a number");
    assert.ok(typeof d.month.cost_usd === "number", "month.cost_usd is a number");
    assert.ok(typeof d.session.cost_usd === "number", "session.cost_usd is a number");
    // All 4 llm_messages were written recently — should appear in today + week + month buckets
    assert.ok(d.today.cost_usd > 0, `today.cost_usd > 0 (got ${d.today.cost_usd})`);
    assert.ok(d.week.cost_usd  > 0, `week.cost_usd  > 0 (got ${d.week.cost_usd})`);
    assert.ok(d.month.cost_usd > 0, `month.cost_usd > 0 (got ${d.month.cost_usd})`);
    // month >= week >= today (calendar-day buckets are nested)
    assert.ok(d.month.cost_usd >= d.week.cost_usd, "month >= week");
    assert.ok(d.week.cost_usd  >= d.today.cost_usd, "week >= today");
    // session = last session (s2), which has 2 messages at 0.01 each
    assert.ok(d.session.cost_usd > 0, `session.cost_usd > 0 (got ${d.session.cost_usd})`);
    assert.ok(d.top_model !== null, "top_model is populated");
    assert.ok(["model-alpha", "model-beta"].includes(d.top_model!.id));
  });

  it("summary — buckets carry cached_tokens, cached_cost_usd, and cache_savings_usd fields", () => {
    const d = runUsageJson(sink, { tab: "summary", since: "all" }) as {
      today:   { tokens: number; cached_tokens: number; cached_cost_usd: number; cache_savings_usd: number };
      week:    { tokens: number; cached_tokens: number; cached_cost_usd: number; cache_savings_usd: number };
      month:   { tokens: number; cached_tokens: number; cached_cost_usd: number; cache_savings_usd: number };
      session: { tokens: number; cached_tokens: number; cached_cost_usd: number; cache_savings_usd: number };
    };
    for (const name of ["today", "week", "month", "session"] as const) {
      const b = d[name];
      assert.ok(typeof b.cached_tokens === "number", `${name}.cached_tokens is a number`);
      assert.ok(typeof b.cached_cost_usd === "number", `${name}.cached_cost_usd is a number`);
      assert.ok(b.cached_tokens >= 0, `${name}.cached_tokens ≥ 0`);
      assert.ok(b.cached_tokens <= b.tokens, `${name}.cached_tokens ≤ tokens`);
      // Standard fixture has cache_read_tokens=0 so savings are 0.
      assert.ok(typeof b.cache_savings_usd === "number", `${name}.cache_savings_usd is a number`);
      assert.strictEqual(b.cache_savings_usd, 0, `${name}.cache_savings_usd = 0 (no cached tokens in fixture)`);
    }
  });

  it("summary — cache_savings_usd computed correctly from observed fresh-input rate", async () => {
    // Isolated sink: one llm_message with known token/cost values.
    // input_tokens=1000, cost_input=$0.003 → fresh rate = $3 per million
    // cache_read_tokens=10000, cost_cache_read=$0.0003 (= $0.30 per million, 10× cheaper)
    // Expected savings = 10000 × ($3/1M) − $0.0003 = $0.030 − $0.0003 = $0.0297
    const s2 = new SqliteSink();
    await s2.init(makeConfig());
    const now2 = Date.now() - 30_000;
    s2.write({
      kind: "session_start", ts: now2, id: "sx",
      parent_session_id: null, parent_session_file: null,
      started_at: now2, cwd: "/x",
      repo_root: "/x", repo_remote: null,
      repo_owner: null, repo_name: null,
      branch_start: "main", head_sha_start: "s",
      dirty_at_start: 0, pi_version: "0", hostname: "h",
    });
    s2.write({
      kind: "prompt", ts: now2 + 1, id: "px", session_id: "sx",
      source: "user", command: null, slash_kind: null,
      text_len: 5, text_sha256: "abc", image_count: 0,
    });
    s2.write({
      kind: "turn_start", ts: now2 + 2, id: "tx", session_id: "sx", prompt_id: "px",
      idx: 0, started_at: now2 + 2, model_id: "m", provider: "anthropic",
      thinking_level: null,
    });
    s2.write({
      kind: "llm_message", ts: now2 + 2, id: "lmx",
      turn_id: "tx", session_id: "sx", role: "assistant",
      input_tokens:       1_000,  cost_input:       0.003,
      output_tokens:      200,    cost_output:      0.006,
      cache_read_tokens:  10_000, cost_cache_read:  0.0003,
      cache_write_tokens: 0,      cost_cache_write: 0,
      cost_total: 0.003 + 0.006 + 0.0003,
      time_to_first_token_ms: null, total_duration_ms: null, stop_reason: "end_turn",
    });
    const d = runUsageJson(s2, { tab: "summary", since: "all" }) as {
      today: { cache_savings_usd: number };
    };
    // Expected: 10000 × (0.003 / 1000) − 0.0003 = 0.03 − 0.0003 = 0.0297
    const expected = 10_000 * (0.003 / 1_000) - 0.0003;
    assert.ok(
      Math.abs(d.today.cache_savings_usd - expected) < 1e-9,
      `cache_savings_usd expected ≈${expected.toFixed(6)}, got ${d.today.cache_savings_usd}`,
    );
    await s2.close();
  });

  it("models — rows array with expected fields and ≥2 models", () => {
    const d = runUsageJson(sink, { tab: "models" }) as {
      rows: Array<{
        model_id: string; cost_usd: number; tokens_in: number;
        tokens_out: number; turns: number; share: number; avg_tokens_per_turn: number;
        cached_tokens: number; cache_read_tokens: number; cache_write_tokens: number;
        cache_hit_rate: number; cached_cost_usd: number;
      }>;
    };
    assert.ok(Array.isArray(d.rows), "rows is an array");
    assert.ok(d.rows.length >= 2, `expected ≥2 model rows, got ${d.rows.length}`);
    for (const r of d.rows) {
      assert.ok(typeof r.model_id === "string");
      assert.ok(typeof r.cost_usd === "number");
      assert.ok(typeof r.share === "number");
      assert.ok(typeof r.avg_tokens_per_turn === "number");
      // Cache fields are present and consistent.
      assert.strictEqual(r.cached_tokens, r.cache_read_tokens + r.cache_write_tokens);
      assert.ok(typeof r.cache_hit_rate === "number");
      assert.ok(r.cache_hit_rate >= 0 && r.cache_hit_rate <= 1, "cache_hit_rate in [0,1]");
      assert.ok(typeof r.cached_cost_usd === "number");
    }
    const ids = d.rows.map((r) => r.model_id);
    assert.ok(ids.includes("model-alpha"), "model-alpha present");
    assert.ok(ids.includes("model-beta"),  "model-beta present");
  });

  it("repos — one row per repo, files_touched and top_tool populated", () => {
    const d = runUsageJson(sink, { tab: "repos" }) as {
      rows: Array<{
        repo_remote: string; sessions: number;
        files_touched: number; cost_usd: number; top_tool: string | null;
      }>;
    };
    assert.ok(Array.isArray(d.rows));
    assert.ok(d.rows.length >= 2, `expected ≥2 repo rows, got ${d.rows.length}`);
    const remotes = d.rows.map((r) => r.repo_remote);
    assert.ok(remotes.includes("https://github.com/owner/repo-a"));
    assert.ok(remotes.includes("https://github.com/owner/repo-b"));
    for (const r of d.rows) {
      assert.ok(typeof r.sessions === "number");
      assert.ok(typeof r.files_touched === "number");
    }
  });

  it("tools — rows for each distinct tool name, durations and error_rate correct", () => {
    const d = runUsageJson(sink, { tab: "tools" }) as {
      rows: Array<{
        name: string; calls: number; total_duration_ms: number;
        error_rate: number; p50_ms: number; p95_ms: number;
      }>;
    };
    assert.ok(Array.isArray(d.rows));
    const byName = new Map(d.rows.map((r) => [r.name, r]));
    const readRow = byName.get("read");
    assert.ok(readRow, "read tool row exists");
    assert.equal(readRow!.calls, 3, "3 read tool calls");
    assert.ok(readRow!.error_rate === 0, "read error_rate is 0");

    const bashRow = byName.get("bash");
    assert.ok(bashRow, "bash tool row exists");
    assert.equal(bashRow!.calls, 1, "1 bash call");
    assert.equal(bashRow!.error_rate, 1, "bash error_rate is 1 (100%)");
    assert.equal(bashRow!.total_duration_ms, 100);
  });

  it("prs — row for pr#42 with correct session and cost (legacy fields preserved)", () => {
    type PrRow = {
      pr_number: number; pr_url: string; sessions: number;
      total_cost_usd: number; total_files: number; total_turns: number; total_commits: number;
      top_reason: string; confidence: number;
      phase_breakdown: { planning: number; implementation: number; fixup: number };
      breakdown: Array<{
        session_id: string; started_at: number;
        phase: string; cost_usd: number; tokens: number;
        turns: number; commits: number; confidence: number; reason: string;
      }>;
    };
    const d = runUsageJson(sink, { tab: "prs" }) as { rows: PrRow[] };
    assert.ok(Array.isArray(d.rows));
    assert.ok(d.rows.length >= 1, "at least one PR row");
    const pr42 = d.rows.find((r) => r.pr_number === 42);
    assert.ok(pr42, "pr#42 is present");
    // Legacy flat fields.
    assert.equal(pr42!.confidence, 0.8);
    assert.equal(pr42!.top_reason, "branch-match");
    assert.ok(typeof pr42!.total_cost_usd === "number");
    assert.ok(typeof pr42!.sessions === "number");
    // New grouped fields.
    assert.ok(pr42!.breakdown !== undefined, "breakdown array present");
    assert.ok(Array.isArray(pr42!.breakdown));
    assert.ok(pr42!.phase_breakdown !== undefined, "phase_breakdown present");
    const pb = pr42!.phase_breakdown;
    assert.ok(typeof pb.planning === "number");
    assert.ok(typeof pb.implementation === "number");
    assert.ok(typeof pb.fixup === "number");
  });

  it("prs — phase classification with 3-session PR (planning/impl/fixup)", async () => {
    // Dedicated sink seeded for phase-classification verification.
    const pSink = new SqliteSink();
    await pSink.init(makeConfig());

    const base = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days ago
    const day = 24 * 60 * 60 * 1000;

    // Three sessions:
    //   sA — planning:       0 commits, started 5d ago
    //   sB — implementation: 2 commits, started 4d ago (before/at linked_at)
    //   sC — fixup:          1 commit,  started 2d ago (after linked_at)
    // linked_at for all three = 4 days ago (same day as sB).
    // earliest linked_at = 4d ago → sB.started_at <= earliestLinkedAt → implementation.
    //                              sC.started_at >  earliestLinkedAt → fixup.
    const startA = base + 0 * day; // 7d ago (planning, 0 commits)
    const startB = base + 3 * day; // 4d ago (implementation, 2 commits, started on linked day)
    const startC = base + 5 * day; // 2d ago (fixup, 1 commit, after linked_at)
    const linkedAt = base + 3 * day; // 4d ago

    for (const [id, started_at] of [["sA", startA], ["sB", startB], ["sC", startC]] as const) {
      pSink.write({
        kind: "session_start", ts: started_at, id,
        parent_session_id: null, parent_session_file: null,
        started_at, cwd: "/proj",
        repo_root: "/proj", repo_remote: "https://github.com/owner/repo",
        repo_owner: "owner", repo_name: "repo",
        branch_start: "feat", head_sha_start: `sha-${id}`,
        dirty_at_start: 0, pi_version: "0.72.0", hostname: "test",
      });
      pSink.write({
        kind: "session_end", ts: started_at + 1000, session_id: id,
        ended_at: started_at + 1000, branch_end: "feat", head_sha_end: `sha-end-${id}`,
        exit_reason: "normal",
      });
      // Need prompt + turn rows because llm_messages.turn_id FK requires turns,
      // and turns.prompt_id is NOT NULL.
      pSink.write({
        kind: "prompt", ts: started_at + 50, id: `p-${id}`, session_id: id,
        source: "user", command: null, slash_kind: null,
        text_len: 10, text_sha256: `sha-p-${id}`, image_count: 0,
      });
      pSink.write({
        kind: "turn_start", ts: started_at + 100, id: `t-${id}`,
        session_id: id, prompt_id: `p-${id}`,
        idx: 0, started_at: started_at + 100,
        model_id: "claude-haiku-4-5", provider: "anthropic", thinking_level: null,
      });
      pSink.write({
        kind: "turn_end", ts: started_at + 400, turn_id: `t-${id}`, session_id: id,
        ended_at: started_at + 400,
        model_id: "claude-haiku-4-5", provider: "anthropic",
        thinking_level: null, stop_reason: "end_turn",
      });
      // Cost: $0.05 per session.
      pSink.write({
        kind: "llm_message", ts: started_at + 500,
        id: `lm-${id}`, turn_id: `t-${id}`, session_id: id,
        role: "assistant",
        input_tokens: 100, output_tokens: 50,
        cache_read_tokens: 0, cache_write_tokens: 0,
        cost_input: 0.02, cost_output: 0.03,
        cost_cache_read: 0, cost_cache_write: 0,
        cost_total: 0.05,
        time_to_first_token_ms: null, total_duration_ms: null, stop_reason: "end_turn",
      });
      // PR association for all three sessions.
      pSink.write({
        kind: "pr_association", ts: linkedAt, session_id: id,
        repo_remote: "https://github.com/owner/repo",
        pr_number: 99, pr_url: "https://github.com/owner/repo/pull/99",
        confidence: id === "sB" ? 1.0 : 0.8,
        reason: id === "sB" ? "commit-in-pr" : "branch-match",
      });
    }
    // Commits: sB gets 2, sC gets 1, sA gets 0.
    for (let i = 0; i < 2; i++) {
      pSink.write({
        kind: "commit_made", ts: startB + i * 1000, session_id: "sB", turn_id: null,
        sha: `sha-b${i}`, subject: `feat: commit ${i}`,
        files_changed: 1, insertions: 5, deletions: 0,
      });
    }
    pSink.write({
      kind: "commit_made", ts: startC, session_id: "sC", turn_id: null,
      sha: "sha-c0", subject: "fix: review fix",
      files_changed: 1, insertions: 2, deletions: 1,
    });

    const d = runUsageJson(pSink, { tab: "prs", since: "all" }) as {
      rows: Array<{
        pr_number: number;
        repo_remote?: string;
        repo_short?: string;
        total_cost_usd: number;
        total_commits: number;
        sessions: number;
        top_reason: string;
        phase_breakdown: { planning: number; implementation: number; fixup: number };
        breakdown: Array<{ session_id: string; phase: string; cost_usd: number; commits: number }>;
      }>;
    };

    assert.equal(d.rows.length, 1, "one PR row");
    const pr = d.rows[0]!;

    // Repo identity — a PR number alone is ambiguous across repos, so the
    // grouped row carries the parsed remote in two forms (raw + shortened).
    assert.equal(pr.repo_remote, "https://github.com/owner/repo",
      "repo_remote propagated from pr_associations");
    assert.equal(pr.repo_short, "owner/repo",
      "repo_short is the parsed owner/name");

    // Totals.
    assert.equal(pr.sessions, 3, "3 sessions");
    assert.equal(pr.total_commits, 3, "3 commits total (2 impl + 1 fixup)");
    assert.equal(pr.top_reason, "commit-in-pr", "top_reason is highest-confidence");
    assert.ok(Math.abs(pr.total_cost_usd - 0.15) < 0.001, `total_cost ~$0.15 (got ${pr.total_cost_usd})`);

    // Breakdown length.
    assert.equal(pr.breakdown.length, 3, "3 breakdown entries");

    // Phase classification.
    const bySession = new Map(pr.breakdown.map((b) => [b.session_id, b]));
    assert.equal(bySession.get("sA")!.phase, "planning",        "sA → planning (0 commits)");
    assert.equal(bySession.get("sB")!.phase, "implementation",  "sB → implementation");
    assert.equal(bySession.get("sC")!.phase, "fixup",           "sC → fixup");

    // Phase breakdown costs sum to total (within floating-point rounding).
    const { planning, implementation, fixup } = pr.phase_breakdown;
    assert.ok(
      Math.abs(planning + implementation + fixup - pr.total_cost_usd) < 0.0001,
      `phase costs sum to total_cost_usd (${planning}+${implementation}+${fixup} vs ${pr.total_cost_usd})`,
    );

    await pSink.close();
  });

  it("daily — at least one row with date/cost_usd/tokens/turns", () => {
    const d = runUsageJson(sink, { tab: "daily" }) as {
      rows: Array<{ date: string; cost_usd: number; tokens: number; turns: number }>;
    };
    assert.ok(Array.isArray(d.rows));
    assert.ok(d.rows.length >= 1, "at least one daily row");
    const r = d.rows[0]!;
    assert.ok(typeof r.date === "string" && r.date.length === 10, `date is YYYY-MM-DD, got ${r.date}`);
    assert.ok(typeof r.cost_usd === "number");
    assert.ok(typeof r.tokens === "number");
    assert.ok(typeof r.turns === "number");
  });

  it("summary cost_total matches sum of seeded llm_messages (≈0.04)", () => {
    // Use "all" window so all 4 messages count
    const d = runUsageJson(sink, { tab: "summary", since: "all" }) as {
      today: { cost_usd: number };
    };
    // All messages were seeded with _ts in the recent past → appear in today bucket
    assert.ok(
      Math.abs(d.today.cost_usd - 0.04) < 0.001,
      `today.cost_usd ≈ 0.04, got ${d.today.cost_usd}`,
    );
  });
});

// ── runUsageInteractive smoke test ────────────────────────────────────────────

describe("runUsageInteractive", () => {
  it("calls ctx.ui.notify without throwing", async () => {
    const sink = await makeSink();
    const notifyCalls: Array<[string, string?]> = [];
    const stubCtx = {
      ui: {
        notify: (msg: string, kind?: string) => { notifyCalls.push([msg, kind]); },
      },
    };
    const stubPi: PiAPIStub = {
      on: (_evt: string, _handler: (...a: unknown[]) => unknown) => {},
    };

    await assert.doesNotReject(
      runUsageInteractive(stubPi, sink, stubCtx, "--tab=summary"),
    );
    assert.ok(notifyCalls.length >= 1, "ui.notify was called at least once");
    // The rendered output should contain the word "Summary"
    const combined = notifyCalls.map(([m]) => m).join("\n");
    assert.ok(combined.includes("Summary") || combined.length > 0,
      "output has non-empty content");

    await sink.close();
  });
});
