/**
 * Core analytics query functions for the ToTally central SQLite store.
 *
 * All functions accept an injected better-sqlite3 Database and never open
 * connections themselves — connection lifecycle belongs to each client.
 *
 * COST SEMANTICS
 *   - Tokens/turns/sessions/messages counts include ALL rows regardless of cost_source.
 *   - Cost sums exclude cost_source='unknown' rows (CASE guard).
 *   - unpriced_count is returned separately so callers can show "N unpriced messages".
 *   - Cost is stored as integer micro-dollars; queries divide by 1_000_000.0 at
 *     the boundary to produce display USD.
 *
 * DRIFT FIXES applied here vs the prior per-client implementations:
 *   1. share denominators: computed from an ungrouped full-window total, not
 *      the returned top-N rows.  Summing cost over the LIMIT 20 result set
 *      makes shares sum to >1 when there are more than 20 groups.
 *   2. Repo grouping guard: NULLIF(owner,'') / NULLIF(name,'') so empty-string
 *      owners can no longer produce '/' group keys.
 *   3. avg_tokens_per_turn = billable_tokens / turns (input+output only, no
 *      cache tokens).  Prior Pi implementation used total_tokens which inflated
 *      averages for cache-heavy workloads.
 *   4. queryTools groups in a single O(n) pass.  Prior Pi implementation
 *      re-filtered allRows per tool name, producing O(n×m) work.
 *   5. cache_savings_usd floored at 0.  The raw estimate can be slightly
 *      negative on cache-write-heavy messages; consumers see the estimate,
 *      never a confusing negative savings figure.
 */

import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Shared query options
// ---------------------------------------------------------------------------

export type QueryOpts = {
  /** Lower bound timestamp, Unix milliseconds (inclusive). */
  from: number;
  /** Upper bound timestamp, Unix milliseconds (inclusive). */
  to: number;
  /** When set, restrict to these harness IDs. Empty / absent means all. */
  harnesses?: string[];
  /** Substring filter on model_id. */
  model?: string;
  /** Substring filter on derived repo string. */
  repo?: string;
};

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type CostBucket = {
  cost_usd: number;
  billable_tokens: number;
  /** Total input + output + cache_read + cache_write tokens. */
  tokens: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cached_cost_usd: number;
  /**
   * Estimated prompt-caching savings: (cache_tokens × effective_input_rate) − actual_cache_cost.
   * Floored at 0 — tiny input_token denominators can produce a slightly negative raw value.
   * This is an estimate, not an accounting figure.
   */
  cache_savings_usd: number;
  turns: number;
  sessions: number;
  messages: number;
  unpriced_count: number;
};

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

export type HourlyRow = Omit<DailyRow, "date"> & { hour: string };

export type ComponentRow = {
  component: "input" | "output" | "cache_read" | "cache_write";
  label: string;
  tokens: number;
  cost_usd: number;
  token_share: number;
  cost_share: number;
  cost_per_mtok: number;
};

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
  /** Fraction of total window cost; denominator is the full-window ungrouped total (not top-N). */
  share: number;
  /** billable_tokens / turns — input+output only, cache tokens excluded (fix 3). */
  avg_tokens_per_turn: number;
};

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

