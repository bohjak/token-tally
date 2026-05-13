import { useApi } from "../hooks/useApi.ts";
import { api } from "../api.ts";
import TimeRangePicker from "./TimeRangePicker.tsx";
import type { CompareMode, UseFiltersResult } from "../hooks/useFilters.ts";

function toDateInput(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function endOfDay(value: string): Date {
  const date = new Date(value);
  date.setHours(23, 59, 59, 999);
  return date;
}

type Props = {
  f: UseFiltersResult;
  showModel?: boolean;
  showRepo?: boolean;
};

export default function FilterBar({ f, showModel = false, showRepo = false }: Props) {
  const harnesses = useApi(() => api.harnesses(), []);

  const selectedHarness = f.filters.harnesses?.length === 1 ? f.filters.harnesses[0] : "";
  const compareOptions: Array<{ value: CompareMode; label: string }> = [
    { value: "off", label: "Off" },
    { value: "previous-period", label: "Previous period" },
    { value: "previous-week", label: "Same period last week" },
    { value: "previous-month", label: "Same period last month" },
    { value: "custom", label: "Custom" },
  ];
  const hasExtraFilters = Boolean(
    f.filters.harnesses?.length || f.filters.model || f.filters.repo || f.compareMode !== "off" || f.activePreset !== f.defaultPreset
  );

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
      <TimeRangePicker
        activePreset={f.activePreset}
        from={f.filters.from}
        to={f.filters.to}
        onPreset={f.setPreset}
        onCustomRange={f.setCustomRange}
      />

      <div className="flex flex-wrap items-center gap-2">
        {harnesses.status === "ok" && harnesses.data.rows.length > 1 && (
          <label className="inline-flex items-center gap-1.5 text-xs text-gray-500">
            <span>Harness</span>
            <select
              value={selectedHarness}
              onChange={(e) => f.setHarnesses(e.target.value ? [e.target.value] : [])}
              className="h-8 rounded border border-gray-200 bg-white px-2 text-xs text-gray-700 shadow-sm"
              title="Filter by harness"
            >
              <option value="">All</option>
              {harnesses.data.rows.map((h) => (
                <option key={h.name} value={h.name}>{h.display_name}</option>
              ))}
            </select>
          </label>
        )}

        {showModel && (
          <input
            type="text"
            placeholder="Model filter…"
            value={f.filters.model ?? ""}
            onChange={(e) => f.setModel(e.target.value)}
            className="h-8 w-36 rounded border border-gray-200 bg-white px-2 text-xs text-gray-700 shadow-sm"
          />
        )}

        {showRepo && (
          <input
            type="text"
            placeholder="Repo filter…"
            value={f.filters.repo ?? ""}
            onChange={(e) => f.setRepo(e.target.value)}
            className="h-8 w-44 rounded border border-gray-200 bg-white px-2 text-xs text-gray-700 shadow-sm"
          />
        )}

        <label className="inline-flex items-center gap-1.5 text-xs text-gray-500">
          <span>Compare</span>
          <select
            value={f.compareMode}
            onChange={(e) => f.setCompareMode(e.target.value as CompareMode)}
            disabled={f.filters.from === 0}
            className="h-8 rounded border border-gray-200 bg-white px-2 text-xs text-gray-700 shadow-sm disabled:bg-gray-50 disabled:text-gray-400"
          >
            {compareOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>

        {f.compareMode === "custom" && (
          <div className="inline-flex h-8 items-center gap-1 rounded border border-gray-200 bg-white px-2 shadow-sm">
            <input
              type="date"
              value={toDateInput(f.compareRange?.from ?? f.filters.from)}
              onChange={(e) => {
                if (!e.target.value) return;
                f.setCustomCompareRange(new Date(e.target.value), new Date(f.compareRange?.to ?? f.filters.to));
              }}
              className="w-32 border-0 bg-transparent p-0 text-xs text-gray-700 outline-none"
            />
            <span className="text-gray-300 text-xs">—</span>
            <input
              type="date"
              value={toDateInput(f.compareRange?.to ?? f.filters.to)}
              onChange={(e) => {
                if (!e.target.value) return;
                f.setCustomCompareRange(new Date(f.compareRange?.from ?? f.filters.from), endOfDay(e.target.value));
              }}
              className="w-32 border-0 bg-transparent p-0 text-xs text-gray-700 outline-none"
            />
          </div>
        )}

        {f.compareRange && (
          <span className="rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-500">
            vs {f.compareRange.label}
          </span>
        )}

        {hasExtraFilters && (
          <button
            type="button"
            onClick={f.resetFilters}
            className="h-8 rounded border border-gray-200 bg-white px-2 text-xs text-gray-500 shadow-sm hover:text-gray-800"
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}
