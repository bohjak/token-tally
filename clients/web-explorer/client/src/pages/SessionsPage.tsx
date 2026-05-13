import { useState, useCallback, useEffect } from "react";
import { useNavigate } from "react-router";
import { useFilters } from "../hooks/useFilters.ts";
import { useApi } from "../hooks/useApi.ts";
import { api, type SessionRow } from "../api.ts";
import FilterBar from "../components/FilterBar.tsx";
import DataTable from "../components/DataTable.tsx";
import { formatCost, formatDuration, formatRelativeDate, formatTokens } from "../lib/format.ts";
import { formatCostDelta, formatDeltaPercent, formatNumberDelta } from "../lib/delta.ts";
import type { ColumnDef } from "@tanstack/react-table";

function repoLabel(s: SessionRow): string {
  if (s.repo_owner && s.repo_name) return `${s.repo_owner}/${s.repo_name}`;
  if (s.repo_remote) return s.repo_remote;
  if (s.cwd) return s.cwd.split("/").slice(-2).join("/");
  return "—";
}

const columns: ColumnDef<SessionRow>[] = [
  {
    accessorKey: "started_at",
    header: "Started",
    cell: ({ getValue }) => (
      <span className="text-gray-500">{formatRelativeDate(getValue() as number)}</span>
    ),
  },
  {
    id: "repo",
    header: "Repo",
    accessorFn: (row) => repoLabel(row),
    cell: ({ getValue }) => (
      <span className="font-mono text-xs text-gray-700 truncate max-w-48 block">{getValue() as string}</span>
    ),
  },
  {
    accessorKey: "harness_id",
    header: "Harness",
    cell: ({ getValue }) => <span className="text-gray-500 text-xs">{getValue() as string}</span>,
  },
  {
    accessorKey: "model_id",
    header: "Model",
    cell: ({ getValue }) => {
      const v = getValue() as string | null;
      return <span className="text-xs text-gray-600 truncate max-w-32 block">{v ?? "—"}</span>;
    },
  },
  {
    accessorKey: "cost_usd",
    header: "Cost",
    cell: ({ getValue }) => <span className="font-medium">{formatCost(getValue() as number)}</span>,
  },
  {
    accessorKey: "tokens",
    header: "Tokens",
    cell: ({ row }) => (
      <span title={`${formatTokens(row.original.billable_tokens)} billable · ${formatTokens(row.original.cached_tokens)} cached`}>
        {formatTokens(row.original.tokens)}
      </span>
    ),
  },
  {
    accessorKey: "output_tokens",
    header: "Output",
    cell: ({ getValue }) => formatTokens(getValue() as number),
  },
  {
    accessorKey: "turns",
    header: "Turns",
  },
  {
    accessorKey: "tool_calls",
    header: "Tools",
  },
  {
    accessorKey: "duration_ms",
    header: "Duration",
    cell: ({ getValue }) => formatDuration(getValue() as number | null),
  },
];

export default function SessionsPage() {
  const f = useFilters();
  const navigate = useNavigate();
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { filters } = f;
  const summary = useApi(() => api.summary(filters), [filters.from, filters.to, JSON.stringify(filters.harnesses)]);
  const compareSummary = useApi(
    () => f.compareRange ? api.summary({ ...filters, from: f.compareRange.from, to: f.compareRange.to }) : Promise.resolve(null),
    [filters.from, filters.to, JSON.stringify(filters.harnesses), f.compareRange?.from, f.compareRange?.to]
  );

  const load = useCallback(
    async (reset: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const result = await api.sessions({
          ...filters,
          limit: 50,
          cursor: reset ? undefined : cursor,
        });
        setRows((prev) => (reset ? result.rows : [...prev, ...result.rows]));
        setHasMore(result.nextCursor != null);
        setCursor(result.nextCursor ?? undefined);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filters.from, filters.to, JSON.stringify(filters.harnesses), filters.model, filters.repo, cursor]
  );

  useEffect(() => {
    setRows([]);
    setCursor(undefined);
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.from, filters.to, JSON.stringify(filters.harnesses), filters.model, filters.repo]);

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-gray-900 mb-3">Sessions</h1>
        <FilterBar f={f} showModel showRepo />
      </div>

      {summary.status === "ok" && f.compareRange && compareSummary.status === "ok" && compareSummary.data && (
        <div className="mb-4 rounded-lg border border-gray-200 bg-white p-3 text-sm text-gray-600">
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <span><strong className="text-gray-900">Current:</strong> {summary.data.sessions.toLocaleString()} sessions · {formatCost(summary.data.cost_usd)} · {summary.data.turns.toLocaleString()} turns</span>
            <span><strong className="text-gray-900">Comparison:</strong> {compareSummary.data.sessions.toLocaleString()} sessions · {formatCost(compareSummary.data.cost_usd)} · {compareSummary.data.turns.toLocaleString()} turns</span>
          </div>
          <div className="mt-1 text-xs text-gray-500">
            Δ {formatNumberDelta(summary.data.sessions, compareSummary.data.sessions)} sessions · {formatCostDelta(summary.data.cost_usd, compareSummary.data.cost_usd)} · {formatDeltaPercent(summary.data.cost_usd, compareSummary.data.cost_usd)} cost
          </div>
        </div>
      )}

      {error && (
        <div className="mb-4 text-red-600 text-sm bg-red-50 border border-red-200 rounded p-3">{error}</div>
      )}

      <div className="bg-white rounded-lg border border-gray-200">
        <DataTable
          data={rows}
          columns={columns}
          onRowClick={(row) => navigate(`/sessions/${row.id}`)}
          emptyMessage={loading ? "Loading…" : "No sessions found"}
        />
        {hasMore && (
          <div className="px-3 py-3 border-t border-gray-100">
            <button
              onClick={() => load(false)}
              disabled={loading}
              className="text-sm text-blue-600 hover:text-blue-700 disabled:text-gray-400"
            >
              {loading ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