export type ToolRow = {
  tool_name: string;
  calls: number;
  errors: number;
  error_rate: number;
  total_duration_ms: number;
  p50_ms: number;
  p95_ms: number;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildHarnessFilter(
  harnesses: string[] | undefined,
): { clause: string; params: string[] } {
  if (!harnesses || harnesses.length === 0) return { clause: "", params: [] };
  const placeholders = harnesses.map(() => "?").join(", ");
  return { clause: `AND m.harness_id IN (${placeholders})`, params: harnesses };
}

function buildHarnessFilterDirect(
  harnesses: string[] | undefined,
  alias = "",
): { clause: string; params: string[] } {
  if (!harnesses || harnesses.length === 0) return { clause: "", params: [] };
  const col = alias ? `${alias}.harness_id` : "harness_id";
  const placeholders = harnesses.map(() => "?").join(", ");
  return { clause: `AND ${col} IN (${placeholders})`, params: harnesses };
}

/**
 * Repo label expression used consistently across all queries.
 *
 * Fix 2: NULLIF(repo_owner, '') and NULLIF(repo_name, '') treat empty strings
 * as NULL so the owner/name branch only fires when both are genuinely non-empty.
 * Without this guard, a row with repo_owner='' produces the key '/' rather
 * than falling through to repo_remote / cwd / 'unknown'.
 */
const REPO_EXPR = `CASE
  WHEN NULLIF(s.repo_owner, '') IS NOT NULL AND NULLIF(s.repo_name, '') IS NOT NULL
    THEN s.repo_owner || '/' || s.repo_name
  WHEN s.repo_remote IS NOT NULL THEN s.repo_remote
  WHEN s.cwd IS NOT NULL THEN s.cwd
  ELSE 'unknown'
END`;

/**
 * Fix 5: Floored cache savings within SUM.
 * The raw per-row estimate ((cache_tokens × input_rate) − actual_cache_cost)
 * can be slightly negative when cache prices exceed the amortised input price.
 * MAX(0, ...) floors each row before summing so the aggregate is never negative.
 */
const CACHE_SAVINGS_EXPR = `COALESCE(SUM(
  CASE WHEN cost_source != 'unknown' AND input_tokens > 0
    THEN MAX(0,
         (cache_read_tokens + cache_write_tokens) * (cost_input_micros * 1.0 / input_tokens)
         - (cost_cache_read_micros + cost_cache_write_micros))
    ELSE 0
  END
), 0) / 1000000.0`;

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
         ${CACHE_SAVINGS_EXPR} AS cache_savings_usd,
         COUNT(DISTINCT turn_id)    AS turns,
         COUNT(DISTINCT session_id) AS sessions,
         COUNT(*) AS messages
       FROM llm_messages
       WHERE ts >= ? AND ts <= ? ${hf.clause}`,
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
       WHERE ts >= ? AND ts <= ? AND cost_source = 'unknown' ${hf.clause}`,
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

export function queryCostBucketForSession(
  db: Database.Database,
  sessionId: string,
): CostBucket {
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
         ${CACHE_SAVINGS_EXPR} AS cache_savings_usd,
         COUNT(DISTINCT turn_id) AS turns,
         COUNT(DISTINCT session_id) AS sessions,
         COUNT(*) AS messages
       FROM llm_messages
       WHERE session_id = ?`,
    )
    .get(sessionId) as {
      cost_usd: number; billable_tokens: number; tokens: number;
      input_tokens: number; output_tokens: number;
      cached_tokens: number; cached_cost_usd: number; cache_savings_usd: number;
      turns: number; sessions: number; messages: number;
    } | undefined;

  const unpriced = db
    .prepare(
      `SELECT COUNT(*) AS n FROM llm_messages WHERE session_id = ? AND cost_source = 'unknown'`,
    )
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
// Summary (cost bucket + top model + top repo)
// ---------------------------------------------------------------------------

export function querySummary(
  db: Database.Database,
  opts: QueryOpts,
): CostBucket & {
  top_model: { model_id: string; cost_usd: number; turns: number } | null;
  top_repo: { repo: string; cost_usd: number } | null;
} {
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
       LIMIT 1`,
    )
    .get(opts.from, opts.to, ...hf.params) as
    | { model_id: string; cost_usd: number; turns: number }
    | undefined;

  const topRepo = db
    .prepare(
      `SELECT
         ${REPO_EXPR} AS repo,
         COALESCE(SUM(CASE WHEN m.cost_source != 'unknown' THEN m.cost_total_micros ELSE 0 END), 0) / 1000000.0 AS cost_usd
       FROM llm_messages m
       LEFT JOIN sessions s ON s.id = m.session_id
       WHERE m.ts >= ? AND m.ts <= ? ${hf.clause}
       GROUP BY repo
       ORDER BY cost_usd DESC
       LIMIT 1`,
    )
    .get(opts.from, opts.to, ...hf.params) as { repo: string; cost_usd: number } | undefined;

  return { ...bucket, top_model: topModel ?? null, top_repo: topRepo ?? null };
}

// ---------------------------------------------------------------------------
// Daily breakdown
// ---------------------------------------------------------------------------

