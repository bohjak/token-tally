/**
 * usage-component.test.ts — Tests for UsageTabsComponent.
 *
 * Uses a stub Theme (identity functions) and a controllable loadTab spy.
 * Arrow-key sequences: right="\x1b[C", left="\x1b[D", esc="\x1b".
 * Bracket keys: "[" and "]" (literal chars that matchesKey resolves).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@mariozechner/pi-tui";
import { UsageTabsComponent, type Theme } from "./usage-component.ts";
import type { UsageTab, UsageSince } from "./usage.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Theme stub: passes text through, bg wraps in [BG:text]. */
const stubTheme: Theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => `[BG:${text}]`,
};

const TAB_NAMES: UsageTab[] = ["summary", "models", "repos", "tools", "prs", "daily"];

/** Minimal stub data for each tab so renderBody doesn't throw. */
function stubData(tab: UsageTab): unknown {
  switch (tab) {
    case "summary":
      return {
        today:   { cost_usd: 0.01, tokens: 100,  cached_tokens: 60,   cached_cost_usd: 0.001, cache_savings_usd: 0.005, turns: 1 },
        week:    { cost_usd: 0.05, tokens: 500,  cached_tokens: 300,  cached_cost_usd: 0.005, cache_savings_usd: 0.025, turns: 5 },
        month:   { cost_usd: 0.20, tokens: 2000, cached_tokens: 1200, cached_cost_usd: 0.020, cache_savings_usd: 0.100, turns: 20 },
        session: { cost_usd: 0.01, tokens: 100,  cached_tokens: 60,   cached_cost_usd: 0.001, cache_savings_usd: 0.005, turns: 1 },
        top_model: { id: "test-model", cost_usd: 0.05, turns: 5 },
      };
    case "models":
      return {
        rows: [{ model_id: "m1", cost_usd: 0.1, tokens_in: 100, tokens_out: 50, cached_tokens: 60, cache_read_tokens: 50, cache_write_tokens: 10, cache_hit_rate: 0.6, cached_cost_usd: 0.005, turns: 3, share: 1.0, avg_tokens_per_turn: 50 }],
      };
    case "repos":
      return {
        rows: [{ repo_remote: "github.com/x/y", sessions: 2, files_touched: 4, cost_usd: 0.1, top_tool: "read" }],
      };
    case "tools":
      return {
        rows: [{ name: "read", calls: 5, total_duration_ms: 100, error_rate: 0, p50_ms: 20, p95_ms: 40 }],
      };
    case "prs":
      return {
        rows: [
          {
            pr_number: 42,
            pr_url: "https://github.com/owner/repo/pull/42",
            repo_remote: "https://github.com/owner/repo",
            repo_short: "owner/repo",
            sessions: 3,
            total_cost_usd: 0.15,
            total_files: 10,
            total_turns: 6,
            total_commits: 3,
            top_reason: "commit-in-pr",
            confidence: 1.0,
            phase_breakdown: { planning: 0.05, implementation: 0.07, fixup: 0.03 },
            breakdown: [
              { session_id: "sA", started_at: Date.now() - 86400000 * 5, phase: "planning",       cost_usd: 0.05, tokens: 500, turns: 2, commits: 0, confidence: 0.8, reason: "branch-match" },
              { session_id: "sB", started_at: Date.now() - 86400000 * 4, phase: "implementation", cost_usd: 0.07, tokens: 700, turns: 3, commits: 2, confidence: 1.0, reason: "commit-in-pr" },
              { session_id: "sC", started_at: Date.now() - 86400000 * 2, phase: "fixup",          cost_usd: 0.03, tokens: 300, turns: 1, commits: 1, confidence: 0.8, reason: "branch-match" },
            ],
          },
        ],
      };
    case "daily":
      return {
        rows: [{ date: "2026-05-06", cost_usd: 0.02, tokens: 200, cached_tokens: 120, cached_cost_usd: 0.002, turns: 2 }],
      };
  }
}

