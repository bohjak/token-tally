/**
 * Human-readable text formatting for /usage command output.
 *
 * These functions are used in the "fallback" interactive path when Pi's
 * ctx.ui.custom is not available (e.g. -p / print mode, RPC mode, test stubs).
 * The JSON path skips all formatting and calls JSON.stringify directly.
 *
 * All cost values are already in display-USD (converted from micros at the
 * query layer). Functions here do no currency arithmetic.
 */

import type { UsageTab } from "./queries.ts";

// ---------------------------------------------------------------------------
// Simple table helpers
// ---------------------------------------------------------------------------

/** Right-align a value in a fixed-width column, truncating if too long. */
function r(val: unknown, width: number): string {
  const s = String(val ?? "");
  return s.padStart(width).slice(-width);
}

/** Left-align a value in a fixed-width column, truncating if too long. */
function l(val: unknown, width: number): string {
  const s = String(val ?? "");
  return s.padEnd(width).slice(0, width);
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function fmtNum(n: number): string {
  return n.toLocaleString("en");
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Tab renderers
// ---------------------------------------------------------------------------

function renderSummary(data: unknown): string {
  const d = data as {
    today: { cost_usd: number; billable_tokens: number; turns: number; sessions: number; unpriced_count: number };
    week:  { cost_usd: number; billable_tokens: number; turns: number; sessions: number; unpriced_count: number };
    month: { cost_usd: number; billable_tokens: number; turns: number; sessions: number; unpriced_count: number };
    session: { cost_usd: number; billable_tokens: number; turns: number; unpriced_count: number };
    top_model: { model_id: string; cost_usd: number; turns: number } | null;
    harnesses: Array<{ name: string; display_name: string }>;
  };

  const lines: string[] = [];
  lines.push("╭──────────────────── ToTally Usage Summary ─────────────────────╮");
  lines.push(`│ ${"Window".padEnd(10)} ${"Cost (USD)".padStart(12)} ${"Tokens".padStart(12)} ${"Turns".padStart(7)} ${"Unpriced".padStart(9)} │`);
  lines.push("├────────────────────────────────────────────────────────────────┤");

  for (const [label, b] of [
    ["Today",   d.today],
    ["Week",    d.week],
    ["Month",   d.month],
    ["Session", d.session],
  ] as const) {
    const bucket = b as typeof d.today;
    const unpriced = bucket.unpriced_count > 0 ? `${bucket.unpriced_count}⚠` : "—";
    lines.push(
      `│ ${l(label, 10)} ${r(fmtUsd(bucket.cost_usd), 12)} ${r(fmtNum(bucket.billable_tokens), 12)} ` +
      `${r(bucket.turns, 7)} ${r(unpriced, 9)} │`
    );
  }

  if (d.top_model != null) {
    lines.push("├────────────────────────────────────────────────────────────────┤");
    lines.push(
      `│ Top model: ${l(`${d.top_model.model_id} (${fmtUsd(d.top_model.cost_usd)}, ${d.top_model.turns} turns)`, 51)} │`
    );
  }

  if (d.harnesses.length > 0) {
    const harnessNames = d.harnesses.map((h) => h.display_name).join(", ");
    lines.push("├────────────────────────────────────────────────────────────────┤");
    lines.push(`│ Sources: ${l(harnessNames, 54)} │`);
  }

  lines.push("╰────────────────────────────────────────────────────────────────╯");
  lines.push("⚠ = messages with unknown cost provenance, excluded from totals.");
  return lines.join("\n");
}

function renderModels(data: unknown): string {
  const { rows, unpriced_count } = data as {
    rows: Array<{
      model_id: string;
      harness_id: string;
      cost_usd: number;
      billable_tokens: number;
      turns: number;
      share: number;
      avg_tokens_per_turn: number;
    }>;
    unpriced_count: number;
  };

  const lines: string[] = [];
  lines.push(
    `${l("Model", 28)} ${l("Harness", 12)} ${r("Cost", 10)} ${r("Share", 7)} ${r("Turns", 6)} ${r("Avg tok/turn", 13)}`
  );
  lines.push("─".repeat(80));
  for (const row of rows) {
    lines.push(
      `${l(row.model_id, 28)} ${l(row.harness_id, 12)} ${r(fmtUsd(row.cost_usd), 10)} ` +
      `${r(fmtPct(row.share), 7)} ${r(row.turns, 6)} ${r(Math.round(row.avg_tokens_per_turn), 13)}`
    );
  }
  if (unpriced_count > 0) {
    lines.push("");
    lines.push(`⚠ ${unpriced_count} message(s) have unknown cost provenance and are excluded from totals.`);
  }
  return lines.join("\n");
}

function renderRepos(data: unknown): string {
  const { rows } = data as {
    rows: Array<{
      repo: string;
      harness_id: string;
      cost_usd: number;
      billable_tokens: number;
      sessions: number;
    }>;
  };

  const lines: string[] = [];
  lines.push(
    `${l("Repo", 38)} ${l("Harness", 12)} ${r("Cost", 10)} ${r("Sessions", 9)}`
  );
  lines.push("─".repeat(73));
  for (const row of rows) {
    lines.push(
      `${l(row.repo, 38)} ${l(row.harness_id, 12)} ${r(fmtUsd(row.cost_usd), 10)} ${r(row.sessions, 9)}`
    );
  }
  if (rows.length === 0) {
    lines.push("No repository data available.");
  }
  return lines.join("\n");
}

function renderTools(data: unknown): string {
  const { rows } = data as {
    rows: Array<{
      tool_name: string;
      calls: number;
      errors: number;
      error_rate: number;
      p50_ms: number;
      p95_ms: number;
    }>;
  };

  const lines: string[] = [];
  lines.push(
    `${l("Tool", 24)} ${r("Calls", 7)} ${r("Errors", 7)} ${r("Err%", 6)} ${r("p50ms", 7)} ${r("p95ms", 7)}`
  );
  lines.push("─".repeat(62));
  for (const row of rows) {
    lines.push(
      `${l(row.tool_name, 24)} ${r(row.calls, 7)} ${r(row.errors, 7)} ` +
      `${r(fmtPct(row.error_rate), 6)} ${r(row.p50_ms, 7)} ${r(row.p95_ms, 7)}`
    );
  }
  if (rows.length === 0) {
    lines.push("No tool-call data available.");
  }
  return lines.join("\n");
}

function renderPrs(data: unknown): string {
  const { note } = data as { rows: unknown[]; note: string };
  return `ℹ  ${note}`;
}

function renderDaily(data: unknown): string {
  const { rows, unpriced_count } = data as {
    rows: Array<{ date: string; cost_usd: number; billable_tokens: number; turns: number }>;
    unpriced_count: number;
  };

  const maxCost = Math.max(...rows.map((r) => r.cost_usd), 0.0001);
  const blocks = " ▁▂▃▄▅▆▇█";
  // Newest-first from query; reverse for the sparkline so left = oldest.
  const spark = [...rows]
    .slice(0, 30)
    .reverse()
    .map((r) => blocks[Math.min(8, Math.floor((r.cost_usd / maxCost) * 8))])
    .join("");

  const lines: string[] = [];
  lines.push(`Sparkline (last 30d): ${spark}`);
  lines.push("");
  lines.push(`${l("Date", 12)} ${r("Cost (USD)", 12)} ${r("Tokens", 12)} ${r("Turns", 6)}`);
  lines.push("─".repeat(46));
  for (const row of rows) {
    lines.push(
      `${l(row.date, 12)} ${r(fmtUsd(row.cost_usd), 12)} ${r(fmtNum(row.billable_tokens), 12)} ${r(row.turns, 6)}`
    );
  }
  if (unpriced_count > 0) {
    lines.push("");
    lines.push(`⚠ ${unpriced_count} message(s) with unknown cost provenance excluded from totals.`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Public render dispatch
// ---------------------------------------------------------------------------

/**
 * Renders query result data as a human-readable multi-line string.
 * The `tab` argument selects which renderer to use.
 */
export function renderTab(tab: UsageTab, data: unknown): string {
  switch (tab) {
    case "summary": return renderSummary(data);
    case "models":  return renderModels(data);
    case "repos":   return renderRepos(data);
    case "tools":   return renderTools(data);
    case "prs":     return renderPrs(data);
    case "daily":   return renderDaily(data);
  }
}