export function queryDaily(
  db: Database.Database,
  opts: QueryOpts,
): { rows: DailyRow[]; unpriced_count: number } {
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
       ORDER BY date ASC`,
    )
    .all(opts.from, opts.to, ...hf.params) as DailyRow[];

  const unpriced = db
    .prepare(
      `SELECT COUNT(*) AS n FROM llm_messages
       WHERE ts >= ? AND ts <= ? AND cost_source = 'unknown' ${hf.clause}`,
    )
    .get(opts.from, opts.to, ...hf.params) as { n: number };

  return { rows, unpriced_count: unpriced.n };
}

// ---------------------------------------------------------------------------
// Hourly breakdown
// ---------------------------------------------------------------------------

export function queryHourly(
  db: Database.Database,
  opts: QueryOpts,
): { rows: HourlyRow[]; unpriced_count: number } {
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
       ORDER BY hour ASC`,
    )
    .all(opts.from, opts.to, ...hf.params) as HourlyRow[];

  const unpriced = db
    .prepare(
      `SELECT COUNT(*) AS n FROM llm_messages
       WHERE ts >= ? AND ts <= ? AND cost_source = 'unknown' ${hf.clause}`,
    )
    .get(opts.from, opts.to, ...hf.params) as { n: number };

  return { rows, unpriced_count: unpriced.n };
}

// ---------------------------------------------------------------------------
// Components (cost breakdown by input/output/cache_read/cache_write)
// ---------------------------------------------------------------------------