function makeComponent(opts?: {
  initialTab?: UsageTab;
  since?: UsageSince;
  loadTab?: (tab: UsageTab, since: UsageSince | undefined) => unknown;
  onClose?: () => void;
}): { comp: UsageTabsComponent; calls: Array<[UsageTab, UsageSince | undefined]>; closed: number } {
  const calls: Array<[UsageTab, UsageSince | undefined]> = [];
  let closed = 0;
  const comp = new UsageTabsComponent({
    loadTab: opts?.loadTab ?? ((tab, since) => { calls.push([tab, since]); return stubData(tab); }),
    initialTab: opts?.initialTab,
    since: opts?.since,
    theme: stubTheme,
    onClose: opts?.onClose ?? (() => { closed++; }),
  });
  return { comp, calls, closed: 0 };

  // Note: `closed` in the object literal won't reflect mutations.
  // Return a counter object instead:
}

function makeComp(opts?: {
  initialTab?: UsageTab;
  since?: UsageSince;
  loadTab?: (tab: UsageTab, since: UsageSince | undefined) => unknown;
}): { comp: UsageTabsComponent; calls: Array<[UsageTab, UsageSince | undefined]>; closeCalls: { n: number } } {
  const calls: Array<[UsageTab, UsageSince | undefined]> = [];
  const closeCalls = { n: 0 };
  const comp = new UsageTabsComponent({
    loadTab: opts?.loadTab ?? ((tab, since) => { calls.push([tab, since]); return stubData(tab); }),
    initialTab: opts?.initialTab,
    since: opts?.since,
    theme: stubTheme,
    onClose: () => { closeCalls.n++; },
  });
  return { comp, calls, closeCalls };
}

