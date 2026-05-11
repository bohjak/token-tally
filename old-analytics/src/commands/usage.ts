/**
 * commands/usage.ts — T14: `/usage` command implementation
 *
 * Two entrypoints exported for T15 to wire up:
 *   - runUsageJson(sink, args)          — pure SQL aggregation, no I/O
 *   - runUsageInteractive(pi, sink, ctx) — pi command handler
 *
 * ## Interactive UI limitation
 *
 * Full tabbed TUI via ctx.ui.custom() requires importing @mariozechner/pi-tui
 * components which are not available in the analytics package's node_modules.
 * Instead, runUsageInteractive formats each tab as readable text and calls
 * ctx.ui.notify(). A proper TUI tab component can replace this in Phase 4.
 *
 * ## Time windows
 *
 * Summary always shows four fixed buckets (today=since-midnight-local,
 * week=last-7-calendar-days, month=last-30-calendar-days, session=last
 * session). All other tabs respect the `since` argument (default: "all").
 * Timestamps in the DB are Unix milliseconds.
 */

import type { SqliteSink } from "../sinks/sqlite.ts";
import type Database from "better-sqlite3";
import { parseRemoteOwnerName } from "../git/capture.ts";

/**
 * Display-friendly form of a git remote URL.  Prefer `owner/repo`; fall back
 * to a short slug derived from the URL when the regex parsing in
 * `parseRemoteOwnerName` doesn't match (which keeps the function safe for
 * exotic remotes — GitLab subgroups, internal git hosts, etc.).
 *
 *   git@github.com:make/monorepo.git           → "make/monorepo"
 *   https://github.com/make/monorepo           → "make/monorepo"
 *   https://gitlab.com/team/svc/web.git        → "team/svc/web"
 *   ssh://git@example.com:7999/proj/repo.git   → "proj/repo"
 */
