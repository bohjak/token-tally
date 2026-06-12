/**
 * Analytics query functions adapted from clients/pi-usage-command/src/queries.ts.
 *
 * Key differences from the Pi command version:
 * - Accepts { from, to, harnesses? } instead of UsageSince enum
 * - `from` and `to` are Unix milliseconds
 * - `harnesses` filters by harness_id (empty/undefined = all)
 */

import type Database from "better-sqlite3";

export type QueryOpts = {
  from: number;
  to: number;
  harnesses?: string[];
  model?: string;
  repo?: string;
};

export type CostBucket = {
  cost_usd: number;
  billable_tokens: number;
  tokens: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cached_cost_usd: number;
  cache_savings_usd: number;
  turns: number;
  sessions: number;
  messages: number;
  unpriced_count: number;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildHarnessFilter(harnesses: string[] | undefined): { clause: string; params: string[] } {
  if (!harnesses || harnesses.length === 0) return { clause: "", params: [] };
  const placeholders = harnesses.map(() => "?").join(", ");
  return { clause: `AND m.harness_id IN (${placeholders})`, params: harnesses };
}

function buildHarnessFilterDirect(harnesses: string[] | undefined, alias = ""): { clause: string; params: string[] } {
  if (!harnesses || harnesses.length === 0) return { clause: "", params: [] };
  const col = alias ? `${alias}.harness_id` : "harness_id";
  const placeholders = harnesses.map(() => "?").join(", ");
  return { clause: `AND ${col} IN (${placeholders})`, params: harnesses };
}

// ---------------------------------------------------------------------------
// Cost bucket
// ---------------------------------------------------------------------------

export function queryCostBucket(db: Database.Database, opts: QueryOpts): CostBucket {
  const { from, to, harnesses } = opts;
  const hf = buildHarnessFilterDirect(harnesses, "");

  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN cost_source != 'unknown' THEN cost_total_micros ELSE 0 END), 0) / 1000000.0 AS cost_usd,
         COALESCE(SUM(input_tokens + output_tokens), 0) AS billable_tokens,
         COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS tokens,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(cache_read_tokens + cache_write_tokens), 0) AS cached_tokens,
         COALESCE(SUM(CASE WHEN cost_source != 'unknown' THEN cost_cache_read_micros + cost_cache_write_micros ELSE 0 END), 0) / 1000000.0 AS cached_cost_usd,
         COALESCE(SUM(
           CASE WHEN cost_source != 'unknown' AND input_tokens > 0
             THEN (cache_read_tokens + cache_write_tokens) * (cost_input_micros * 1.0 / input_tokens)
                  - (cost_cache_read_micros + cost_cache_write_micros)
             ELSE 0
           END
         ), 0) / 1000000.0 AS cache_savings_usd,
         COUNT(DISTINCT turn_id)    AS turns,
         COUNT(DISTINCT session_id) AS sessions,
         COUNT(*) AS messages
       FROM llm_messages
       WHERE ts >= ? AND ts <= ? ${hf.clause}`
    )
    .get(from, to, ...hf.params) as {
      cost_usd: number; billable_tokens: number; tokens: number;
      input_tokens: number; output_tokens: number;
      cached_tokens: number; cached_cost_usd: number; cache_savings_usd: number;
      turns: number; sessions: number; messages: number;
    } | undefined;

  const unpriced = db
    .prepare(
      `SELECT COUNT(*) AS n FROM llm_messages
       WHERE ts >= ? AND ts <= ? AND cost_source = 'unknown' ${hf.clause}`
    )
    .get(from, to, ...hf.params) as { n: number };

  return {
    cost_usd:          row?.cost_usd          ?? 0,
    billable_tokens:   row?.billable_tokens   ?? 0,
    tokens:            row?.tokens            ?? 0,
    input_tokens:      row?.input_tokens      ?? 0,
    output_tokens:     row?.output_tokens     ?? 0,
    cached_tokens:     row?.cached_tokens     ?? 0,
    cached_cost_usd:   row?.cached_cost_usd   ?? 0,
    cache_savings_usd: row?.cache_savings_usd ?? 0,
    turns:             row?.turns             ?? 0,
    sessions:          row?.sessions          ?? 0,
    messages:          row?.messages          ?? 0,
    unpriced_count:    unpriced.n,
  };
}

export function queryCostBucketForSession(db: Database.Database, sessionId: string): CostBucket {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN cost_source != 'unknown' THEN cost_total_micros ELSE 0 END), 0) / 1000000.0 AS cost_usd,
         COALESCE(SUM(input_tokens + output_tokens), 0) AS billable_tokens,
         COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS tokens,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(cache_read_tokens + cache_write_tokens), 0) AS cached_tokens,
         COALESCE(SUM(CASE WHEN cost_source != 'unknown' THEN cost_cache_read_micros + cost_cache_write_micros ELSE 0 END), 0) / 1000000.0 AS cached_cost_usd,
         COALESCE(SUM(
           CASE WHEN cost_source != 'unknown' AND input_tokens > 0
             THEN (cache_read_tokens + cache_write_tokens) * (cost_input_micros * 1.0 / input_tokens)
                  - (cost_cache_read_micros + cost_cache_write_micros)
             ELSE 0
           END
         ), 0) / 1000000.0 AS cache_savings_usd,
         COUNT(DISTINCT turn_id) AS turns,
         COUNT(DISTINCT session_id) AS sessions,
         COUNT(*) AS messages
       FROM llm_messages
       WHERE session_id = ?`
    )
    .get(sessionId) as {
      cost_usd: number; billable_tokens: number; tokens: number;
      input_tokens: number; output_tokens: number;
      cached_tokens: number; cached_cost_usd: number; cache_savings_usd: number;
      turns: number; sessions: number; messages: number;
    } | undefined;

  const unpriced = db
    .prepare(`SELECT COUNT(*) AS n FROM llm_messages WHERE session_id = ? AND cost_source = 'unknown'`)
    .get(sessionId) as { n: number };

  return {
    cost_usd:          row?.cost_usd          ?? 0,
    billable_tokens:   row?.billable_tokens   ?? 0,
    tokens:            row?.tokens            ?? 0,
    input_tokens:      row?.input_tokens      ?? 0,
    output_tokens:     row?.output_tokens     ?? 0,
    cached_tokens:     row?.cached_tokens     ?? 0,
    cached_cost_usd:   row?.cached_cost_usd   ?? 0,
    cache_savings_usd: row?.cache_savings_usd ?? 0,
    turns:             row?.turns             ?? 0,
    sessions:          row?.sessions          ?? 0,
    messages:          row?.messages          ?? 0,
    unpriced_count:    unpriced.n,
  };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export function querySummary(db: Database.Database, opts: QueryOpts) {
  const bucket = queryCostBucket(db, opts);

  const hf = buildHarnessFilter(opts.harnesses);
  const topModel = db
    .prepare(
      `SELECT
         COALESCE(m.model_id, t.model_id, 'unattributed') AS model_id,
         COALESCE(SUM(CASE WHEN m.cost_source != 'unknown' THEN m.cost_total_micros ELSE 0 END), 0) / 1000000.0 AS cost_usd,
         COUNT(DISTINCT t.id) AS turns
       FROM llm_messages m
       LEFT JOIN turns t ON t.id = m.turn_id
       WHERE m.ts >= ? AND m.ts <= ? ${hf.clause}
       GROUP BY 1
       ORDER BY cost_usd DESC
       LIMIT 1`
    )
    .get(opts.from, opts.to, ...hf.params) as
    | { model_id: string; cost_usd: number; turns: number }
    | undefined;

  const topRepo = db
    .prepare(
      `SELECT
         CASE
           WHEN s.repo_owner IS NOT NULL AND s.repo_name IS NOT NULL
             THEN s.repo_owner || '/' || s.repo_name
           WHEN s.repo_remote IS NOT NULL THEN s.repo_remote
           WHEN s.cwd IS NOT NULL THEN s.cwd
           ELSE 'unknown'
         END AS repo,
         COALESCE(SUM(CASE WHEN m.cost_source != 'unknown' THEN m.cost_total_micros ELSE 0 END), 0) / 1000000.0 AS cost_usd
       FROM llm_messages m
       LEFT JOIN sessions s ON s.id = m.session_id
       WHERE m.ts >= ? AND m.ts <= ? ${hf.clause}
       GROUP BY repo
       ORDER BY cost_usd DESC
       LIMIT 1`
    )
    .get(opts.from, opts.to, ...hf.params) as { repo: string; cost_usd: number } | undefined;

  return { ...bucket, top_model: topModel ?? null, top_repo: topRepo ?? null };
}

