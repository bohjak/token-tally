import { useNavigate, createSearchParams } from "react-router";
import { useFilters } from "../hooks/useFilters.ts";
import { useApi } from "../hooks/useApi.ts";
import { useRefreshNonce } from "../hooks/useRefreshSignal";
import { api, type ModelRow } from "../api.ts";
import FilterBar from "../components/FilterBar.tsx";
import DataTable from "../components/DataTable.tsx";
import { formatCost, formatTokens, formatPercent } from "../lib/format.ts";
import { deltaClass, deltaTone, formatCostDelta, formatDeltaPercent, formatNumberDelta } from "../lib/delta.ts";
import type { ColumnDef } from "@tanstack/react-table";

type ModelDisplayRow = ModelRow & {
  compare_cost_usd: number | null;
  compare_turns: number | null;
  compare_billable_tokens: number | null;
  compare_tokens_out: number | null;
};

const columns: ColumnDef<ModelDisplayRow>[] = [
  {
    accessorKey: "model_id",
    header: "Model",
    cell: ({ getValue }) => (
      <span className="font-mono text-xs text-gray-800">{getValue() as string}</span>
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
    accessorKey: "share",
    header: "Share",
    cell: ({ getValue }) => (
      <div className="flex items-center gap-2">
        <div className="h-1.5 rounded bg-blue-200 w-20">
          <div
            className="h-full rounded bg-blue-500"
            style={{ width: `${Math.min((getValue() as number) * 100, 100)}%` }}
          />
        </div>
        <span className="text-xs text-gray-500">{formatPercent(getValue() as number)}</span>
      </div>
    ),
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
    header: "Billable",
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
    accessorKey: "tokens_out",
    header: "Output",
    cell: ({ getValue }) => formatTokens(getValue() as number),
  },
  {
    id: "output_delta",
    header: "Δ Output",
    accessorFn: (row) => row.compare_tokens_out == null ? 0 : row.tokens_out - row.compare_tokens_out,
    cell: ({ row }) => {
      const previous = row.original.compare_tokens_out;
      if (previous == null) return <span className="text-gray-300">—</span>;
      return <span className="text-gray-500">{formatNumberDelta(row.original.tokens_out, previous)}</span>;
    },
  },
  {
    accessorKey: "cached_tokens",
    header: "Cached",
    cell: ({ getValue }) => <span className="text-green-600">{formatTokens(getValue() as number)}</span>,
  },
  {
    accessorKey: "cache_hit_rate",
    header: "Cache hit",
    cell: ({ getValue }) => (
      <span className="text-green-600">{formatPercent(getValue() as number)}</span>
    ),
  },
  {
    accessorKey: "turns",
    header: "Turns",
  },
  {
    id: "turns_delta",
    header: "Δ Turns",
    accessorFn: (row) => row.compare_turns == null ? 0 : row.turns - row.compare_turns,
    cell: ({ row }) => {
      const previous = row.original.compare_turns;
      if (previous == null) return <span className="text-gray-300">—</span>;
      return <span className="text-gray-500">{formatNumberDelta(row.original.turns, previous)}</span>;
    },
  },
  {
    accessorKey: "avg_tokens_per_turn",
    header: "Avg tokens/turn",
    cell: ({ getValue }) => formatTokens(getValue() as number),
  },
];

export default function ModelsPage() {
  const f = useFilters();
  const navigate = useNavigate();
  const { filters } = f;
  const refreshNonce = useRefreshNonce();

  const result = useApi(
    () => api.models(filters),
    [filters.from, filters.to, JSON.stringify(filters.harnesses), filters.model, refreshNonce]
  );
  const compareResult = useApi(
    () => f.compareRange ? api.models({ ...filters, from: f.compareRange.from, to: f.compareRange.to }) : Promise.resolve(null),
    [filters.from, filters.to, JSON.stringify(filters.harnesses), filters.model, f.compareRange?.from, f.compareRange?.to, refreshNonce]
  );

  const compareByKey = new Map(
    compareResult.status === "ok" && compareResult.data
      ? compareResult.data.rows.map((row) => [`${row.harness_id}:${row.model_id}`, row])
      : []
  );
  const rows: ModelDisplayRow[] = result.status === "ok"
    ? result.data.rows.map((row) => {
        const compare = compareByKey.get(`${row.harness_id}:${row.model_id}`);
        return {
          ...row,
          compare_cost_usd: compare?.cost_usd ?? null,
          compare_turns: compare?.turns ?? null,
          compare_billable_tokens: compare?.billable_tokens ?? null,
          compare_tokens_out: compare?.tokens_out ?? null,
        };
      })
    : [];

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-gray-900 mb-3">Models</h1>
        <FilterBar f={f} showModel />
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
          <>
            <DataTable
              data={rows}
              columns={columns}
              emptyMessage="No model data"
              onRowClick={(row) => {
                const params = createSearchParams({
                  from: String(filters.from),
                  to: String(filters.to),
                  model: row.model_id,
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
            {result.data.unpriced_count > 0 && (
              <div className="px-4 py-2 border-t border-gray-100 text-xs text-gray-400">
                {result.data.unpriced_count} unpriced messages excluded from totals
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