export function queryComponents(
  db: Database.Database,
  opts: QueryOpts,
): { rows: ComponentRow[] } {
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
       WHERE ts >= ? AND ts <= ? AND cost_source != 'unknown' ${hf.clause}`,
    )
    .get(opts.from, opts.to, ...hf.params) as {
      input_tokens: number; output_tokens: number;
      cache_read_tokens: number; cache_write_tokens: number;
      cost_input_usd: number; cost_output_usd: number;
      cost_cache_read_usd: number; cost_cache_write_usd: number;
    };

  const specs: Array<{
    component: ComponentRow["component"];
    label: string;
    tokens: number;
    cost_usd: number;
  }> = [
    { component: "input",       label: "Input",       tokens: row.input_tokens,       cost_usd: row.cost_input_usd },
    { component: "output",      label: "Output",      tokens: row.output_tokens,      cost_usd: row.cost_output_usd },
    { component: "cache_read",  label: "Cache read",  tokens: row.cache_read_tokens,  cost_usd: row.cost_cache_read_usd },
    { component: "cache_write", label: "Cache write", tokens: row.cache_write_tokens, cost_usd: row.cost_cache_write_usd },
  ];

  const totalTokens = specs.reduce((sum, item) => sum + item.tokens, 0);
  const totalCost = specs.reduce((sum, item) => sum + item.cost_usd, 0);

  return {
    rows: specs.map((item) => ({
      ...item,
      token_share:   totalTokens > 0 ? item.tokens  / totalTokens : 0,
      cost_share:    totalCost   > 0 ? item.cost_usd / totalCost  : 0,
      cost_per_mtok: item.tokens  > 0 ? item.cost_usd / item.tokens * 1_000_000 : 0,
    })),
  };
}

// ---------------------------------------------------------------------------
// Models breakdown
// ---------------------------------------------------------------------------

export function queryModels(
  db: Database.Database,
  opts: QueryOpts,
): { rows: ModelRow[]; unpriced_count: number } {
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
         COALESCE(SUM(m.output_tokens), 0) AS output_tokens,
         COUNT(DISTINCT m.turn_id) AS turns,
         m.harness_id
       FROM llm_messages m
       LEFT JOIN turns t ON t.id = m.turn_id
       WHERE m.ts >= ? AND m.ts <= ? ${hf.clause} ${modelClause}
       GROUP BY 1, m.harness_id
       ORDER BY cost_usd DESC
       LIMIT 20`,
    )
    .all(opts.from, opts.to, ...hf.params, ...modelParams) as Array<{
      model_id: string; cost_usd: number; billable_tokens: number;
      tokens_in: number; cache_read_tokens: number; cache_write_tokens: number;
      cached_tokens: number; cached_cost_usd: number; output_tokens: number;
      turns: number; harness_id: string;
    }>;

  // Fix 1: compute the share denominator from the full window, not from the
  // returned top-20 rows.  Summing cost over the LIMIT result makes shares
  // sum to >1 when there are more than 20 models in the window.
  const windowTotalRow = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN m.cost_source != 'unknown' THEN m.cost_total_micros ELSE 0 END), 0) / 1000000.0 AS total_cost_usd
       FROM llm_messages m
       LEFT JOIN turns t ON t.id = m.turn_id
       WHERE m.ts >= ? AND m.ts <= ? ${hf.clause} ${modelClause}`,
    )
    .get(opts.from, opts.to, ...hf.params, ...modelParams) as { total_cost_usd: number };
  const totalWindowCost = windowTotalRow.total_cost_usd;

  const unpriced = db
    .prepare(
      `SELECT COUNT(*) AS n FROM llm_messages m
       WHERE m.ts >= ? AND m.ts <= ? AND m.cost_source = 'unknown' ${hf.clause}`,
    )
    .get(opts.from, opts.to, ...hf.params) as { n: number };

  return {
    rows: rows.map((r) => ({
      model_id:          r.model_id,
      harness_id:        r.harness_id,
      cost_usd:          r.cost_usd,
      billable_tokens:   r.billable_tokens,
      tokens_in:         r.tokens_in,
      tokens_out:        r.output_tokens,
      cached_tokens:     r.cached_tokens,
      cache_read_tokens: r.cache_read_tokens,
      cache_write_tokens: r.cache_write_tokens,
      cache_hit_rate:    r.tokens_in > 0 ? r.cached_tokens / r.tokens_in : 0,
      cached_cost_usd:   r.cached_cost_usd,
      turns:             r.turns,
      // Fix 1: use full-window total as denominator.
      share:             totalWindowCost > 0 ? r.cost_usd / totalWindowCost : 0,
      // Fix 3: avg = billable_tokens / turns (input+output only, no cache tokens).
      avg_tokens_per_turn: r.turns > 0 ? r.billable_tokens / r.turns : 0,
    })),
    unpriced_count: unpriced.n,
  };
}

// ---------------------------------------------------------------------------
// Repos breakdown
// ---------------------------------------------------------------------------

export function queryRepos(
  db: Database.Database,
  opts: QueryOpts,
): { rows: RepoRow[] } {
  const hf = buildHarnessFilter(opts.harnesses);
  const repoClause = opts.repo ? `AND ${REPO_EXPR} LIKE ?` : "";
  const repoParams = opts.repo ? [`%${opts.repo}%`] : [];

  const rows = db
    .prepare(
      `SELECT
         ${REPO_EXPR} AS repo,
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
       LIMIT 20`,
    )
    .all(opts.from, opts.to, ...hf.params, ...repoParams) as Array<{
      repo: string; harness_id: string; cost_usd: number;
      billable_tokens: number; tokens: number; output_tokens: number;
      cached_tokens: number; sessions: number;
    }>;

  // Find the top tool per repo from the tool_calls table.
  const toolHf = buildHarnessFilterDirect(opts.harnesses, "tc");
  const toolRows = db
    .prepare(
      `SELECT
         ${REPO_EXPR} AS repo,
         tc.tool_name,
         COUNT(*) AS calls
       FROM tool_calls tc
       LEFT JOIN sessions s ON s.id = tc.session_id
       WHERE tc.started_at >= ? AND tc.started_at <= ? ${toolHf.clause} ${repoClause}
       GROUP BY repo, tc.tool_name`,
    )
    .all(opts.from, opts.to, ...toolHf.params, ...repoParams) as Array<{
      repo: string; tool_name: string; calls: number;
    }>;

  // Build top-tool map in a single pass.
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
// Tools breakdown
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor((sorted.length - 1) * (p / 100));
  return sorted[idx] ?? 0;
}

export function queryTools(
  db: Database.Database,
  opts: QueryOpts,
): { rows: ToolRow[] } {
  const hf = buildHarnessFilterDirect(opts.harnesses);

  const allRows = db
    .prepare(
      `SELECT tool_name, started_at, ended_at, is_error
       FROM tool_calls
       WHERE started_at >= ? AND started_at <= ? ${hf.clause}
       ORDER BY tool_name, started_at`,
    )
    .all(opts.from, opts.to, ...hf.params) as Array<{
      tool_name: string; started_at: number; ended_at: number | null; is_error: number;
    }>;

  // Fix 4: group in a single O(n) pass — track calls count directly in the
  // grouped map instead of re-filtering allRows per tool name (O(n×m)).
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