// ---------------------------------------------------------------------------
// Daily
// ---------------------------------------------------------------------------

export type DailyRow = {
  date: string;
  cost_usd: number;
  billable_tokens: number;
  tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cached_tokens: number;
  cached_cost_usd: number;
  turns: number;
  messages: number;
};

export function queryDaily(db: Database.Database, opts: QueryOpts): { rows: DailyRow[]; unpriced_count: number } {
  const hf = buildHarnessFilterDirect(opts.harnesses);

  const rows = db
    .prepare(
      `SELECT
         date(ts / 1000, 'unixepoch', 'localtime') AS date,
         COALESCE(SUM(CASE WHEN cost_source != 'unknown' THEN cost_total_micros ELSE 0 END), 0) / 1000000.0 AS cost_usd,
         COALESCE(SUM(input_tokens + output_tokens), 0) AS billable_tokens,
         COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS tokens,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
         COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
         COALESCE(SUM(cache_read_tokens + cache_write_tokens), 0) AS cached_tokens,
         COALESCE(SUM(CASE WHEN cost_source != 'unknown' THEN cost_cache_read_micros + cost_cache_write_micros ELSE 0 END), 0) / 1000000.0 AS cached_cost_usd,
         COUNT(DISTINCT turn_id) AS turns,
         COUNT(*) AS messages
       FROM llm_messages
       WHERE ts >= ? AND ts <= ? ${hf.clause}
       GROUP BY date
       ORDER BY date ASC`
    )
    .all(opts.from, opts.to, ...hf.params) as DailyRow[];

  const unpriced = db
    .prepare(
      `SELECT COUNT(*) AS n FROM llm_messages
       WHERE ts >= ? AND ts <= ? AND cost_source = 'unknown' ${hf.clause}`
    )
    .get(opts.from, opts.to, ...hf.params) as { n: number };

  return { rows, unpriced_count: unpriced.n };
}

