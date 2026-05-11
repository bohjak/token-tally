/**
 * Read-only query functions for the ToTally central store.
 *
 * All queries run against the central schema (store/schema/001_initial.sql).
 *
 * COST SEMANTICS
 *   The central schema stores costs as integer micro-dollars
 *   (1 USD = 1_000_000 micros). This module converts to display-USD at
 *   the query boundary: cost_total_micros / 1_000_000.0.
 *
 *   Rows with cost_source = 'unknown' are excluded from cost aggregations
 *   but counted separately in unpricedCount so callers can show "N unpriced
 *   messages" alongside headline totals.
 *
 * MISSING LEGACY TABLES
 *   The central schema does not (yet) include pr_associations, files_touched,
 *   or commits_made — those tables belong to the legacy Pi extension's private
 *   schema. The `queryPrs` function returns an informative stub result.
 */

import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type UsageTab = "summary" | "models" | "repos" | "tools" | "prs" | "daily";
export type UsageSince = "24h" | "7d" | "month" | "all";

export type UsageArgs = {
  json: boolean;
  tab?: UsageTab;
  since?: UsageSince;
};

// Returned cost is always in display-USD (cost_total_micros / 1_000_000.0).
export type CostBucket = {
  cost_usd: number;
  billable_tokens: number;
  /** Total input + output + cached tokens; used by the interactive UI. */
  tokens: number;
  cached_tokens: number;
  cached_cost_usd: number;
  cache_savings_usd: number;
  turns: number;
  sessions: number;
  unpriced_count: number;
};

// ---------------------------------------------------------------------------
// Arg parser
// ---------------------------------------------------------------------------

const VALID_TABS = new Set<UsageTab>(["summary", "models", "repos", "tools", "prs", "daily"]);
const VALID_SINCE = new Set<UsageSince>(["24h", "7d", "month", "all"]);

/**
 * Parses /usage flags from the raw argument string Pi passes to the handler.
 * Supports:
 *   --json
 *   --tab=<value>  or  --tab <value>
 *   --since=<value>  or  --since <value>
 * Unknown flags are silently ignored.
 */