const RIGHT = "\x1b[C";
const LEFT  = "\x1b[D";
const ESC   = "\x1b";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("UsageTabsComponent", () => {
  it("renders all 6 tab names in the tab bar", () => {
    const { comp } = makeComp();
    const lines = comp.render(100);
    const tabBar = lines[0]!;
    for (const name of TAB_NAMES) {
      assert.ok(tabBar.includes(name), `tab bar should contain "${name}"`);
    }
  });

  it("highlights the initial tab (summary) with [BG: marker", () => {
    const { comp } = makeComp({ initialTab: "summary" });
    const tabBar = comp.render(100)[0]!;
    // stubTheme.bg wraps with [BG:...]
    assert.ok(tabBar.includes("[BG: summary "), `active tab "summary" should be highlighted`);
    // Other tabs should not be highlighted
    assert.ok(!tabBar.includes("[BG: models "), `inactive "models" should not be highlighted`);
  });

  it("highlights a non-default initial tab correctly", () => {
    const { comp } = makeComp({ initialTab: "tools" });
    const tabBar = comp.render(100)[0]!;
    assert.ok(tabBar.includes("[BG: tools "), `active tab "tools" should be highlighted`);
    assert.ok(!tabBar.includes("[BG: summary "), `"summary" should not be highlighted`);
  });

  it("right arrow advances to the next tab", () => {
    const { comp } = makeComp({ initialTab: "summary" });
    comp.handleInput(RIGHT);
    const tabBar = comp.render(100)[0]!;
    assert.ok(tabBar.includes("[BG: models "), `after right, "models" should be active`);
    assert.ok(!tabBar.includes("[BG: summary "), `"summary" should no longer be active`);
  });

  it("] bracket advances tab (same as right arrow)", () => {
    const { comp } = makeComp({ initialTab: "summary" });
    comp.handleInput("]");
    const tabBar = comp.render(100)[0]!;
    assert.ok(tabBar.includes("[BG: models "), `after "]", "models" should be active`);
  });

  it("left arrow at index 0 wraps to last tab (daily)", () => {
    const { comp } = makeComp({ initialTab: "summary" });
    comp.handleInput(LEFT);
    const tabBar = comp.render(100)[0]!;
    assert.ok(tabBar.includes("[BG: daily "), `wrapping left from summary should land on "daily"`);
  });

  it("[ bracket goes left (same as left arrow)", () => {
    const { comp } = makeComp({ initialTab: "models" });
    comp.handleInput("[");
    const tabBar = comp.render(100)[0]!;
    assert.ok(tabBar.includes("[BG: summary "), `after "[" from "models", should be "summary"`);
  });

  it("right arrow from last tab wraps to first (summary)", () => {
    const { comp } = makeComp({ initialTab: "daily" });
    comp.handleInput(RIGHT);
    const tabBar = comp.render(100)[0]!;
    assert.ok(tabBar.includes("[BG: summary "), `wrapping right from daily should land on "summary"`);
  });

  it("digit keys 1-6 jump directly to the corresponding tab", () => {
    const { comp } = makeComp();
    const expected = TAB_NAMES;
    for (let i = 0; i < expected.length; i++) {
      comp.handleInput(String(i + 1));
      const tabBar = comp.render(100)[0]!;
      assert.ok(
        tabBar.includes(`[BG: ${expected[i]} `),
        `digit ${i + 1} should activate "${expected[i]}"`,
      );
    }
  });

  it("q closes the component (onClose called once)", () => {
    const { comp, closeCalls } = makeComp();
    comp.render(80); // initialise
    comp.handleInput("q");
    assert.equal(closeCalls.n, 1, "onClose should be called exactly once on 'q'");
  });

  it("Escape closes the component", () => {
    const { comp, closeCalls } = makeComp();
    comp.handleInput(ESC);
    assert.equal(closeCalls.n, 1, "onClose should be called on Escape");
  });

  it("Q (uppercase) also closes the component", () => {
    const { comp, closeCalls } = makeComp();
    comp.handleInput("Q");
    assert.equal(closeCalls.n, 1);
  });

  it("s cycles the since filter and re-fetches data", () => {
    const calls: Array<[UsageTab, UsageSince | undefined]> = [];
    const { comp } = makeComp({
      loadTab: (tab, since) => { calls.push([tab, since]); return stubData(tab); },
    });
    // First render loads summary with since=undefined
    comp.render(80);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ["summary", undefined]);

    // Press 's': since should cycle to "24h", data cache cleared
    comp.handleInput("s");
    comp.render(80);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], ["summary", "24h"]);

    // Press 's' again: since → "7d"
    comp.handleInput("s");
    comp.render(80);
    assert.deepEqual(calls[2], ["summary", "7d"]);
  });

  it("s cycles through all 4 since values and wraps back to 24h", () => {
    const sinceValues: Array<UsageSince | undefined> = [];
    const { comp } = makeComp({
      loadTab: (tab, since) => { sinceValues.push(since); return stubData(tab); },
    });
    // Start: undefined (no since)
    comp.render(80); // loads with undefined
    // Cycle through all 4 SINCE_VALUES
    for (let i = 0; i < 4; i++) {
      comp.handleInput("s");
      comp.render(80);
    }
    // After 4 presses starting from undefined: 24h, 7d, month, all
    assert.equal(sinceValues.length, 5);
    assert.deepEqual(sinceValues.slice(1), ["24h", "7d", "month", "all"]);
  });

  it("lazy-load: only visited tabs have loadTab called", () => {
    const calls: Array<[UsageTab, UsageSince | undefined]> = [];
    const { comp } = makeComp({
      loadTab: (tab, since) => { calls.push([tab, since]); return stubData(tab); },
    });
    // Render summary (first tab)
    comp.render(80);
    assert.equal(calls.length, 1, "only summary loaded on first render");
    assert.equal(calls[0]![0], "summary");

    // Switch to models
    comp.handleInput(RIGHT);
    comp.render(80);
    assert.equal(calls.length, 2, "models loaded after switching");
    assert.equal(calls[1]![0], "models");

    // Render models again (cached — no extra call)
    comp.render(80);
    assert.equal(calls.length, 2, "second render of models should use cache");

    // Switch back to summary (cached — no extra call)
    comp.handleInput(LEFT);
    comp.render(80);
    assert.equal(calls.length, 2, "revisiting summary should use cache");
  });

  it("error in loadTab renders an error message without crashing", () => {
    const boom = new Error("DB exploded");
    const { comp } = makeComp({
      loadTab: () => { throw boom; },
    });
    const lines = comp.render(80);
    const body = lines.join("\n");
    assert.ok(body.includes("Error:"), "should contain 'Error:' on failure");
    assert.ok(body.includes("DB exploded"), "should include the error message");
  });

  it("switching tab after error still works for other tabs", () => {
    let callCount = 0;
    const { comp } = makeComp({
      loadTab: (tab) => {
        callCount++;
        if (tab === "summary") throw new Error("summary broken");
        return stubData(tab);
      },
    });
    // Render summary → error
    const errLines = comp.render(80);
    assert.ok(errLines.join("\n").includes("Error:"));

    // Switch to models → should work
    comp.handleInput(RIGHT);
    const modelLines = comp.render(80);
    assert.ok(!modelLines.join("\n").includes("Error:"), "models tab should not show error");
    assert.ok(modelLines.join("\n").includes("m1"), "models data should appear");
  });

  it("render output: every line width ≤ requested width (40, 80, 120)", () => {
    const { comp } = makeComp();
    for (const width of [40, 80, 120]) {
      // Visit all tabs
      for (let i = 0; i < TAB_NAMES.length; i++) {
        comp.handleInput(String(i + 1));
        const lines = comp.render(width);
        for (const line of lines) {
          const vw = visibleWidth(line);
          assert.ok(
            vw <= width,
            `tab "${TAB_NAMES[i]}" at width=${width}: line width ${vw} > ${width}\n  Line: ${JSON.stringify(line)}`,
          );
        }
      }
    }
  });

  it("footer always shows the current since label", () => {
    const { comp } = makeComp();
    let footer = comp.render(80).at(-1)!;
    assert.ok(footer.includes("all"), `footer should show "all" initially`);

    comp.handleInput("s"); // → 24h
    footer = comp.render(80).at(-1)!;
    assert.ok(footer.includes("24h"), `footer should show "24h" after 's'`);
  });

  it("narrow terminal (width < 40) shows resize message", () => {
    const { comp } = makeComp();
    const lines = comp.render(20);
    assert.ok(lines.length === 1, "should return single line for narrow terminal");
    assert.ok(lines[0]!.includes("resize"), "should prompt to resize terminal");
  });

  it("summary tab shows 'Cache saved:' line when at least one bucket has savings > 0", () => {
    // Fixture has cache_savings_usd > 0 for all buckets (0.005 / 0.025 / 0.100 / 0.005).
    const { comp } = makeComp();
    const body = comp.render(80).join("\n");
    assert.ok(body.includes("Cache saved:"), "should contain 'Cache saved:' line");
    // The dollar amounts from the fixture should appear.
    assert.ok(body.includes("$0.0050") || body.includes("$0.005"), "today savings visible");
  });

  it("summary tab hides 'Cache saved:' line when all buckets have savings = 0", () => {
    const { comp } = makeComp({
      loadTab: (tab) => {
        if (tab !== "summary") return stubData(tab);
        return {
          today:   { cost_usd: 0.01, tokens: 100, cached_tokens: 0, cached_cost_usd: 0, cache_savings_usd: 0,  turns: 1 },
          week:    { cost_usd: 0.01, tokens: 100, cached_tokens: 0, cached_cost_usd: 0, cache_savings_usd: -0.001, turns: 1 },
          month:   { cost_usd: 0.01, tokens: 100, cached_tokens: 0, cached_cost_usd: 0, cache_savings_usd: 0,  turns: 1 },
          session: { cost_usd: 0.01, tokens: 100, cached_tokens: 0, cached_cost_usd: 0, cache_savings_usd: 0,  turns: 1 },
          top_model: null,
        };
      },
    });
    const body = comp.render(80).join("\n");
    assert.ok(!body.includes("Cache saved:"), "'Cache saved:' should be hidden when no positive savings");
  });

  // ── PRs tab specific tests ───────────────────────────────────────────────────

  it("PRs tab compact mode: shows PR header but not breakdown rows", () => {
    const { comp } = makeComp({ initialTab: "prs" });
    // Force compact by pressing [c] after an initial expanded render at wide width.
    // First render at wide width: prsCompact auto-sets to false (width >= 100).
    comp.render(140);
    // Now press [c] to switch to compact.
    comp.handleInput("c");
    const lines = comp.render(140).join("\n");
    // PR header must be present.
    assert.ok(lines.includes("#42"), "PR header with #42 should appear");
    // Breakdown phase labels must NOT appear (they're indented detail rows).
    assert.ok(!lines.includes("plan \u00b7") && !lines.includes("impl \u00b7") && !lines.includes("fixup \u00b7"),
      "compact mode should not show breakdown detail rows");
  });

  it("PRs tab header line includes repo_short alongside the PR number", () => {
    const { comp } = makeComp({ initialTab: "prs" });
    const lines = comp.render(140).join("\n");
    assert.ok(lines.includes("owner/repo#42"),
      `header should be 'owner/repo#42', got:\n${lines.split("\n").find((l) => l.includes("#42"))}`);
  });

  it("PRs tab header falls back to plain '#N' when repo_short is missing", () => {
    // Synthesise a fixture with the repo fields stripped to simulate older
    // rows from before pa.repo_remote was selected.
    const customLoader = (tab: UsageTab): unknown => {
      const data = stubData(tab);
      if (tab === "prs") {
        const prs = data as { rows: Array<Record<string, unknown>> };
        for (const r of prs.rows) { delete r.repo_short; delete r.repo_remote; }
      }
      return data;
    };
    const { comp } = makeComp({ initialTab: "prs", loadTab: customLoader });
    const lines = comp.render(140).join("\n");
    const headerLine = lines.split("\n").find((l) => l.includes("#42")) ?? "";
    assert.ok(headerLine.includes("#42"), "plain '#42' header is present");
    assert.ok(!headerLine.includes("/repo#42"),
      `should not contain '/repo#42' when repo_short missing, got:\n${headerLine}`);
  });

  it("PRs tab expanded mode: shows breakdown rows with phase labels", () => {
    const { comp } = makeComp({ initialTab: "prs" });
    // Render at wide width to get auto-expanded (>= 100 cols).
    const lines = comp.render(140).join("\n");
    // Breakdown detail rows contain phase words.
    assert.ok(
      lines.includes("plan") || lines.includes("impl") || lines.includes("fixup"),
      "expanded mode should show phase breakdown words in detail rows",
    );
  });

  it("PRs tab [c] toggles compact <-> expanded", () => {
    const { comp } = makeComp({ initialTab: "prs" });
    // Start expanded (wide terminal).
    const expanded = comp.render(140).join("\n");
    const hasBreakdown = expanded.includes("plan") || expanded.includes("impl") || expanded.includes("fixup");
    // Toggle to compact.
    comp.handleInput("c");
    const compact = comp.render(140).join("\n");
    const stillHasBreakdown = compact.includes("plan \u00b7") || compact.includes("impl \u00b7");
    // One should have breakdown, the other should not.
    assert.ok(hasBreakdown !== stillHasBreakdown,
      "[c] should toggle between compact and expanded (breakdown visibility differs)");
  });

  it("PRs tab shows phase bar when phase_breakdown has non-zero values", () => {
    const { comp } = makeComp({ initialTab: "prs" });
    const lines = comp.render(140).join("\n");
    // Phase bar uses full-block chars █; fixture has non-zero planning/impl/fixup.
    assert.ok(lines.includes("█"), "phase bar should use block characters");
  });

  it("PRs tab footer mentions compact hint", () => {
    const { comp } = makeComp({ initialTab: "prs" });
    comp.render(140); // trigger auto-expand
    const footer = comp.render(140).at(-1)!;
    // Main footer line should mention [c]
    const allLines = comp.render(140).join("\n");
    assert.ok(allLines.includes("[c]"), "PRs tab should mention [c] in footer or compact hint");
  });

  it("PRs tab empty state renders gracefully", () => {
    const { comp } = makeComp({
      initialTab: "prs",
      loadTab: () => ({ rows: [] }),
    });
    const lines = comp.render(80).join("\n");
    assert.ok(lines.includes("No PR associations"), "empty state message should appear");
  });
});