// ---------------------------------------------------------------------------
// Components / hourly
// ---------------------------------------------------------------------------

export type ComponentRow = {
  component: "input" | "output" | "cache_read" | "cache_write";
  label: string;
  tokens: number;
  cost_usd: number;
  token_share: number;
  cost_share: number;
  cost_per_mtok: number;
};

export function queryComponents(db: Database.Database, opts: QueryOpts): { rows: ComponentRow[] } {
  const hf = buildHarnessFilterDirect(opts.harnesses);
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
         COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
         COALESCE(SUM(cost_input_micros), 0) / 1000000.0 AS cost_input_usd,
         COALESCE(SUM(cost_output_micros), 0) / 1000000.0 AS cost_output_usd,
         COALESCE(SUM(cost_cache_read_micros), 0) / 1000000.0 AS cost_cache_read_usd,
         COALESCE(SUM(cost_cache_write_micros), 0) / 1000000.0 AS cost_cache_write_usd
       FROM llm_messages
       WHERE ts >= ? AND ts <= ? AND cost_source != 'unknown' ${hf.clause}`
    )
    .get(opts.from, opts.to, ...hf.params) as {
      input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number;
      cost_input_usd: number; cost_output_usd: number; cost_cache_read_usd: number; cost_cache_write_usd: number;
    };

  const specs: Array<{ component: ComponentRow["component"]; label: string; tokens: number; cost_usd: number }> = [
    { component: "input", label: "Input", tokens: row.input_tokens, cost_usd: row.cost_input_usd },
    { component: "output", label: "Output", tokens: row.output_tokens, cost_usd: row.cost_output_usd },
    { component: "cache_read", label: "Cache read", tokens: row.cache_read_tokens, cost_usd: row.cost_cache_read_usd },
    { component: "cache_write", label: "Cache write", tokens: row.cache_write_tokens, cost_usd: row.cost_cache_write_usd },
  ];
  const totalTokens = specs.reduce((sum, item) => sum + item.tokens, 0);
  const totalCost = specs.reduce((sum, item) => sum + item.cost_usd, 0);

  return {
    rows: specs.map((item) => ({
      ...item,
      token_share: totalTokens > 0 ? item.tokens / totalTokens : 0,
      cost_share: totalCost > 0 ? item.cost_usd / totalCost : 0,
      cost_per_mtok: item.tokens > 0 ? item.cost_usd / item.tokens * 1_000_000 : 0,
    })),
  };
}

export type HourlyRow = Omit<DailyRow, "date"> & { hour: string };

export function queryHourly(db: Database.Database, opts: QueryOpts): { rows: HourlyRow[]; unpriced_count: number } {
  const hf = buildHarnessFilterDirect(opts.harnesses);
  const rows = db
    .prepare(
      `SELECT
         strftime('%Y-%m-%d %H:00', ts / 1000, 'unixepoch', 'localtime') AS hour,
         COALESCE(SUM(CASE WHEN cost_source != 'unknown' THEN cost_total_micros ELSE 0 END), 0) / 1000000.0 AS cost_usd,
         COALESCE(SUM(input_tokens + output_tokens), 0) AS billable_tokens,
         COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS tokens,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
         COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
         COALESCE(SUM(cache_read_tokens + cache_write_tokens), 0) AS cached_tokens,
         COALESCE(SUM(CASE WHEN cost_source != 'unknown' THEN cost_cache_read_micros + cost_cache_write_micros ELSE 0 END), 0) / 1000000.0 AS cached_cost_usd,
         COUNT(DISTINCT turn_id) AS turns,
         COUNT(*) AS messages
       FROM llm_messages
       WHERE ts >= ? AND ts <= ? ${hf.clause}
       GROUP BY hour
       ORDER BY hour ASC`
    )
    .all(opts.from, opts.to, ...hf.params) as HourlyRow[];

  const unpriced = db
    .prepare(
      `SELECT COUNT(*) AS n FROM llm_messages
       WHERE ts >= ? AND ts <= ? AND cost_source = 'unknown' ${hf.clause}`
    )
    .get(opts.from, opts.to, ...hf.params) as { n: number };

  return { rows, unpriced_count: unpriced.n };
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export type ModelRow = {
  model_id: string;
  harness_id: string;
  cost_usd: number;
  billable_tokens: number;
  tokens_in: number;
  tokens_out: number;
  cached_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cache_hit_rate: number;
  cached_cost_usd: number;
  turns: number;
  share: number;
  avg_tokens_per_turn: number;
};

export function queryModels(db: Database.Database, opts: QueryOpts): { rows: ModelRow[]; unpriced_count: number } {
  const hf = buildHarnessFilter(opts.harnesses);
  const modelClause = opts.model ? "AND COALESCE(m.model_id, t.model_id, '') LIKE ?" : "";
  const modelParams = opts.model ? [`%${opts.model}%`] : [];

  const rows = db
    .prepare(
      `SELECT
         COALESCE(NULLIF(m.model_id, ''), NULLIF(t.model_id, ''), 'unattributed') AS model_id,
         COALESCE(SUM(CASE WHEN m.cost_source != 'unknown' THEN m.cost_total_micros ELSE 0 END), 0) / 1000000.0 AS cost_usd,
         COALESCE(SUM(m.input_tokens + m.output_tokens), 0) AS billable_tokens,
         COALESCE(SUM(m.input_tokens + m.cache_read_tokens + m.cache_write_tokens), 0) AS tokens_in,
         COALESCE(SUM(m.cache_read_tokens), 0) AS cache_read_tokens,
         COALESCE(SUM(m.cache_write_tokens), 0) AS cache_write_tokens,
         COALESCE(SUM(m.cache_read_tokens + m.cache_write_tokens), 0) AS cached_tokens,
         COALESCE(SUM(CASE WHEN m.cost_source != 'unknown' THEN m.cost_cache_read_micros + m.cost_cache_write_micros ELSE 0 END), 0) / 1000000.0 AS cached_cost_usd,
         COALESCE(SUM(m.input_tokens + m.output_tokens + m.cache_read_tokens + m.cache_write_tokens), 0) AS total_tokens,
         COALESCE(SUM(m.output_tokens), 0) AS output_tokens,
         COUNT(DISTINCT m.turn_id) AS turns,
         m.harness_id
       FROM llm_messages m
       LEFT JOIN turns t ON t.id = m.turn_id
       WHERE m.ts >= ? AND m.ts <= ? ${hf.clause} ${modelClause}
       GROUP BY 1, m.harness_id
       ORDER BY cost_usd DESC
       LIMIT 20`
    )
    .all(opts.from, opts.to, ...hf.params, ...modelParams) as Array<{
      model_id: string; cost_usd: number; billable_tokens: number;
      tokens_in: number; cache_read_tokens: number; cache_write_tokens: number;
      cached_tokens: number; cached_cost_usd: number; total_tokens: number;
      output_tokens: number; turns: number; harness_id: string;
    }>;

  const unpriced = db
    .prepare(
      `SELECT COUNT(*) AS n FROM llm_messages m
       WHERE m.ts >= ? AND m.ts <= ? AND m.cost_source = 'unknown' ${hf.clause}`
    )
    .get(opts.from, opts.to, ...hf.params) as { n: number };

  const totalCost = rows.reduce((s, r) => s + r.cost_usd, 0);

  return {
    rows: rows.map((r) => ({
      model_id:            r.model_id,
      harness_id:          r.harness_id,
      cost_usd:            r.cost_usd,
      billable_tokens:     r.billable_tokens,
      tokens_in:           r.tokens_in,
      tokens_out:          r.output_tokens,
      cached_tokens:       r.cached_tokens,
      cache_read_tokens:   r.cache_read_tokens,
      cache_write_tokens:  r.cache_write_tokens,
      cache_hit_rate:      r.tokens_in > 0 ? r.cached_tokens / r.tokens_in : 0,
      cached_cost_usd:     r.cached_cost_usd,
      turns:               r.turns,
      share:               totalCost > 0 ? r.cost_usd / totalCost : 0,
      avg_tokens_per_turn: r.turns > 0 ? r.billable_tokens / r.turns : 0,
    })),
    unpriced_count: unpriced.n,
  };
}

// ---------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------

export type RepoRow = {
  repo: string;
  harness_id: string;
  cost_usd: number;
  billable_tokens: number;
  tokens: number;
  output_tokens: number;
  cached_tokens: number;
  sessions: number;
  top_tool: string | null;
};

export function queryRepos(db: Database.Database, opts: QueryOpts): { rows: RepoRow[] } {
  const hf = buildHarnessFilter(opts.harnesses);
  const repoExpr = `CASE
           WHEN s.repo_owner IS NOT NULL AND s.repo_name IS NOT NULL
             THEN s.repo_owner || '/' || s.repo_name
           WHEN s.repo_remote IS NOT NULL THEN s.repo_remote
           WHEN s.cwd IS NOT NULL THEN s.cwd
           ELSE 'unknown'
         END`;
  const repoClause = opts.repo ? `AND ${repoExpr} LIKE ?` : "";
  const repoParams = opts.repo ? [`%${opts.repo}%`] : [];

  const rows = db
    .prepare(
      `SELECT
         ${repoExpr} AS repo,
         m.harness_id,
         COALESCE(SUM(CASE WHEN m.cost_source != 'unknown' THEN m.cost_total_micros ELSE 0 END), 0) / 1000000.0 AS cost_usd,
         COALESCE(SUM(m.input_tokens + m.output_tokens), 0) AS billable_tokens,
         COALESCE(SUM(m.input_tokens + m.output_tokens + m.cache_read_tokens + m.cache_write_tokens), 0) AS tokens,
         COALESCE(SUM(m.output_tokens), 0) AS output_tokens,
         COALESCE(SUM(m.cache_read_tokens + m.cache_write_tokens), 0) AS cached_tokens,
         COUNT(DISTINCT m.session_id) AS sessions
       FROM llm_messages m
       LEFT JOIN sessions s ON s.id = m.session_id
       WHERE m.ts >= ? AND m.ts <= ? ${hf.clause} ${repoClause}
       GROUP BY repo, m.harness_id
       ORDER BY cost_usd DESC
       LIMIT 20`
    )
    .all(opts.from, opts.to, ...hf.params, ...repoParams) as Array<{
      repo: string; harness_id: string; cost_usd: number;
      billable_tokens: number; tokens: number; output_tokens: number; cached_tokens: number; sessions: number;
    }>;

  const toolHf = buildHarnessFilterDirect(opts.harnesses, "tc");
  const toolRows = db
    .prepare(
      `SELECT
         ${repoExpr} AS repo,
         tc.tool_name,
         COUNT(*) AS calls
       FROM tool_calls tc
       LEFT JOIN sessions s ON s.id = tc.session_id
       WHERE tc.started_at >= ? AND tc.started_at <= ? ${toolHf.clause} ${repoClause}
       GROUP BY repo, tc.tool_name`
    )
    .all(opts.from, opts.to, ...toolHf.params, ...repoParams) as Array<{ repo: string; tool_name: string; calls: number }>;

  const topToolByRepo = new Map<string, string>();
  const topCallsByRepo = new Map<string, number>();
  for (const r of toolRows) {
    if (r.calls > (topCallsByRepo.get(r.repo) ?? -1)) {
      topToolByRepo.set(r.repo, r.tool_name);
      topCallsByRepo.set(r.repo, r.calls);
    }
  }

  return {
    rows: rows.map((r) => ({
      ...r,
      top_tool: topToolByRepo.get(r.repo) ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export type ToolRow = {
  tool_name: string;
  calls: number;
  errors: number;
  error_rate: number;
  total_duration_ms: number;
  p50_ms: number;
  p95_ms: number;
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor((sorted.length - 1) * (p / 100));
  return sorted[idx] ?? 0;
}

export function queryTools(db: Database.Database, opts: QueryOpts): { rows: ToolRow[] } {
  const hf = buildHarnessFilterDirect(opts.harnesses);

  const allRows = db
    .prepare(
      `SELECT tool_name, started_at, ended_at, is_error
       FROM tool_calls
       WHERE started_at >= ? AND started_at <= ? ${hf.clause}
       ORDER BY tool_name, started_at`
    )
    .all(opts.from, opts.to, ...hf.params) as Array<{
      tool_name: string; started_at: number; ended_at: number | null; is_error: number;
    }>;

  const grouped = new Map<string, { durations: number[]; errors: number; calls: number }>();
  for (const r of allRows) {
    let g = grouped.get(r.tool_name);
    if (g == null) {
      g = { durations: [], errors: 0, calls: 0 };
      grouped.set(r.tool_name, g);
    }
    g.calls++;
    if (r.ended_at != null) g.durations.push(r.ended_at - r.started_at);
    if (r.is_error !== 0) g.errors++;
  }

  const rows = Array.from(grouped.entries())
    .map(([name, g]) => {
      const sorted = [...g.durations].sort((a, b) => a - b);
      return {
        tool_name:         name,
        calls:             g.calls,
        errors:            g.errors,
        error_rate:        g.calls > 0 ? g.errors / g.calls : 0,
        total_duration_ms: g.durations.reduce((s, d) => s + d, 0),
        p50_ms:            percentile(sorted, 50),
        p95_ms:            percentile(sorted, 95),
      };
    })
    .sort((a, b) => b.calls - a.calls);

  return { rows };
}