export function parseUsageArgs(rawArgs: string): UsageArgs {
  const argv = rawArgs.trim().split(/\s+/).filter(Boolean);
  const result: UsageArgs = { json: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") {
      result.json = true;
    } else if (arg.startsWith("--tab=")) {
      const v = arg.slice(6) as UsageTab;
      if (VALID_TABS.has(v)) result.tab = v;
    } else if (arg === "--tab" && i + 1 < argv.length) {
      const v = argv[++i] as UsageTab;
      if (VALID_TABS.has(v)) result.tab = v;
    } else if (arg.startsWith("--since=")) {
      const v = arg.slice(8) as UsageSince;
      if (VALID_SINCE.has(v)) result.since = v;
    } else if (arg === "--since" && i + 1 < argv.length) {
      const v = argv[++i] as UsageSince;
      if (VALID_SINCE.has(v)) result.since = v;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/** Returns the start-of-local-day (midnight) N calendar days ago, as Unix ms. */
function startOfDayLocal(daysAgo: number): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.getTime();
}

/** Converts a UsageSince value to an absolute Unix-ms lower bound. */
function sinceToMs(since?: UsageSince): number {
  const now = Date.now();
  switch (since) {
    case "24h":   return now - 24 * 60 * 60 * 1000;
    case "7d":    return now - 7  * 24 * 60 * 60 * 1000;
    case "month": return now - 30 * 24 * 60 * 60 * 1000;
    default:      return 0; // "all"
  }
}

// ---------------------------------------------------------------------------
// Summary tab
// ---------------------------------------------------------------------------

type BucketRow = {
  cost_usd: number;
  billable_tokens: number;
  tokens: number;
  cached_tokens: number;
  cached_cost_usd: number;
  cache_savings_usd: number;
  turns: number;
  sessions: number;
};

type UnpricedRow = { n: number };

function queryCostBucket(db: Database.Database, fromMs: number): CostBucket {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(cost_total_micros), 0) / 1000000.0 AS cost_usd,
         COALESCE(SUM(input_tokens + output_tokens), 0)  AS billable_tokens,
         COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS tokens,
         COALESCE(SUM(cache_read_tokens + cache_write_tokens), 0) AS cached_tokens,
         COALESCE(SUM(cost_cache_read_micros + cost_cache_write_micros), 0) / 1000000.0 AS cached_cost_usd,
         COALESCE(SUM(
           CASE WHEN input_tokens > 0
             THEN (cache_read_tokens + cache_write_tokens) * (cost_input_micros * 1.0 / input_tokens)
                  - (cost_cache_read_micros + cost_cache_write_micros)
             ELSE 0
           END
         ), 0) / 1000000.0 AS cache_savings_usd,
         COUNT(DISTINCT turn_id)    AS turns,
         COUNT(DISTINCT session_id) AS sessions
       FROM llm_messages
       WHERE ts >= ? AND cost_source != 'unknown'`
    )
    .get(fromMs) as BucketRow | undefined;

  const unpriced = db
    .prepare(
      `SELECT COUNT(*) AS n FROM llm_messages
       WHERE ts >= ? AND cost_source = 'unknown'`
    )
    .get(fromMs) as UnpricedRow;

  return {
    cost_usd:          row?.cost_usd          ?? 0,
    billable_tokens:   row?.billable_tokens   ?? 0,
    tokens:            row?.tokens            ?? 0,
    cached_tokens:     row?.cached_tokens     ?? 0,
    cached_cost_usd:   row?.cached_cost_usd   ?? 0,
    cache_savings_usd: row?.cache_savings_usd ?? 0,
    turns:             row?.turns             ?? 0,
    sessions:          row?.sessions          ?? 0,
    unpriced_count:    unpriced.n,
  };
}

function queryCostBucketForSession(db: Database.Database, sessionId: string): CostBucket {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(cost_total_micros), 0) / 1000000.0 AS cost_usd,
         COALESCE(SUM(input_tokens + output_tokens), 0)  AS billable_tokens,
         COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS tokens,
         COALESCE(SUM(cache_read_tokens + cache_write_tokens), 0) AS cached_tokens,
         COALESCE(SUM(cost_cache_read_micros + cost_cache_write_micros), 0) / 1000000.0 AS cached_cost_usd,
         COALESCE(SUM(
           CASE WHEN input_tokens > 0
             THEN (cache_read_tokens + cache_write_tokens) * (cost_input_micros * 1.0 / input_tokens)
                  - (cost_cache_read_micros + cost_cache_write_micros)
             ELSE 0
           END
         ), 0) / 1000000.0 AS cache_savings_usd,
         COUNT(DISTINCT turn_id)    AS turns,
         COUNT(DISTINCT session_id) AS sessions
       FROM llm_messages
       WHERE session_id = ? AND cost_source != 'unknown'`
    )
    .get(sessionId) as BucketRow | undefined;

  const unpriced = db
    .prepare(
      `SELECT COUNT(*) AS n FROM llm_messages
       WHERE session_id = ? AND cost_source = 'unknown'`
    )
    .get(sessionId) as UnpricedRow;

  return {
    cost_usd:          row?.cost_usd          ?? 0,
    billable_tokens:   row?.billable_tokens   ?? 0,
    tokens:            row?.tokens            ?? 0,
    cached_tokens:     row?.cached_tokens     ?? 0,
    cached_cost_usd:   row?.cached_cost_usd   ?? 0,
    cache_savings_usd: row?.cache_savings_usd ?? 0,
    turns:             row?.turns             ?? 0,
    sessions:          row?.sessions          ?? 0,
    unpriced_count:    unpriced.n,
  };
}