function shortenRepoRemote(remote: string | null | undefined): string {
  if (!remote) return "";
  const parsed = parseRemoteOwnerName(remote);
  if (parsed && parsed.owner && parsed.name) {
    return `${parsed.owner}/${parsed.name}`;
  }
  // Fallback: strip protocol/host, drop trailing .git, keep the path body.
  return remote
    .replace(/^[a-z]+:\/\/[^/]+\//i, "")  // strip "https://host/"
    .replace(/^git@[^:]+:/, "")            // strip "git@host:"
    .replace(/\.git$/, "")
    .replace(/^\/+/, "");
}

// ── Public types ─────────────────────────────────────────────────────────────

export type UsageTab =
  | "summary"
  | "models"
  | "repos"
  | "tools"
  | "prs"
  | "daily";

export type UsageSince = "24h" | "7d" | "month" | "all";

export interface UsageArgs {
  json: boolean;
  tab?: UsageTab;
  since?: UsageSince;
}

// Minimal pi stubs so this file type-checks without @mariozechner/pi-coding-agent.
export type PiAPIStub = { on: (event: string, handler: (...a: unknown[]) => unknown) => void };
export type CtxStub = {
  ui: {
    notify: (msg: string, kind?: string) => void;
    /** Present when running interactively; absent in -p / RPC mode. */
    custom?: <T = void>(
      factory: (tui: { requestRender(): void }, theme: unknown, kb: unknown, done: (value: T) => void) => {
        render(width: number): string[];
        handleInput?(data: string): void;
        invalidate(): void;
      },
    ) => Promise<T>;
  };
};

// ── Arg parser ────────────────────────────────────────────────────────────────

const VALID_TABS = new Set<UsageTab>([
  "summary", "models", "repos", "tools", "prs", "daily",
]);
const VALID_SINCE = new Set<UsageSince>(["24h", "7d", "month", "all"]);

/**
 * Hand-rolled flag parser. Supports:
 *   --json
 *   --tab=X  or  --tab X
 *   --since=Y  or  --since Y
 * Unknown flags are silently ignored.
 */
export function parseUsageArgs(argv: string[]): UsageArgs {
  const result: UsageArgs = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
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

// ── Time helpers ──────────────────────────────────────────────────────────────

function sinceMs(since?: UsageSince): number {
  const now = Date.now();
  switch (since) {
    case "24h":   return now - 24 * 60 * 60 * 1000;
    case "7d":    return now - 7 * 24 * 60 * 60 * 1000;
    case "month": return now - 30 * 24 * 60 * 60 * 1000;
    default:      return 0; // "all"
  }
}

/** Build a WHERE clause fragment for time-filtering.  Returns "" when ts=0. */
function timeFilter(col: string, ts: number): string {
  return ts > 0 ? `AND ${col} >= ${ts}` : "";
}

// ── Stat bucket helper ────────────────────────────────────────────────────────

interface CostBucket {
  cost_usd: number;
  /** Total tokens that flowed through the model: fresh input + output + cache read + cache write. */
  tokens: number;
  /** Tokens served from / written to the prompt cache (cache_read + cache_write). */
  cached_tokens: number;
  /** Cost attributable to cache reads + cache writes, in USD. */
  cached_cost_usd: number;
  /**
   * Estimated USD saved by the cache vs what the same tokens would have cost
   * at the fresh-input rate.  Computed per-message as:
   *   (cache_read + cache_write) × (cost_input / input_tokens) − (cost_cache_read + cost_cache_write)
   * Rows where input_tokens=0 contribute 0 (CASE WHEN guard).  Signed — can
   * be slightly negative on cache-write-heavy messages where the write cost
   * exceeds the avoided read cost; we keep the raw value in JSON but floor at
   * 0 in the UI.
   */
  cache_savings_usd: number;
  turns: number;
}

const BUCKET_COLS = `
  COALESCE(SUM(cost_total), 0)                                       AS cost_usd,
  COALESCE(SUM(input_tokens + output_tokens
             + cache_read_tokens + cache_write_tokens), 0)           AS tokens,
  COALESCE(SUM(cache_read_tokens + cache_write_tokens), 0)           AS cached_tokens,
  COALESCE(SUM(cost_cache_read + cost_cache_write), 0)               AS cached_cost_usd,
  COALESCE(SUM(
    CASE WHEN input_tokens > 0
      THEN (cache_read_tokens + cache_write_tokens)
             * (cost_input * 1.0 / input_tokens)
           - (cost_cache_read + cost_cache_write)
      ELSE 0
    END
  ), 0)                                                              AS cache_savings_usd,
  COUNT(DISTINCT turn_id)                                            AS turns
`;

const EMPTY_BUCKET: CostBucket = {
  cost_usd: 0, tokens: 0, cached_tokens: 0, cached_cost_usd: 0,
  cache_savings_usd: 0, turns: 0,
};

function queryCostBucket(db: Database.Database, fromTs: number): CostBucket {
  const row = db.prepare(`SELECT ${BUCKET_COLS} FROM llm_messages WHERE ts >= ?`).get(fromTs) as CostBucket | undefined;
  return row ?? { ...EMPTY_BUCKET };
}

function queryCostBucketForSession(db: Database.Database, sessionId: string): CostBucket {
  const row = db.prepare(`SELECT ${BUCKET_COLS} FROM llm_messages WHERE session_id = ?`).get(sessionId) as CostBucket | undefined;
  return row ?? { ...EMPTY_BUCKET };
}

// ── Tab implementations ───────────────────────────────────────────────────────

/**
 * Returns the local-time start-of-day (midnight) as a Unix-ms timestamp,
 * `daysAgo` calendar days before today.  daysAgo=0 → midnight today.
 */
function startOfDayLocal(daysAgo: number): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.getTime();
}

function tabSummary(db: Database.Database, since?: UsageSince): unknown {
  // Calendar-day semantics:
  //   today = midnight today (local) → now
  //   week  = midnight 6 days ago (local) → now  (today + previous 6 days)
  //   month = midnight 29 days ago (local) → now (today + previous 29 days)
  const today = queryCostBucket(db, startOfDayLocal(0));
  const week  = queryCostBucket(db, startOfDayLocal(6));
  const month = queryCostBucket(db, startOfDayLocal(29));

  // "session" = most recently started session
  const lastSession = db
    .prepare("SELECT id FROM sessions ORDER BY started_at DESC LIMIT 1")
    .get() as { id: string } | undefined;
  const session = lastSession
    ? queryCostBucketForSession(db, lastSession.id)
    : { ...EMPTY_BUCKET };

  // top model over the `since` window
  const fromTs = sinceMs(since);
  const modelRow = db.prepare(`
    SELECT t.model_id                       AS id,
           COALESCE(SUM(lm.cost_total), 0)  AS cost_usd,
           COUNT(DISTINCT t.id)             AS turns
    FROM turns t
    JOIN llm_messages lm ON lm.turn_id = t.id
    WHERE t.model_id IS NOT NULL
      ${timeFilter("lm.ts", fromTs)}
    GROUP BY t.model_id
    ORDER BY cost_usd DESC
    LIMIT 1
  `).get() as { id: string; cost_usd: number; turns: number } | undefined;

  return { today, week, month, session, top_model: modelRow ?? null };
}

function tabModels(db: Database.Database, since?: UsageSince): unknown {
  const fromTs = sinceMs(since);
  // `tokens_in` sums every token that flowed INTO the model: fresh input,
  // cache reads, and cache writes.  Anthropic (and increasingly other
  // providers) report cached tokens separately for billing, but they are
  // still part of the consumed context window — a user looking at the Models
  // tab expects "tokens in" to reflect total context, not just the uncached
  // portion.  Cost columns already aggregate correctly because
  // `cost_total` includes cache cost components.
  const rows = db.prepare(`
    SELECT t.model_id,
           COALESCE(SUM(lm.cost_total), 0)                                   AS cost_usd,
           COALESCE(SUM(lm.input_tokens
                       + lm.cache_read_tokens
                       + lm.cache_write_tokens), 0)                          AS tokens_in,
           COALESCE(SUM(lm.output_tokens), 0)                                 AS tokens_out,
           COALESCE(SUM(lm.cache_read_tokens), 0)                            AS cache_read_tokens,
           COALESCE(SUM(lm.cache_write_tokens), 0)                           AS cache_write_tokens,
           COALESCE(SUM(lm.cost_cache_read + lm.cost_cache_write), 0)        AS cached_cost_usd,
           COUNT(DISTINCT t.id)                                               AS turns,
           COALESCE(SUM(lm.input_tokens
                       + lm.cache_read_tokens
                       + lm.cache_write_tokens
                       + lm.output_tokens), 0)                               AS _total_tokens
    FROM turns t
    LEFT JOIN llm_messages lm ON lm.turn_id = t.id
    WHERE t.model_id IS NOT NULL
      ${timeFilter("t.started_at", fromTs)}
    GROUP BY t.model_id
    ORDER BY cost_usd DESC
  `).all() as Array<{
    model_id: string | null;
    cost_usd: number;
    tokens_in: number;
    tokens_out: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    cached_cost_usd: number;
    turns: number;
    _total_tokens: number;
  }>;

  const totalCost = rows.reduce((s, r) => s + r.cost_usd, 0);
  return {
    rows: rows.map((r) => {
      const cachedTokens = r.cache_read_tokens + r.cache_write_tokens;
      return {
        model_id: r.model_id ?? "unknown",
        cost_usd: r.cost_usd,
        tokens_in: r.tokens_in,
        tokens_out: r.tokens_out,
        cached_tokens: cachedTokens,
        cache_read_tokens: r.cache_read_tokens,
        cache_write_tokens: r.cache_write_tokens,
        // Share of input-side tokens served from / written to cache.
        cache_hit_rate: r.tokens_in > 0 ? cachedTokens / r.tokens_in : 0,
        cached_cost_usd: r.cached_cost_usd,
        turns: r.turns,
        share: totalCost > 0 ? r.cost_usd / totalCost : 0,
        avg_tokens_per_turn: r.turns > 0 ? r._total_tokens / r.turns : 0,
      };
    }),
  };
}

function tabRepos(db: Database.Database, since?: UsageSince): unknown {
  const fromTs = sinceMs(since);
  const tf = timeFilter("s.started_at", fromTs);

  // cost + session count per repo
  const repoRows = db.prepare(`
    SELECT s.repo_remote,
           COUNT(DISTINCT s.id)              AS sessions,
           COALESCE(SUM(lm.cost_total), 0)   AS cost_usd
    FROM sessions s
    LEFT JOIN turns t  ON t.session_id = s.id
    LEFT JOIN llm_messages lm ON lm.turn_id = t.id
    WHERE s.repo_remote IS NOT NULL
      ${tf}
    GROUP BY s.repo_remote
    ORDER BY cost_usd DESC
  `).all() as Array<{ repo_remote: string; sessions: number; cost_usd: number }>;

  // distinct files per repo
  const fileRows = db.prepare(`
    SELECT s.repo_remote, COUNT(DISTINCT ft.path) AS files_touched
    FROM files_touched ft
    JOIN sessions s ON s.id = ft.session_id
    WHERE s.repo_remote IS NOT NULL
      ${tf}
    GROUP BY s.repo_remote
  `).all() as Array<{ repo_remote: string; files_touched: number }>;

  const filesByRepo = new Map(fileRows.map((r) => [r.repo_remote, r.files_touched]));

  // top tool per repo — aggregate (name, count) rows then find max in JS
  const toolRows = db.prepare(`
    SELECT s.repo_remote, tc.name, COUNT(*) AS cnt
    FROM tool_calls tc
    JOIN sessions s ON s.id = tc.session_id
    WHERE s.repo_remote IS NOT NULL
      ${tf}
    GROUP BY s.repo_remote, tc.name
  `).all() as Array<{ repo_remote: string; name: string; cnt: number }>;

  const topToolByRepo = new Map<string, string>();
  const maxCntByRepo = new Map<string, number>();
  for (const r of toolRows) {
    if ((r.cnt ?? 0) > (maxCntByRepo.get(r.repo_remote) ?? -1)) {
      topToolByRepo.set(r.repo_remote, r.name);
      maxCntByRepo.set(r.repo_remote, r.cnt);
    }
  }

  return {
    rows: repoRows.map((r) => ({
      repo_remote: r.repo_remote,
      sessions: r.sessions,
      files_touched: filesByRepo.get(r.repo_remote) ?? 0,
      cost_usd: r.cost_usd,
      top_tool: topToolByRepo.get(r.repo_remote) ?? null,
    })),
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor((sorted.length - 1) * (p / 100));
  return sorted[idx] ?? 0;
}

function tabTools(db: Database.Database, since?: UsageSince): unknown {
  const fromTs = sinceMs(since);
  const tf = timeFilter("started_at", fromTs);

  // All rows so we can compute p50/p95 in JS
  const allRows = db.prepare(`
    SELECT name, duration_ms, is_error
    FROM tool_calls
    WHERE 1=1 ${tf}
    ORDER BY name, duration_ms
  `).all() as Array<{ name: string; duration_ms: number; is_error: number }>;

  // Group by name
  const grouped = new Map<
    string,
    { durations: number[]; errors: number }
  >();
  for (const r of allRows) {
    let g = grouped.get(r.name);
    if (!g) { g = { durations: [], errors: 0 }; grouped.set(r.name, g); }
    g.durations.push(r.duration_ms);
    if (r.is_error) g.errors++;
  }

  const rows = Array.from(grouped.entries()).map(([name, g]) => {
    const sorted = [...g.durations].sort((a, b) => a - b);
    return {
      name,
      calls: g.durations.length,
      total_duration_ms: g.durations.reduce((s, d) => s + d, 0),
      error_rate: g.durations.length > 0 ? g.errors / g.durations.length : 0,
      p50_ms: percentile(sorted, 50),
      p95_ms: percentile(sorted, 95),
    };
  });

  rows.sort((a, b) => b.calls - a.calls);
  return { rows };
}

/**
 * Phase classification heuristic for a session linked to a PR.
 * Reference: PLAN.md "Multi-session → single PR linking".
 *
 * For each (session, PR) pair we assign one of three phases:
 *
 *   planning        — 0 commits in commits_made for this session.
 *                     Any reason. Captures research / exploration sessions
 *                     that produced no recorded commits.
 *
 *   implementation  — ≥1 commit AND the session's started_at is at-or-before
 *                     the earliest linked_at for this PR (calendar-day
 *                     granularity). The session that produced the original
 *                     work is treated as implementation regardless of later
 *                     sessions working on the same PR.
 *
 *   fixup           — ≥1 commit AND started_at is strictly after the earliest
 *                     linked_at for this PR. Work pushed to an already-linked
 *                     (i.e. opened) PR: bug-fixes, review iterations, etc.
 *
 * Limitations (best-effort; tunable later):
 *   - commit detection relies on commits_made being populated; bash heuristics
 *     may miss commits from some shell invocations.
 *   - started_at vs linked_at comparison uses calendar-day granularity to
 *     tolerate clock skew between git operations and pi event recording.
 *   - Does not distinguish "pre-PR planning" from "planning after PR opened";
 *     both are classified as planning when commits = 0.
 */
type PrPhase = "planning" | "implementation" | "fixup";

function classifyPhase(
  sessionStartedAt: number,
  commitCount: number,
  earliestLinkedAt: number,
): PrPhase {
  if (commitCount === 0) return "planning";
  // Compare at calendar-day granularity (floor to midnight UTC) to tolerate
  // sub-day clock skew between session start and PR linking.
  const sessionDay = Math.floor(sessionStartedAt / 86_400_000);
  const linkedDay  = Math.floor(earliestLinkedAt  / 86_400_000);
  return sessionDay <= linkedDay ? "implementation" : "fixup";
}

function tabPrs(db: Database.Database, since?: UsageSince): unknown {
  const fromTs = sinceMs(since);
  const tf = timeFilter("pa.linked_at", fromTs);

  // Per-session rows for all linked PRs in the window.
  type SessionRow = {
    pr_number: number;
    pr_url: string;
    repo_remote: string;
    session_id: string;
    started_at: number;
    confidence: number;
    reason: string;
    linked_at: number;
    session_cost: number;
    session_tokens: number;
    session_turns: number;
  };

  const sessionRows = db.prepare(`
    SELECT pa.pr_number,
           pa.pr_url,
           pa.repo_remote,
           pa.session_id,
           s.started_at,
           pa.confidence,
           pa.reason,
           pa.linked_at,
           COALESCE(SUM(lm.cost_total), 0)                          AS session_cost,
           COALESCE(SUM(lm.input_tokens + lm.output_tokens
                        + lm.cache_read_tokens + lm.cache_write_tokens), 0) AS session_tokens,
           COUNT(DISTINCT lm.turn_id)                                AS session_turns
    FROM pr_associations pa
    JOIN sessions s ON s.id = pa.session_id
    LEFT JOIN llm_messages lm ON lm.session_id = pa.session_id
    WHERE 1=1 ${tf}
    GROUP BY pa.pr_number, pa.session_id
    ORDER BY pa.pr_number, s.started_at ASC
  `).all() as SessionRow[];

  // Commit counts per (session_id) — needed for phase classification.
  type CommitCountRow = { session_id: string; commit_count: number };
  const commitRows = db.prepare(`
    SELECT session_id, COUNT(*) AS commit_count
    FROM commits_made
    GROUP BY session_id
  `).all() as CommitCountRow[];
  const commitsBySession = new Map(commitRows.map((r) => [r.session_id, r.commit_count]));

  // Total commits per PR (summed from linked sessions).
  type PrCommitRow = { pr_number: number; total_commits: number };
  const prCommitRows = db.prepare(`
    SELECT pa.pr_number, COUNT(cm.id) AS total_commits
    FROM pr_associations pa
    LEFT JOIN commits_made cm ON cm.session_id = pa.session_id
    WHERE 1=1 ${tf}
    GROUP BY pa.pr_number
  `).all() as PrCommitRow[];
  const commitsByPr = new Map(prCommitRows.map((r) => [r.pr_number, r.total_commits]));

  // Total distinct files per PR.
  type FileRow = { pr_number: number; total_files: number };
  const fileRows = db.prepare(`
    SELECT pa.pr_number, COUNT(DISTINCT ft.path) AS total_files
    FROM pr_associations pa
    LEFT JOIN files_touched ft ON ft.session_id = pa.session_id
    WHERE 1=1 ${tf}
    GROUP BY pa.pr_number
  `).all() as FileRow[];
  const filesByPr = new Map(fileRows.map((r) => [r.pr_number, r.total_files]));

  // Earliest linked_at per PR — used as the "PR opened" anchor for phase
  // classification.  We query it separately to guarantee accuracy even if
  // the main sessionRows query is filtered by since.
  type EarliestLinkRow = { pr_number: number; earliest_linked_at: number };
  const earliestRows = db.prepare(`
    SELECT pr_number, MIN(linked_at) AS earliest_linked_at
    FROM pr_associations
    GROUP BY pr_number
  `).all() as EarliestLinkRow[];
  const earliestByPr = new Map(earliestRows.map((r) => [r.pr_number, r.earliest_linked_at]));

  // Group session rows by PR.
  const prMap = new Map<number, {
    pr_number: number;
    pr_url: string;
    repo_remote: string;
    topConfidence: number;
    topReason: string;
    sessions: SessionRow[];
  }>();

  for (const row of sessionRows) {
    let pr = prMap.get(row.pr_number);
    if (!pr) {
      pr = {
        pr_number: row.pr_number,
        pr_url: row.pr_url,
        repo_remote: row.repo_remote,
        topConfidence: row.confidence,
        topReason: row.reason,
        sessions: [],
      };
      prMap.set(row.pr_number, pr);
    }
    if (row.confidence > pr.topConfidence) {
      pr.topConfidence = row.confidence;
      pr.topReason = row.reason;
    }
    pr.sessions.push(row);
  }

  // Build the final grouped output.
  const rows = Array.from(prMap.values())
    .map((pr) => {
      const earliestLinkedAt = earliestByPr.get(pr.pr_number) ?? pr.sessions[0]?.linked_at ?? 0;

      // Per-session breakdown with phase classification.
      const breakdown = pr.sessions.map((s) => {
        const commitCount = commitsBySession.get(s.session_id) ?? 0;
        const phase = classifyPhase(s.started_at, commitCount, earliestLinkedAt);
        return {
          session_id: s.session_id,
          started_at: s.started_at,
          phase,
          cost_usd: s.session_cost,
          tokens: s.session_tokens,
          turns: s.session_turns,
          commits: commitCount,
          confidence: s.confidence,
          reason: s.reason,
        };
      });

      // Phase cost breakdown (USD per phase).
      const phaseBreakdown = { planning: 0, implementation: 0, fixup: 0 };
      for (const b of breakdown) {
        phaseBreakdown[b.phase] += b.cost_usd;
      }

      const totalCost = pr.sessions.reduce((s, r) => s + r.session_cost, 0);
      const totalTurns = pr.sessions.reduce((s, r) => s + r.session_turns, 0);

      return {
        // Legacy flat fields — kept so existing callers don't break.
        pr_number:      pr.pr_number,
        pr_url:         pr.pr_url,
        repo_remote:    pr.repo_remote,
        repo_short:     shortenRepoRemote(pr.repo_remote),
        sessions:       pr.sessions.length,
        total_cost_usd: totalCost,
        total_files:    filesByPr.get(pr.pr_number) ?? 0,
        total_turns:    totalTurns,
        total_commits:  commitsByPr.get(pr.pr_number) ?? 0,
        top_reason:     pr.topReason,
        confidence:     pr.topConfidence,
        // New grouped fields.
        phase_breakdown: phaseBreakdown,
        breakdown,
      };
    })
    .sort((a, b) => b.total_cost_usd - a.total_cost_usd);

  return { rows };
}

function tabDaily(db: Database.Database, since?: UsageSince): unknown {
  const fromTs = sinceMs(since);
  const tf = timeFilter("ts", fromTs);

  // Use date(ts/1000, 'unixepoch', 'localtime') so calendar boundaries match
  // the user's local timezone rather than UTC — keeps Daily aligned with the
  // Today/Week/Month buckets in tabSummary.
  const rows = db.prepare(`
    SELECT date(ts / 1000, 'unixepoch', 'localtime')                      AS date,
           COALESCE(SUM(cost_total), 0)                                   AS cost_usd,
           COALESCE(SUM(input_tokens + output_tokens
                      + cache_read_tokens + cache_write_tokens), 0)       AS tokens,
           COALESCE(SUM(cache_read_tokens + cache_write_tokens), 0)       AS cached_tokens,
           COALESCE(SUM(cost_cache_read + cost_cache_write), 0)           AS cached_cost_usd,
           COUNT(DISTINCT turn_id)                                         AS turns
    FROM llm_messages
    WHERE 1=1 ${tf}
    GROUP BY date
    ORDER BY date DESC
    LIMIT 90
  `).all() as Array<{
    date: string;
    cost_usd: number;
    tokens: number;
    cached_tokens: number;
    cached_cost_usd: number;
    turns: number;
  }>;

  return { rows };
}

// ── Main aggregation dispatch ─────────────────────────────────────────────────

/**
 * Run the aggregation queries for the given tab and return a JSON-serialisable
 * object. Throws if SqliteSink has not been initialised (db === null).
 */
export function runUsageJson(
  sink: SqliteSink,
  args: { tab?: UsageTab; since?: UsageSince },
): unknown {
  const db = sink.database;
  if (!db) throw new Error("[analytics:usage] SqliteSink not initialised");

  const tab = args.tab ?? "summary";
  switch (tab) {
    case "summary": return tabSummary(db, args.since);
    case "models":  return tabModels(db, args.since);
    case "repos":   return tabRepos(db, args.since);
    case "tools":   return tabTools(db, args.since);
    case "prs":     return tabPrs(db, args.since);
    case "daily":   return tabDaily(db, args.since);
  }
}

// ── Interactive rendering ─────────────────────────────────────────────────────

/** Simple fixed-width column formatter for tables. */
function col(val: unknown, width: number, align: "l" | "r" = "l"): string {
  const s = String(val ?? "");
  return align === "r"
    ? s.padStart(width).slice(-width)
    : s.padEnd(width).slice(0, width);
}

function fmtUsd(n: number): string { return `$${n.toFixed(4)}`; }
function fmtNum(n: number): string { return n.toLocaleString("en"); }
function fmtPct(n: number): string { return `${(n * 100).toFixed(1)}%`; }

function renderTab(tab: UsageTab, data: unknown): string {
  const lines: string[] = [];

  if (tab === "summary") {
    const d = data as ReturnType<typeof tabSummary> & {
      today: CostBucket; week: CostBucket; session: CostBucket;
      top_model: { id: string; cost_usd: number; turns: number } | null;
    };
    lines.push("╭─────────────────────── Usage Summary ──────────────────────────╮");
    lines.push(`│ ${"Bucket".padEnd(10)} ${"Cost (USD)".padStart(12)} ${"Tokens".padStart(12)} ${"Turns".padStart(8)} │`);
    lines.push("├────────────────────────────────────────────────────────────────┤");
    for (const [label, b] of [["Today", d.today], ["Week", d.week], ["Session", d.session]] as const) {
      const bucket = b as CostBucket;
      lines.push(`│ ${col(label, 10)} ${col(fmtUsd(bucket.cost_usd), 12, "r")} ${col(fmtNum(bucket.tokens), 12, "r")} ${col(bucket.turns, 8, "r")} │`);
    }
    if (d.top_model) {
      lines.push("├────────────────────────────────────────────────────────────────┤");
      lines.push(`│ Top model: ${d.top_model.id} (${fmtUsd(d.top_model.cost_usd)}, ${d.top_model.turns} turns)`.padEnd(65) + "│");
    }
    lines.push("╰────────────────────────────────────────────────────────────────╯");

  } else if (tab === "models") {
    const { rows } = data as { rows: Array<{ model_id: string; cost_usd: number; tokens_in: number; tokens_out: number; turns: number; share: number; avg_tokens_per_turn: number }> };
    lines.push(`${"Model".padEnd(30)} ${"Cost".padStart(10)} ${"Share".padStart(7)} ${"Turns".padStart(6)} ${"Avg tok/turn".padStart(13)}`);
    lines.push("─".repeat(70));
    for (const r of rows) {
      lines.push(`${col(r.model_id, 30)} ${col(fmtUsd(r.cost_usd), 10, "r")} ${col(fmtPct(r.share), 7, "r")} ${col(r.turns, 6, "r")} ${col(Math.round(r.avg_tokens_per_turn), 13, "r")}`);
    }

  } else if (tab === "repos") {
    const { rows } = data as { rows: Array<{ repo_remote: string; sessions: number; files_touched: number; cost_usd: number; top_tool: string | null }> };
    lines.push(`${"Repo".padEnd(35)} ${"Cost".padStart(10)} ${"Sessions".padStart(9)} ${"Files".padStart(6)} ${"Top tool".padEnd(12)}`);
    lines.push("─".repeat(76));
    for (const r of rows) {
      lines.push(`${col(r.repo_remote, 35)} ${col(fmtUsd(r.cost_usd), 10, "r")} ${col(r.sessions, 9, "r")} ${col(r.files_touched, 6, "r")} ${col(r.top_tool ?? "—", 12)}`);
    }

  } else if (tab === "tools") {
    const { rows } = data as { rows: Array<{ name: string; calls: number; total_duration_ms: number; error_rate: number; p50_ms: number; p95_ms: number }> };
    lines.push(`${"Tool".padEnd(20)} ${"Calls".padStart(7)} ${"p50ms".padStart(7)} ${"p95ms".padStart(7)} ${"ErrRate".padStart(8)} ${"Total ms".padStart(9)}`);
    lines.push("─".repeat(62));
    for (const r of rows) {
      lines.push(`${col(r.name, 20)} ${col(r.calls, 7, "r")} ${col(r.p50_ms, 7, "r")} ${col(r.p95_ms, 7, "r")} ${col(fmtPct(r.error_rate), 8, "r")} ${col(r.total_duration_ms, 9, "r")}`);
    }

  } else if (tab === "prs") {
    const { rows } = data as { rows: Array<{ pr_number: number; pr_url: string; sessions: number; total_cost_usd: number; total_files: number; top_reason: string; confidence: number }> };
    lines.push(`${"PR".padStart(6)} ${"Cost".padStart(10)} ${"Sessions".padStart(9)} ${"Files".padStart(6)} ${"Confidence".padStart(11)} ${"Reason".padEnd(16)}`);
    lines.push("─".repeat(63));
    for (const r of rows) {
      lines.push(`${col(`#${r.pr_number}`, 6, "r")} ${col(fmtUsd(r.total_cost_usd), 10, "r")} ${col(r.sessions, 9, "r")} ${col(r.total_files, 6, "r")} ${col(r.confidence.toFixed(2), 11, "r")} ${col(r.top_reason, 16)}`);
    }

  } else if (tab === "daily") {
    const { rows } = data as { rows: Array<{ date: string; cost_usd: number; tokens: number; turns: number }> };
    // sparkline using block elements
    const maxCost = Math.max(...rows.map((r) => r.cost_usd), 0.0001);
    const blocks = " ▁▂▃▄▅▆▇█";
    const spark = rows
      .slice(0, 30)
      .reverse()
      .map((r) => blocks[Math.min(8, Math.floor((r.cost_usd / maxCost) * 8))])
      .join("");
    lines.push(`Sparkline (last 30d): ${spark}`);
    lines.push("");
    lines.push(`${"Date".padEnd(12)} ${"Cost".padStart(10)} ${"Tokens".padStart(12)} ${"Turns".padStart(6)}`);
    lines.push("─".repeat(44));
    for (const r of rows) {
      lines.push(`${col(r.date, 12)} ${col(fmtUsd(r.cost_usd), 10, "r")} ${col(fmtNum(r.tokens), 12, "r")} ${col(r.turns, 6, "r")}`);
    }
  }

  return lines.join("\n");
}

/**
 * Interactive command handler.
 *
 * With `--json`: prints aggregated data as JSON via ctx.ui.notify.
 * Without `--json` and when ctx.ui.custom is available: opens a fullscreen
 * tabbed component (UsageTabsComponent).  Falls back to formatted text via
 * ctx.ui.notify when running in non-interactive mode (-p, RPC).
 *
 * @param _pi     The pi ExtensionAPI (unused — reserved for future use).
 * @param sink    Initialised SqliteSink to query.
 * @param ctx     The pi command context.
 * @param rawArgs Raw argument string from pi (after the command name).
 */
export async function runUsageInteractive(
  _pi: PiAPIStub,
  sink: SqliteSink,
  ctx: CtxStub,
  rawArgs = "",
): Promise<void> {
  const argv = rawArgs.trim().split(/\s+/).filter(Boolean);
  const args = parseUsageArgs(argv);

  // --json always goes through the notify path (non-interactive).
  if (args.json) {
    try {
      const data = runUsageJson(sink, { tab: args.tab, since: args.since });
      ctx.ui.notify(JSON.stringify(data, null, 2), "info");
    } catch (err) {
      ctx.ui.notify(`[analytics:usage] ${String(err)}`, "error");
    }
    return;
  }

  // Interactive path — requires ctx.ui.custom.
  if (typeof ctx.ui.custom === "function") {
    // Lazy import to keep startup cost low.
    const { UsageTabsComponent } = await import("./usage-component.ts");
    try {
      await ctx.ui.custom((_tui, theme, _kb, done) => {
        const component = new UsageTabsComponent({
          loadTab: (tab, since) => runUsageJson(sink, { tab, since }),
          initialTab: args.tab,
          since: args.since,
          theme: theme as { fg(c: string, t: string): string; bg(c: string, t: string): string },
          onClose: () => done(undefined as never),
        });
        return component;
      });
    } catch (err) {
      ctx.ui.notify(`[analytics:usage] ${String(err)}`, "error");
    }
    return;
  }

  // Fallback: non-interactive (e.g. -p mode, RPC, test stubs without ctx.ui.custom).
  try {
    const tab = args.tab ?? "summary";
    const data = runUsageJson(sink, { tab, since: args.since });
    ctx.ui.notify(renderTab(tab, data), "info");
  } catch (err) {
    ctx.ui.notify(`[analytics:usage] ${String(err)}`, "error");
  }
}
