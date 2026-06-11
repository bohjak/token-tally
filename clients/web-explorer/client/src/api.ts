// Typed API client — one function per endpoint.

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

export type SummaryData = CostBucket & {
  top_model: { model_id: string; cost_usd: number; turns: number } | null;
  top_repo: { repo: string; cost_usd: number } | null;
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
  share: number;
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

export type HarnessRow = {
  name: string;
  display_name: string;
  last_seen_at: number;
};

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

export type Filters = {
  from: number;
  to: number;
  harnesses?: string[];
  model?: string;
  repo?: string;
};

// ---------------------------------------------------------------------------
// Internal fetch helper
// ---------------------------------------------------------------------------

async function apiFetch<T>(path: string, params?: Record<string, string | string[] | number | undefined>): Promise<T> {
  const url = new URL(path, window.location.origin);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v == null) continue;
      if (Array.isArray(v)) {
        for (const item of v) url.searchParams.append(k, item);
      } else {
        url.searchParams.set(k, String(v));
      }
    }
  }
  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API error ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

function filtersToParams(f: Filters): Record<string, string | string[] | number | undefined> {
  return {
    from: f.from,
    to: f.to,
    harness: f.harnesses,
    model: f.model,
    repo: f.repo,
  };
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export const api = {
  health: () => apiFetch<{ ok: boolean; dbPath: string; schemaVersion: string }>("/api/health"),

  harnesses: () => apiFetch<{ rows: HarnessRow[] }>("/api/harnesses"),

  summary: (f: Filters) => apiFetch<SummaryData>("/api/summary", filtersToParams(f)),

  daily: (f: Filters) => apiFetch<{ rows: DailyRow[]; unpriced_count: number }>("/api/daily", filtersToParams(f)),

  hourly: (f: Filters) => apiFetch<{ rows: HourlyRow[]; unpriced_count: number }>("/api/hourly", filtersToParams(f)),

  components: (f: Filters) => apiFetch<{ rows: ComponentRow[] }>("/api/components", filtersToParams(f)),

  models: (f: Filters) => apiFetch<{ rows: ModelRow[]; unpriced_count: number }>("/api/models", filtersToParams(f)),

  repos: (f: Filters) => apiFetch<{ rows: RepoRow[] }>("/api/repos", filtersToParams(f)),

  tools: (f: Filters) => apiFetch<{ rows: ToolRow[] }>("/api/tools", filtersToParams(f)),

  sessions: (f: Filters & { limit?: number; cursor?: string; sort?: string; dir?: "asc" | "desc" }) =>
    apiFetch<{ rows: SessionRow[]; nextCursor: string | null }>("/api/sessions", {
      ...filtersToParams(f),
      limit: f.limit,
      cursor: f.cursor,
      sort: f.sort,
      dir: f.dir,
    }),

  session: (id: string) => apiFetch<{
    session: SessionRow;
    cost: CostBucket;
    turns: TurnRow[];
    topTools: Array<{ tool_name: string; calls: number; errors: number }>;
  }>(`/api/sessions/${id}`),

  turnDetail: (sessionId: string, turnId: string) =>
    apiFetch<{ turn: TurnRow; messages: LlmMessageRow[]; toolCalls: ToolCallRow[] }>(
      `/api/sessions/${sessionId}/turns/${turnId}`
    ),
};