export function queryTabSummary(db: Database.Database, since?: UsageSince): unknown {
  const today = queryCostBucket(db, startOfDayLocal(0));
  const week  = queryCostBucket(db, startOfDayLocal(6));
  const month = queryCostBucket(db, startOfDayLocal(29));

  // Latest session
  const lastSession = db
    .prepare("SELECT id FROM sessions ORDER BY started_at DESC LIMIT 1")
    .get() as { id: string } | undefined;
  const session = lastSession
    ? queryCostBucketForSession(db, lastSession.id)
    : { cost_usd: 0, billable_tokens: 0, tokens: 0, cached_tokens: 0, cached_cost_usd: 0, cache_savings_usd: 0, turns: 0, sessions: 0, unpriced_count: 0 };

  // Top model in the `since` window
  const fromMs = sinceToMs(since);
  const topModel = db
    .prepare(
      `SELECT
         COALESCE(m.model_id, t.model_id, 'unattributed') AS model_id,
         COALESCE(SUM(m.cost_total_micros), 0) / 1000000.0 AS cost_usd,
         COUNT(DISTINCT t.id) AS turns
       FROM llm_messages m
       LEFT JOIN turns t ON t.id = m.turn_id
       WHERE m.ts >= ? AND m.cost_source != 'unknown'
       GROUP BY 1
       ORDER BY cost_usd DESC
       LIMIT 1`
    )
    .get(fromMs) as { model_id: string; cost_usd: number; turns: number } | undefined;

  // Registered harnesses
  const harnesses = db
    .prepare("SELECT name, display_name, last_seen_at FROM harnesses ORDER BY last_seen_at DESC")
    .all() as Array<{ name: string; display_name: string; last_seen_at: number }>;

  return {
    today,
    week,
    month,
    session,
    top_model: topModel == null ? null : { ...topModel, id: topModel.model_id },
    harnesses,
  };
}

// ---------------------------------------------------------------------------
// Models tab
// ---------------------------------------------------------------------------

