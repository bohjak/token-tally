import { useFilters } from "../hooks/useFilters.ts";
import { useApi } from "../hooks/useApi.ts";
import { api, type ToolRow } from "../api.ts";
import FilterBar from "../components/FilterBar.tsx";
import DataTable from "../components/DataTable.tsx";
import { formatDuration, formatPercent } from "../lib/format.ts";
import { deltaClass, deltaTone, formatDurationDelta, formatNumberDelta } from "../lib/delta.ts";
import type { ColumnDef } from "@tanstack/react-table";

type ToolDisplayRow = ToolRow & {
  compare_calls: number | null;
  compare_error_rate: number | null;
  compare_p95_ms: number | null;
};

const columns: ColumnDef<ToolDisplayRow>[] = [
  {
    accessorKey: "tool_name",
    header: "Tool",
    cell: ({ getValue }) => (
      <span className="font-mono text-xs text-gray-800">{getValue() as string}</span>
    ),
  },
  {
    accessorKey: "calls",
    header: "Calls",
    cell: ({ getValue }) => <span className="font-medium">{(getValue() as number).toLocaleString()}</span>,
  },
  {
    id: "calls_delta",
    header: "Δ Calls",
    accessorFn: (row) => row.compare_calls == null ? 0 : row.calls - row.compare_calls,
    cell: ({ row }) => {
      const previous = row.original.compare_calls;
      if (previous == null) return <span className="text-gray-300">—</span>;
      return <span className="text-gray-500">{formatNumberDelta(row.original.calls, previous)}</span>;
    },
  },
  {
    accessorKey: "errors",
    header: "Errors",
    cell: ({ getValue }) => {
      const v = getValue() as number;
      return <span className={v > 0 ? "text-red-600" : "text-gray-400"}>{v}</span>;
    },
  },
  {
    accessorKey: "error_rate",
    header: "Error rate",
    cell: ({ getValue }) => {
      const v = getValue() as number;
      return <span className={v > 0.05 ? "text-red-600" : "text-gray-500"}>{formatPercent(v)}</span>;
    },
  },
  {
    id: "error_rate_delta",
    header: "Δ Err rate",
    accessorFn: (row) => row.compare_error_rate == null ? 0 : row.error_rate - row.compare_error_rate,
    cell: ({ row }) => {
      const previous = row.original.compare_error_rate;
      if (previous == null) return <span className="text-gray-300">—</span>;
      const tone = deltaTone(row.original.error_rate, previous, true);
      const diff = row.original.error_rate - previous;
      const sign = diff >= 0 ? "+" : "−";
      return <span className={deltaClass(tone)}>{sign}{formatPercent(Math.abs(diff))}</span>;
    },
  },
  {
    accessorKey: "p50_ms",
    header: "p50",
    cell: ({ getValue }) => formatDuration(getValue() as number),
  },
  {
    accessorKey: "p95_ms",
    header: "p95",
    cell: ({ getValue }) => formatDuration(getValue() as number),
  },
  {
    id: "p95_delta",
    header: "Δ p95",
    accessorFn: (row) => row.compare_p95_ms == null ? 0 : row.p95_ms - row.compare_p95_ms,
    cell: ({ row }) => {
      const previous = row.original.compare_p95_ms;
      if (previous == null) return <span className="text-gray-300">—</span>;
      const tone = deltaTone(row.original.p95_ms, previous, true);
      return <span className={deltaClass(tone)}>{formatDurationDelta(row.original.p95_ms, previous)}</span>;
    },
  },
  {
    accessorKey: "total_duration_ms",
    header: "Total time",
    cell: ({ getValue }) => formatDuration(getValue() as number),
  },
];

export default function ToolsPage() {
  const f = useFilters();
  const { filters } = f;

  const result = useApi(
    () => api.tools(filters),
    [filters.from, filters.to, JSON.stringify(filters.harnesses)]
  );
  const compareResult = useApi(
    () => f.compareRange ? api.tools({ ...filters, from: f.compareRange.from, to: f.compareRange.to }) : Promise.resolve(null),
    [filters.from, filters.to, JSON.stringify(filters.harnesses), f.compareRange?.from, f.compareRange?.to]
  );

  const compareByKey = new Map(
    compareResult.status === "ok" && compareResult.data
      ? compareResult.data.rows.map((row) => [row.tool_name, row])
      : []
  );
  const rows: ToolDisplayRow[] = result.status === "ok"
    ? result.data.rows.map((row) => {
        const compare = compareByKey.get(row.tool_name);
        return {
          ...row,
          compare_calls: compare?.calls ?? null,
          compare_error_rate: compare?.error_rate ?? null,
          compare_p95_ms: compare?.p95_ms ?? null,
        };
      })
    : [];

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-gray-900 mb-3">Tools</h1>
        <FilterBar f={f} />
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
          <DataTable data={rows} columns={columns} emptyMessage="No tool call data" />
        )}
      </div>
    </div>
  );
}
