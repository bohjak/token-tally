import { useParams, useNavigate, Link } from "react-router";
import { useApi } from "../hooks/useApi.ts";
import { useRefreshNonce } from "../hooks/useRefreshSignal";
import { api, type TurnRow } from "../api.ts";
import StatCard from "../components/StatCard.tsx";
import DataTable from "../components/DataTable.tsx";
import { formatCost, formatTokens, formatDuration, formatDate, formatPercent } from "../lib/format.ts";
import type { ColumnDef } from "@tanstack/react-table";

function repoLabel(s: { repo_owner: string | null; repo_name: string | null; repo_remote: string | null; cwd: string | null }): string {
  if (s.repo_owner && s.repo_name) return `${s.repo_owner}/${s.repo_name}`;
  if (s.repo_remote) return s.repo_remote;
  if (s.cwd) return s.cwd;
  return "unknown";
}

export default function SessionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const refreshNonce = useRefreshNonce();

  const result = useApi(() => api.session(id!), [id, refreshNonce]);

  const turnColumns: ColumnDef<TurnRow>[] = [
    {
      accessorKey: "turn_index",
      header: "#",
      cell: ({ getValue }) => <span className="text-gray-400">{(getValue() as number | null) ?? "—"}</span>,
    },
    {
      accessorKey: "model_id",
      header: "Model",
      cell: ({ getValue }) => (
        <span className="text-xs font-mono text-gray-600">{(getValue() as string | null) ?? "—"}</span>
      ),
    },
    {
      accessorKey: "cost_usd",
      header: "Cost",
      cell: ({ getValue }) => <span className="font-medium">{formatCost(getValue() as number)}</span>,
    },
    {
      accessorKey: "input_tokens",
      header: "In tokens",
      cell: ({ getValue }) => formatTokens(getValue() as number),
    },
    {
      accessorKey: "output_tokens",
      header: "Out tokens",
      cell: ({ getValue }) => formatTokens(getValue() as number),
    },
    {
      id: "cache_hit",
      header: "Cache hit",
      accessorFn: (row) =>
        row.input_tokens + row.cached_tokens > 0
          ? row.cached_tokens / (row.input_tokens + row.cached_tokens)
          : 0,
      cell: ({ getValue }) => (
        <span className="text-green-600">{formatPercent(getValue() as number)}</span>
      ),
    },
    {
      accessorKey: "tool_call_count",
      header: "Tools",
    },
    {
      accessorKey: "error_count",
      header: "Errors",
      cell: ({ getValue }) => {
        const v = getValue() as number;
        return <span className={v > 0 ? "text-red-600" : "text-gray-400"}>{v}</span>;
      },
    },
    {
      accessorKey: "duration_ms",
      header: "Duration",
      cell: ({ getValue }) => formatDuration(getValue() as number | null),
    },
  ];

  if (result.status === "loading") {
    return <div className="p-6 text-gray-400 text-sm">Loading…</div>;
  }

  if (result.status === "error") {
    return (
      <div className="p-6 text-red-600 text-sm bg-red-50 border border-red-200 rounded m-6">
        {result.error}
      </div>
    );
  }

  const { session, cost, turns, topTools } = result.data;

  return (
    <div className="p-6 max-w-5xl">
      {/* Breadcrumb */}
      <div className="text-xs text-gray-400 mb-4">
        <Link to="/sessions" className="hover:text-blue-600">Sessions</Link>
        <span className="mx-1">›</span>
        <span className="text-gray-600">{repoLabel(session)}</span>
      </div>

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-gray-900">{repoLabel(session)}</h1>
        <div className="flex gap-4 text-xs text-gray-500 mt-1">
          <span>{session.harness_id}</span>
          <span>{formatDate(session.started_at)}</span>
          {session.duration_ms && <span>{formatDuration(session.duration_ms)}</span>}
          {session.cwd && <span className="font-mono truncate max-w-xs">{session.cwd}</span>}
        </div>
      </div>

      {/* Cost stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard label="Total cost" value={formatCost(cost.cost_usd)} />
        <StatCard
          label="Billable tokens"
          value={formatTokens(cost.billable_tokens)}
          sub={`${formatTokens(cost.cached_tokens)} cached`}
        />
        <StatCard label="Turns" value={String(session.turns)} />
        <StatCard label="Cache savings" value={formatCost(cost.cache_savings_usd)} />
      </div>

      {/* Top tools */}
      {topTools.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6">
          <h2 className="text-sm font-medium text-gray-700 mb-3">Top tools</h2>
          <div className="flex flex-wrap gap-2">
            {topTools.map((t) => (
              <span key={t.tool_name} className="inline-flex items-center gap-1 text-xs bg-gray-100 rounded px-2 py-1">
                <span className="font-mono text-gray-700">{t.tool_name}</span>
                <span className="text-gray-400">{t.calls}×</span>
                {t.errors > 0 && <span className="text-red-500">{t.errors} err</span>}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Turns table */}
      <div className="bg-white rounded-lg border border-gray-200">
        <div className="px-4 py-3 border-b border-gray-100">
          <h2 className="text-sm font-medium text-gray-700">Turns</h2>
        </div>
        <DataTable
          data={turns}
          columns={turnColumns}
          onRowClick={(row) => navigate(`/sessions/${id}/turns/${row.id}`)}
          emptyMessage="No turns recorded"
        />
      </div>
    </div>
  );
}