export function queryTabModels(db: Database.Database, since?: UsageSince): unknown {
  const fromMs = sinceToMs(since);
  const rows = db
    .prepare(
      `SELECT
         COALESCE(NULLIF(m.model_id, ''), NULLIF(t.model_id, ''), 'unattributed') AS model_id,
         COALESCE(SUM(m.cost_total_micros), 0) / 1000000.0 AS cost_usd,
         COALESCE(SUM(m.input_tokens + m.output_tokens), 0) AS billable_tokens,
         COALESCE(SUM(m.input_tokens + m.cache_read_tokens + m.cache_write_tokens), 0) AS tokens_in,
         COALESCE(SUM(m.cache_read_tokens), 0) AS cache_read_tokens,
         COALESCE(SUM(m.cache_write_tokens), 0) AS cache_write_tokens,
         COALESCE(SUM(m.cache_read_tokens + m.cache_write_tokens), 0) AS cached_tokens,
         COALESCE(SUM(m.cost_cache_read_micros + m.cost_cache_write_micros), 0) / 1000000.0 AS cached_cost_usd,
         COALESCE(SUM(m.input_tokens + m.output_tokens
                    + m.cache_read_tokens + m.cache_write_tokens), 0) AS total_tokens,
         COALESCE(SUM(m.output_tokens), 0) AS output_tokens,
         COUNT(DISTINCT m.turn_id) AS turns,
         m.harness_id
       FROM llm_messages m
       LEFT JOIN turns t ON t.id = m.turn_id
       WHERE m.ts >= ? AND m.cost_source != 'unknown'
       GROUP BY 1, m.harness_id
       ORDER BY cost_usd DESC
       LIMIT 20`
    )
    .all(fromMs) as Array<{
      model_id: string;
      cost_usd: number;
      billable_tokens: number;
      tokens_in: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      cached_tokens: number;
      cached_cost_usd: number;
      total_tokens: number;
      output_tokens: number;
      turns: number;
      harness_id: string;
    }>;

  const unpricedCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM llm_messages
         WHERE ts >= ? AND cost_source = 'unknown'`
      )
      .get(fromMs) as UnpricedRow
  ).n;

  const totalCost = rows.reduce((s, r) => s + r.cost_usd, 0);

  return {
    rows: rows.map((r) => ({
      model_id:        r.model_id,
      harness_id:      r.harness_id,
      cost_usd:        r.cost_usd,
      billable_tokens: r.billable_tokens,
      tokens_in:       r.tokens_in,
      tokens_out:      r.output_tokens,
      cached_tokens:   r.cached_tokens,
      cache_read_tokens: r.cache_read_tokens,
      cache_write_tokens: r.cache_write_tokens,
      cache_hit_rate:  r.tokens_in > 0 ? r.cached_tokens / r.tokens_in : 0,
      cached_cost_usd: r.cached_cost_usd,
      output_tokens:   r.output_tokens,
      turns:           r.turns,
      share:           totalCost > 0 ? r.cost_usd / totalCost : 0,
      avg_tokens_per_turn: r.turns > 0 ? r.total_tokens / r.turns : 0,
    })),
    unpriced_count: unpricedCount,
  };
}

// ---------------------------------------------------------------------------
// Repos tab
// ---------------------------------------------------------------------------

export function queryTabRepos(db: Database.Database, since?: UsageSince): unknown {
  const fromMs = sinceToMs(since);

  const rows = db
    .prepare(
      `SELECT
         CASE
           WHEN s.repo_owner IS NOT NULL AND s.repo_name IS NOT NULL
             THEN s.repo_owner || '/' || s.repo_name
           WHEN s.repo_remote IS NOT NULL THEN s.repo_remote
           WHEN s.cwd IS NOT NULL THEN s.cwd
           ELSE 'unknown'
         END AS repo,
         m.harness_id,
         COALESCE(SUM(m.cost_total_micros), 0) / 1000000.0 AS cost_usd,
         COALESCE(SUM(m.input_tokens + m.output_tokens), 0) AS billable_tokens,
         COUNT(DISTINCT m.session_id) AS sessions
       FROM llm_messages m
       LEFT JOIN sessions s ON s.id = m.session_id
       WHERE m.ts >= ? AND m.cost_source != 'unknown'
       GROUP BY repo, m.harness_id
       ORDER BY cost_usd DESC
       LIMIT 20`
    )
    .all(fromMs) as Array<{
      repo: string;
      harness_id: string;
      cost_usd: number;
      billable_tokens: number;
      sessions: number;
    }>;

  const toolRows = db
    .prepare(
      `SELECT
         CASE
           WHEN s.repo_owner IS NOT NULL AND s.repo_name IS NOT NULL
             THEN s.repo_owner || '/' || s.repo_name
           WHEN s.repo_remote IS NOT NULL THEN s.repo_remote
           WHEN s.cwd IS NOT NULL THEN s.cwd
           ELSE 'unknown'
         END AS repo,
         tc.tool_name AS tool_name,
         COUNT(*) AS calls
       FROM tool_calls tc
       LEFT JOIN sessions s ON s.id = tc.session_id
       WHERE tc.started_at >= ?
       GROUP BY repo, tc.tool_name`
    )
    .all(fromMs) as Array<{ repo: string; tool_name: string; calls: number }>;

  const topToolByRepo = new Map<string, string>();
  const topToolCallsByRepo = new Map<string, number>();
  for (const row of toolRows) {
    if (row.calls > (topToolCallsByRepo.get(row.repo) ?? -1)) {
      topToolByRepo.set(row.repo, row.tool_name);
      topToolCallsByRepo.set(row.repo, row.calls);
    }
  }

  return {
    rows: rows.map((row) => ({
      ...row,
      repo_remote: row.repo,
      files_touched: 0,
      top_tool: topToolByRepo.get(row.repo) ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Tools tab
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor((sorted.length - 1) * (p / 100));
  return sorted[idx] ?? 0;
}

export function queryTabTools(db: Database.Database, since?: UsageSince): unknown {
  const fromMs = sinceToMs(since);

  // Fetch all rows so we can compute p50/p95 latency in JS from sorted arrays.
  // For large datasets this may be slow; replace with approx_percentile if needed.
  const allRows = db
    .prepare(
      `SELECT tool_name, started_at, ended_at, is_error
       FROM tool_calls
       WHERE started_at >= ?
       ORDER BY tool_name, started_at`
    )
    .all(fromMs) as Array<{
      tool_name: string;
      started_at: number;
      ended_at: number | null;
      is_error: number;
    }>;

  // Group by tool_name.
  const grouped = new Map<string, { durations: number[]; errors: number }>();
  for (const r of allRows) {
    let g = grouped.get(r.tool_name);
    if (g == null) {
      g = { durations: [], errors: 0 };
      grouped.set(r.tool_name, g);
    }
    // Only include durations when ended_at is present.
    if (r.ended_at != null) {
      g.durations.push(r.ended_at - r.started_at);
    }
    if (r.is_error !== 0) g.errors++;
  }

  const rows = Array.from(grouped.entries())
    .map(([name, g]) => {
      const sorted = [...g.durations].sort((a, b) => a - b);
      const calls = allRows.filter((r) => r.tool_name === name).length;
      return {
        tool_name:         name,
        name,
        calls,
        errors:            g.errors,
        error_rate:        calls > 0 ? g.errors / calls : 0,
        total_duration_ms: g.durations.reduce((s, d) => s + d, 0),
        p50_ms:            percentile(sorted, 50),
        p95_ms:            percentile(sorted, 95),
      };
    })
    .sort((a, b) => b.calls - a.calls);

  return { rows };
}

// ---------------------------------------------------------------------------
// PRs tab  — not available in the central schema MVP
// ---------------------------------------------------------------------------

/**
 * The central schema does not include pr_associations, commits_made, or
 * files_touched — those tables belong to the legacy Pi extension's private
 * schema. PR tracking will be added to the central schema in a future
 * migration once the Pi writer extension emits structured PR data.
 */
export function queryTabPrs(_db: Database.Database, _since?: UsageSince): unknown {
  return {
    rows: [],
    note:
      "PR tracking is not yet available in the central ToTally schema. " +
      "It will appear here once the Pi writer extension supports it.",
  };
}

// ---------------------------------------------------------------------------
// Daily tab
// ---------------------------------------------------------------------------

export function queryTabDaily(db: Database.Database, since?: UsageSince): unknown {
  const fromMs = sinceToMs(since);
  const rows = db
    .prepare(
      `SELECT
         date(ts / 1000, 'unixepoch', 'localtime') AS date,
         COALESCE(SUM(cost_total_micros), 0) / 1000000.0 AS cost_usd,
         COALESCE(SUM(input_tokens + output_tokens), 0) AS billable_tokens,
         COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS tokens,
         COALESCE(SUM(cache_read_tokens + cache_write_tokens), 0) AS cached_tokens,
         COALESCE(SUM(cost_cache_read_micros + cost_cache_write_micros), 0) / 1000000.0 AS cached_cost_usd,
         COUNT(DISTINCT turn_id) AS turns
       FROM llm_messages
       WHERE ts >= ? AND cost_source != 'unknown'
       GROUP BY date
       ORDER BY date DESC
       LIMIT 90`
    )
    .all(fromMs) as Array<{
      date: string;
      cost_usd: number;
      billable_tokens: number;
      tokens: number;
      cached_tokens: number;
      cached_cost_usd: number;
      turns: number;
    }>;

  const unpricedCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM llm_messages
         WHERE ts >= ? AND cost_source = 'unknown'`
      )
      .get(fromMs) as UnpricedRow
  ).n;

  return { rows, unpriced_count: unpricedCount };
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

/**
 * Runs the appropriate query for the given tab and returns a JSON-serialisable
 * result object.
 */
export function runQuery(
  db: Database.Database,
  args: { tab?: UsageTab; since?: UsageSince }
): unknown {
  const tab = args.tab ?? "summary";
  switch (tab) {
    case "summary": return queryTabSummary(db, args.since);
    case "models":  return queryTabModels(db, args.since);
    case "repos":   return queryTabRepos(db, args.since);
    case "tools":   return queryTabTools(db, args.since);
    case "prs":     return queryTabPrs(db, args.since);
    case "daily":   return queryTabDaily(db, args.since);
  }
}
