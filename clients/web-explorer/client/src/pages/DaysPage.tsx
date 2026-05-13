import { createSearchParams, useNavigate } from "react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { api, type DailyRow } from "../api.ts";
import DataTable from "../components/DataTable.tsx";
import { useApi } from "../hooks/useApi.ts";
import { useFilters } from "../hooks/useFilters.ts";
import { formatCost, formatPercent, formatTokens } from "../lib/format.ts";

function parseLocalDay(date: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
}

function dayRange(date: string): { from: number; to: number } {
  const from = parseLocalDay(date);
  const to = parseLocalDay(date);
  to.setHours(23, 59, 59, 999);
  return { from: from.getTime(), to: to.getTime() };
}

function costPerMtok(cost: number, tokens: number): string {
  if (tokens === 0) return "—";
  return formatCost(cost / tokens * 1_000_000);
}

const columns: ColumnDef<DailyRow>[] = [
  {
    accessorKey: "date",
    header: "Day",
    cell: ({ getValue }) => <span className="font-medium text-gray-900">{getValue() as string}</span>,
  },
  {
    accessorKey: "cost_usd",
    header: "Cost",
    cell: ({ getValue }) => <span className="font-medium">{formatCost(getValue() as number)}</span>,
  },
  {
    accessorKey: "billable_tokens",
    header: "Billable",
    cell: ({ getValue }) => formatTokens(getValue() as number),
  },
  {
    accessorKey: "tokens",
    header: "Total tokens",
    cell: ({ getValue }) => formatTokens(getValue() as number),
  },
  {
    accessorKey: "input_tokens",
    header: "Input",
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
    cell: ({ getValue }) => <span className="text-green-600">{formatTokens(getValue() as number)}</span>,
  },
  {
    accessorKey: "cache_read_tokens",
    header: "Cache read",
    cell: ({ getValue }) => formatTokens(getValue() as number),
  },
  {
    accessorKey: "cache_write_tokens",
    header: "Cache write",
    cell: ({ getValue }) => formatTokens(getValue() as number),
  },
  {
    accessorKey: "cached_cost_usd",
    header: "Cache cost",
    cell: ({ getValue }) => formatCost(getValue() as number),
  },
  {
    id: "cache_share",
    header: "Cache share",
    accessorFn: (row) => row.tokens === 0 ? 0 : row.cached_tokens / row.tokens,
    cell: ({ row }) => formatPercent(row.original.tokens === 0 ? 0 : row.original.cached_tokens / row.original.tokens),
  },
  {
    id: "cost_per_mtok",
    header: "$/1M billable",
    accessorFn: (row) => row.billable_tokens === 0 ? 0 : row.cost_usd / row.billable_tokens * 1_000_000,
    cell: ({ row }) => costPerMtok(row.original.cost_usd, row.original.billable_tokens),
  },
  {
    accessorKey: "turns",
    header: "Turns",
  },
];

function rangeLabel(from: number, to: number): string {
  const fmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
  return `${fmt.format(new Date(from))} – ${fmt.format(new Date(to))}`;
}

export default function DaysPage() {
  const f = useFilters();
  const navigate = useNavigate();
  const { filters } = f;
  const harnesses = useApi(() => api.harnesses(), []);
  const selectedHarness = filters.harnesses?.length === 1 ? filters.harnesses[0] : "";

  const result = useApi(
    () => api.daily(filters),
    [filters.from, filters.to, JSON.stringify(filters.harnesses)]
  );

  const rows = result.status === "ok" ? result.data.rows : [];

  return (
    <div className="p-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">Days</h1>
          <p className="mt-1 text-sm text-gray-500">{rangeLabel(filters.from, filters.to)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {harnesses.status === "ok" && harnesses.data.rows.length > 1 && (
            <label className="inline-flex items-center gap-1.5 text-xs text-gray-500">
              <span>Harness</span>
              <select
                value={selectedHarness}
                onChange={(e) => f.setHarnesses(e.target.value ? [e.target.value] : [])}
                className="h-8 rounded border border-gray-200 bg-white px-2 text-xs text-gray-700 shadow-sm"
              >
                <option value="">All</option>
                {harnesses.data.rows.map((h) => (
                  <option key={h.name} value={h.name}>{h.display_name}</option>
                ))}
              </select>
            </label>
          )}
          <div className="inline-flex h-8 overflow-hidden rounded border border-gray-200 bg-white shadow-sm">
            <button
              type="button"
              onClick={() => f.shiftPeriod(-1)}
              className="border-r border-gray-200 px-3 text-xs font-medium text-gray-600 hover:bg-gray-50"
            >
              ← Previous page
            </button>
            <button
              type="button"
              onClick={() => f.shiftPeriod(1)}
              disabled={!f.canShiftNext}
              className="px-3 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:bg-gray-50 disabled:text-gray-300"
            >
              Next page →
            </button>
          </div>
        </div>
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
            emptyMessage="No daily data"
            onRowClick={(row) => {
              const range = dayRange(row.date);
              const params = createSearchParams({
                from: String(range.from),
                to: String(range.to),
              });
              for (const harness of filters.harnesses ?? []) params.append("harness", harness);
              navigate({ pathname: "/sessions", search: `?${params.toString()}` });
            }}
          />
        )}
      </div>
    </div>
  );
}
