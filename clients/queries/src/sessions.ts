/**
 * Session, turn, and LLM-message query functions for the ToTally central store.
 *
 * All functions accept an injected better-sqlite3 Database and never open
 * connections themselves.
 */

import type Database from "better-sqlite3";
import type { CostBucket } from "./analytics.js";
import { queryCostBucketForSession } from "./analytics.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionRow = {
  id: string;
  harness_id: string;
  cwd: string | null;
  repo_owner: string | null;
  repo_name: string | null;
  repo_remote: string | null;
  started_at: number;
  ended_at: number | null;
  cost_usd: number;
  tokens: number;
  billable_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  turns: number;
  tool_calls: number;
  duration_ms: number | null;
  model_id: string | null;
};

export type TurnRow = {
  id: string;
  turn_index: number | null;
  started_at: number;
  ended_at: number | null;
  model_id: string | null;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  tool_call_count: number;
  error_count: number;
  duration_ms: number | null;
};

export type LlmMessageRow = {
  id: string;
  ts: number;
  model_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  cost_source: string;
};

export type ToolCallRow = {
  id: string;
  tool_name: string;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  is_error: number;
};

/**
 * Valid sort column names for listSessions.
 * Maps user-supplied sort key to the SQL expression used in ORDER BY.
 */
export const SESSION_SORT_COLUMNS: Record<string, string> = {
  started_at:         "s.started_at",
  harness_id:         "s.harness_id",
  model_id:           "model_id",
  cost_usd:           "cost_usd",
  tokens:             "tokens",
  output_tokens:      "output_tokens",
  cache_read_tokens:  "cache_read_tokens",
  cache_write_tokens: "cache_write_tokens",
  cache_pct:          "CAST(cached_tokens AS REAL) / NULLIF(tokens, 0)",
  turns:              "turns",
  tool_calls:         "tool_calls",
  duration_ms:        "duration_ms",
  repo:               "COALESCE(s.repo_owner || '/' || s.repo_name, s.repo_remote, s.cwd)",
};

export type ListSessionsOpts = {
  from: number;
  to: number;
  harnesses?: string[];
  model?: string;
  repo?: string;
  limit?: number;
  offset?: number;
  sort?: string;
  dir?: "asc" | "desc";
};

export type ListSessionsResult = {
  rows: SessionRow[];
  nextCursor: string | null;
};

export type GetSessionResult = {
  session: SessionRow;
  cost: CostBucket;
  turns: TurnRow[];
  topTools: Array<{ tool_name: string; calls: number; errors: number }>;
};

