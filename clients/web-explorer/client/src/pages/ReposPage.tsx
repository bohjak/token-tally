import { useNavigate, createSearchParams } from "react-router";
import { useFilters } from "../hooks/useFilters.ts";
import { useApi } from "../hooks/useApi.ts";
import { api, type RepoRow } from "../api.ts";
import FilterBar from "../components/FilterBar.tsx";
import DataTable from "../components/DataTable.tsx";
import { formatCost, formatTokens } from "../lib/format.ts";
import { deltaClass, deltaTone, formatCostDelta, formatDeltaPercent, formatNumberDelta } from "../lib/delta.ts";
import type { ColumnDef } from "@tanstack/react-table";

type RepoDisplayRow = RepoRow & {
  compare_cost_usd: number | null;
  compare_sessions: number | null;
  compare_billable_tokens: number | null;
  compare_output_tokens: number | null;
};

const columns: ColumnDef<RepoDisplayRow>[] = [
  {
    accessorKey: "repo",
    header: "Repo",
    cell: ({ getValue }) => (
      <span className="font-mono text-xs text-gray-800 break-all">{getValue() as string}</span>
    ),
  },
  {
    accessorKey: "harness_id",
    header: "Harness",
    cell: ({ getValue }) => <span className="text-xs text-gray-500">{getValue() as string}</span>,
  },
  {
    accessorKey: "cost_usd",
    header: "Cost",
    cell: ({ getValue }) => <span className="font-medium">{formatCost(getValue() as number)}</span>,
  },
  {
    id: "cost_delta",
    header: "Δ Cost",
    accessorFn: (row) => row.compare_cost_usd == null ? 0 : row.cost_usd - row.compare_cost_usd,
    cell: ({ row }) => {
      const previous = row.original.compare_cost_usd;
      if (previous == null) return <span className="text-gray-300">—</span>;
      const tone = deltaTone(row.original.cost_usd, previous, true);
      return <span className={deltaClass(tone)}>{formatCostDelta(row.original.cost_usd, previous)} · {formatDeltaPercent(row.original.cost_usd, previous)}</span>;
    },
  },
  {
    accessorKey: "billable_tokens",
    header: "Billable tokens",
    cell: ({ getValue }) => formatTokens(getValue() as number),
  },
  {
    id: "billable_delta",
    header: "Δ Billable",
    accessorFn: (row) => row.compare_billable_tokens == null ? 0 : row.billable_tokens - row.compare_billable_tokens,
    cell: ({ row }) => {
      const previous = row.original.compare_billable_tokens;
      if (previous == null) return <span className="text-gray-300">—</span>;
      return <span className="text-gray-500">{formatNumberDelta(row.original.billable_tokens, previous)}</span>;
    },
  },
  {
    accessorKey: "tokens",
    header: "Total tokens",
    cell: ({ getValue }) => formatTokens(getValue() as number),
  },
  {
    accessorKey: "output_tokens",
    header: "Output",
    cell: ({ getValue }) => formatTokens(getValue() as number),
  },
  {
    accessorKey: "cached_tokens",
    header: "Cached",
    cell: ({ getValue }) => formatTokens(getValue() as number),
  },
  {
    accessorKey: "sessions",
    header: "Sessions",
  },
  {
    id: "sessions_delta",
    header: "Δ Sessions",
    accessorFn: (row) => row.compare_sessions == null ? 0 : row.sessions - row.compare_sessions,
    cell: ({ row }) => {
      const previous = row.original.compare_sessions;
      if (previous == null) return <span className="text-gray-300">—</span>;
      return <span className="text-gray-500">{formatNumberDelta(row.original.sessions, previous)}</span>;
    },
  },
  {
    accessorKey: "top_tool",
    header: "Top tool",
    cell: ({ getValue }) => {
      const v = getValue() as string | null;
      return v ? <span className="font-mono text-xs text-gray-600">{v}</span> : <span className="text-gray-300">—</span>;
    },
  },
];

export default function ReposPage() {
  const f = useFilters();
  const navigate = useNavigate();
  const { filters } = f;

  const result = useApi(
    () => api.repos(filters),
    [filters.from, filters.to, JSON.stringify(filters.harnesses), filters.repo]
  );
  const compareResult = useApi(
    () => f.compareRange ? api.repos({ ...filters, from: f.compareRange.from, to: f.compareRange.to }) : Promise.resolve(null),
    [filters.from, filters.to, JSON.stringify(filters.harnesses), filters.repo, f.compareRange?.from, f.compareRange?.to]
  );

  const compareByKey = new Map(
    compareResult.status === "ok" && compareResult.data
      ? compareResult.data.rows.map((row) => [`${row.harness_id}:${row.repo}`, row])
      : []
  );
  const rows: RepoDisplayRow[] = result.status === "ok"
    ? result.data.rows.map((row) => {
        const compare = compareByKey.get(`${row.harness_id}:${row.repo}`);
        return {
          ...row,
          compare_cost_usd: compare?.cost_usd ?? null,
          compare_sessions: compare?.sessions ?? null,
          compare_billable_tokens: compare?.billable_tokens ?? null,
          compare_output_tokens: compare?.output_tokens ?? null,
        };
      })
    : [];

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-gray-900 mb-3">Repos</h1>
        <FilterBar f={f} showRepo />
      </div>

      {result.status === "error" && (
        <div className="mb-4 text-red-600 text-sm bg-red-50 border border-red-200 rounded p-3">
          {result.error}
        </div>
      )}

      <div className="bg-white rounded-lg border border-gray-200">
        {result.status === "loading" && (
          <div className="p-8 text-center text-gray-400 text-sm">Loading…</div>
        )}
        {result.status === "ok" && (
          <DataTable
            data={rows}
            columns={columns}
            emptyMessage="No repo data"
            onRowClick={(row) => {
              const params = createSearchParams({
                from: String(filters.from),
                to: String(filters.to),
                repo: row.repo,
              });
              if (f.activePreset) params.set("preset", f.activePreset);
              if (f.compareMode !== "off") params.set("compare", f.compareMode);
              if (f.compareRange && f.compareMode === "custom") {
                params.set("compareFrom", String(f.compareRange.from));
                params.set("compareTo", String(f.compareRange.to));
              }
              for (const harness of filters.harnesses ?? []) params.append("harness", harness);
              navigate({ pathname: "/sessions", search: `?${params.toString()}` });
            }}
          />
        )}
      </div>
    </div>
  );
}
