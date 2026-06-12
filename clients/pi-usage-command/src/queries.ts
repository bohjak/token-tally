/**
 * Read-only query functions for the ToTally central store — Pi usage command.
 *
 * This module owns:
 *   - CLI argument parsing for the /usage command.
 *   - UsageSince → Unix-ms conversion.
 *   - Tab-level wrapper functions that adapt the Pi /usage API (tab + since
 *     enum) to the shared @token-tally/queries functions (from/to opts).
 *
 * All database aggregation is delegated to @token-tally/queries; no
 * aggregation SQL lives in this file.
 */

import type Database from "better-sqlite3";
import {
  queryCostBucket,
  queryCostBucketForSession,
  querySummary,
  queryModels,
  queryRepos,
  queryTools,
  queryDaily,
} from "@token-tally/queries";

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

// ---------------------------------------------------------------------------
// Argument parser
// ---------------------------------------------------------------------------

const VALID_TABS = new Set<UsageTab>(["summary", "models", "repos", "tools", "prs", "daily"]);
const VALID_SINCE = new Set<UsageSince>(["24h", "7d", "month", "all"]);

/**
 * Parses /usage flags from the raw argument string Pi passes to the handler.
 * Supports:
 *   --json
 *   --tab=<value>   or  --tab <value>
 *   --since=<value> or  --since <value>
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
export function sinceToMs(since?: UsageSince): number {
  const now = Date.now();
  switch (since) {
    case "24h":   return now - 24 * 60 * 60 * 1000;
    case "7d":    return now - 7  * 24 * 60 * 60 * 1000;
    case "month": return now - 30 * 24 * 60 * 60 * 1000;
    default:      return 0; // "all"
  }
}

// ---------------------------------------------------------------------------
// Tab functions — adapt Pi's (tab, since) API to shared query opts
// ---------------------------------------------------------------------------

export function queryTabSummary(db: Database.Database, since?: UsageSince): unknown {
  const now = Date.now();
  const today = queryCostBucket(db, { from: startOfDayLocal(0), to: now });
  const week  = queryCostBucket(db, { from: startOfDayLocal(6), to: now });
  const month = queryCostBucket(db, { from: startOfDayLocal(29), to: now });

  // Latest session
  const lastSession = db
    .prepare("SELECT id FROM sessions ORDER BY started_at DESC LIMIT 1")
    .get() as { id: string } | undefined;
  const session = lastSession
    ? queryCostBucketForSession(db, lastSession.id)
    : { cost_usd: 0, billable_tokens: 0, tokens: 0, cached_tokens: 0,
        cached_cost_usd: 0, cache_savings_usd: 0, turns: 0, sessions: 0,
        unpriced_count: 0, input_tokens: 0, output_tokens: 0, messages: 0 };

  // Top model in the `since` window — re-use querySummary which returns top_model.
  const fromMs = sinceToMs(since);
  const sinceSummary = querySummary(db, { from: fromMs, to: now });
  const topModel = sinceSummary.top_model;

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

export function queryTabModels(db: Database.Database, since?: UsageSince): unknown {
  const from = sinceToMs(since);
  const result = queryModels(db, { from, to: Date.now() });
  // Remap tokens_out → tokens_out and expose output_tokens alias for
  // usage-component.ts renderModels which reads r.tokens_out.
  return result;
}

export function queryTabRepos(db: Database.Database, since?: UsageSince): unknown {
  const from = sinceToMs(since);
  const { rows } = queryRepos(db, { from, to: Date.now() });
  // usage-component.ts renderRepos reads r.repo_remote; map repo → repo_remote.
  return {
    rows: rows.map((r) => ({
      ...r,
      repo_remote: r.repo,
      files_touched: 0, // not available in the central schema
    })),
  };
}

export function queryTabTools(db: Database.Database, since?: UsageSince): unknown {
  const from = sinceToMs(since);
  const { rows } = queryTools(db, { from, to: Date.now() });
  // usage-component.ts renderTools reads r.name alongside r.tool_name.
  return {
    rows: rows.map((r) => ({ ...r, name: r.tool_name })),
  };
}

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

export function queryTabDaily(db: Database.Database, since?: UsageSince): unknown {
  const from = sinceToMs(since);
  return queryDaily(db, { from, to: Date.now() });
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
  args: { tab?: UsageTab; since?: UsageSince },
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