export type GetTurnDetailResult = {
  turn: TurnRow;
  messages: LlmMessageRow[];
  toolCalls: ToolCallRow[];
};

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function listSessions(
  db: Database.Database,
  opts: ListSessionsOpts,
): ListSessionsResult {
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const sortExpr = SESSION_SORT_COLUMNS[opts.sort ?? ""] ?? "s.started_at";
  const sortDir = opts.dir === "asc" ? "ASC" : "DESC";
  const params: (string | number)[] = [opts.from, opts.to];
  const clauses: string[] = [];

  if (opts.harnesses && opts.harnesses.length > 0) {
    const ph = opts.harnesses.map(() => "?").join(", ");
    clauses.push(`s.harness_id IN (${ph})`);
    params.push(...opts.harnesses);
  }
  if (opts.model) {
    clauses.push(
      `EXISTS (SELECT 1 FROM llm_messages m WHERE m.session_id = s.id AND m.cost_source != 'unknown' AND m.model_id LIKE ?)`,
    );
    params.push(`%${opts.model}%`);
  }
  if (opts.repo) {
    clauses.push(
      `(s.cwd LIKE ? OR s.repo_owner || '/' || s.repo_name LIKE ? OR s.repo_remote LIKE ?)`,
    );
    params.push(`%${opts.repo}%`, `%${opts.repo}%`, `%${opts.repo}%`);
  }

  const whereExtra = clauses.length > 0 ? `AND ${clauses.join(" AND ")}` : "";

  const rows = db
    .prepare(
      `SELECT
         s.id, s.harness_id, s.cwd, s.repo_owner, s.repo_name, s.repo_remote,
         s.started_at, s.ended_at,
         COALESCE((SELECT SUM(CASE WHEN m.cost_source != 'unknown' THEN m.cost_total_micros ELSE 0 END) FROM llm_messages m
                   WHERE m.session_id = s.id), 0) / 1000000.0 AS cost_usd,
         COALESCE((SELECT SUM(m.input_tokens + m.output_tokens + m.cache_read_tokens + m.cache_write_tokens) FROM llm_messages m
                   WHERE m.session_id = s.id), 0) AS tokens,
         COALESCE((SELECT SUM(m.input_tokens + m.output_tokens) FROM llm_messages m
                   WHERE m.session_id = s.id), 0) AS billable_tokens,
         COALESCE((SELECT SUM(m.output_tokens) FROM llm_messages m
                   WHERE m.session_id = s.id), 0) AS output_tokens,
         COALESCE((SELECT SUM(m.cache_read_tokens + m.cache_write_tokens) FROM llm_messages m
                   WHERE m.session_id = s.id), 0) AS cached_tokens,
         COALESCE((SELECT SUM(m.cache_read_tokens) FROM llm_messages m
                   WHERE m.session_id = s.id), 0) AS cache_read_tokens,
         COALESCE((SELECT SUM(m.cache_write_tokens) FROM llm_messages m
                   WHERE m.session_id = s.id), 0) AS cache_write_tokens,
         (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id) AS turns,
         (SELECT COUNT(*) FROM tool_calls tc WHERE tc.session_id = s.id) AS tool_calls,
         (s.ended_at - s.started_at) AS duration_ms,
         (SELECT model_id FROM llm_messages
          WHERE session_id = s.id AND cost_source != 'unknown'
          ORDER BY cost_total_micros DESC LIMIT 1) AS model_id
       FROM sessions s
       WHERE s.started_at >= ? AND s.started_at <= ?
         ${whereExtra}
       ORDER BY ${sortExpr} ${sortDir}, s.id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit + 1, offset) as SessionRow[];

  const hasMore = rows.length > limit;
  const result = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? String(offset + limit) : null;

  return { rows: result, nextCursor };
}

export function getSession(
  db: Database.Database,
  sessionId: string,
): GetSessionResult | null {
  const session = db
    .prepare(
      `SELECT
         s.id, s.harness_id, s.cwd, s.repo_owner, s.repo_name, s.repo_remote,
         s.started_at, s.ended_at,
         COALESCE((SELECT SUM(CASE WHEN m.cost_source != 'unknown' THEN m.cost_total_micros ELSE 0 END) FROM llm_messages m
                   WHERE m.session_id = s.id), 0) / 1000000.0 AS cost_usd,
         COALESCE((SELECT SUM(m.input_tokens + m.output_tokens + m.cache_read_tokens + m.cache_write_tokens) FROM llm_messages m
                   WHERE m.session_id = s.id), 0) AS tokens,
         COALESCE((SELECT SUM(m.input_tokens + m.output_tokens) FROM llm_messages m
                   WHERE m.session_id = s.id), 0) AS billable_tokens,
         COALESCE((SELECT SUM(m.output_tokens) FROM llm_messages m
                   WHERE m.session_id = s.id), 0) AS output_tokens,
         COALESCE((SELECT SUM(m.cache_read_tokens + m.cache_write_tokens) FROM llm_messages m
                   WHERE m.session_id = s.id), 0) AS cached_tokens,
         COALESCE((SELECT SUM(m.cache_read_tokens) FROM llm_messages m
                   WHERE m.session_id = s.id), 0) AS cache_read_tokens,
         COALESCE((SELECT SUM(m.cache_write_tokens) FROM llm_messages m
                   WHERE m.session_id = s.id), 0) AS cache_write_tokens,
         (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id) AS turns,
         (SELECT COUNT(*) FROM tool_calls tc WHERE tc.session_id = s.id) AS tool_calls,
         (s.ended_at - s.started_at) AS duration_ms,
         (SELECT model_id FROM llm_messages
          WHERE session_id = s.id AND cost_source != 'unknown'
          ORDER BY cost_total_micros DESC LIMIT 1) AS model_id
       FROM sessions s
       WHERE s.id = ?`,
    )
    .get(sessionId) as SessionRow | undefined;

  if (!session) return null;

  const cost = queryCostBucketForSession(db, sessionId);

  const turns = db
    .prepare(
      `SELECT
         t.id, t.turn_index, t.started_at, t.ended_at, t.model_id,
         COALESCE((SELECT SUM(CASE WHEN m.cost_source != 'unknown' THEN m.cost_total_micros ELSE 0 END) FROM llm_messages m
                   WHERE m.turn_id = t.id), 0) / 1000000.0 AS cost_usd,
         COALESCE((SELECT SUM(m.input_tokens) FROM llm_messages m
                   WHERE m.turn_id = t.id), 0) AS input_tokens,
         COALESCE((SELECT SUM(m.output_tokens) FROM llm_messages m
                   WHERE m.turn_id = t.id), 0) AS output_tokens,
         COALESCE((SELECT SUM(m.cache_read_tokens + m.cache_write_tokens) FROM llm_messages m
                   WHERE m.turn_id = t.id), 0) AS cached_tokens,
         (SELECT COUNT(*) FROM tool_calls tc WHERE tc.turn_id = t.id) AS tool_call_count,
         COALESCE((SELECT SUM(CASE WHEN tc.is_error != 0 THEN 1 ELSE 0 END) FROM tool_calls tc
                   WHERE tc.turn_id = t.id), 0) AS error_count,
         (t.ended_at - t.started_at) AS duration_ms
       FROM turns t
       WHERE t.session_id = ?
       ORDER BY COALESCE(t.turn_index, t.started_at) ASC, t.started_at ASC`,
    )
    .all(sessionId) as TurnRow[];

  const topTools = db
    .prepare(
      `SELECT tool_name, COUNT(*) AS calls,
              SUM(CASE WHEN is_error != 0 THEN 1 ELSE 0 END) AS errors
       FROM tool_calls WHERE session_id = ?
       GROUP BY tool_name ORDER BY calls DESC LIMIT 10`,
    )
    .all(sessionId) as Array<{ tool_name: string; calls: number; errors: number }>;

  return { session, cost, turns, topTools };
}

export function getTurnDetail(
  db: Database.Database,
  turnId: string,
): GetTurnDetailResult | null {
  const turn = db
    .prepare(
      `SELECT
         t.id, t.turn_index, t.started_at, t.ended_at, t.model_id,
         COALESCE((SELECT SUM(CASE WHEN m.cost_source != 'unknown' THEN m.cost_total_micros ELSE 0 END) FROM llm_messages m
                   WHERE m.turn_id = t.id), 0) / 1000000.0 AS cost_usd,
         COALESCE((SELECT SUM(m.input_tokens) FROM llm_messages m
                   WHERE m.turn_id = t.id), 0) AS input_tokens,
         COALESCE((SELECT SUM(m.output_tokens) FROM llm_messages m
                   WHERE m.turn_id = t.id), 0) AS output_tokens,
         COALESCE((SELECT SUM(m.cache_read_tokens + m.cache_write_tokens) FROM llm_messages m
                   WHERE m.turn_id = t.id), 0) AS cached_tokens,
         (SELECT COUNT(*) FROM tool_calls tc WHERE tc.turn_id = t.id) AS tool_call_count,
         COALESCE((SELECT SUM(CASE WHEN tc.is_error != 0 THEN 1 ELSE 0 END) FROM tool_calls tc
                   WHERE tc.turn_id = t.id), 0) AS error_count,
         (t.ended_at - t.started_at) AS duration_ms
       FROM turns t
       WHERE t.id = ?`,
    )
    .get(turnId) as TurnRow | undefined;

  if (!turn) return null;

  const messages = db
    .prepare(
      `SELECT id, ts, model_id,
              input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
              cost_total_micros / 1000000.0 AS cost_usd, cost_source
       FROM llm_messages WHERE turn_id = ? ORDER BY ts ASC`,
    )
    .all(turnId) as LlmMessageRow[];

  const toolCalls = db
    .prepare(
      `SELECT id, tool_name, started_at, ended_at,
              (ended_at - started_at) AS duration_ms, is_error
       FROM tool_calls WHERE turn_id = ? ORDER BY started_at ASC`,
    )
    .all(turnId) as ToolCallRow[];

  return { turn, messages, toolCalls };
}
