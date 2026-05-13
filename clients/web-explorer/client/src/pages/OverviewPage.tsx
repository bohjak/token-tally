import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useApi } from "../hooks/useApi.ts";
import { useFilters } from "../hooks/useFilters.ts";
import { api, type DailyRow, type Filters, type HourlyRow, type ModelRow, type RepoRow, type ToolRow } from "../api.ts";
import StatCard from "../components/StatCard.tsx";
import CostChart, { metricLabels, type ChartMetric } from "../components/CostChart.tsx";
import FilterBar from "../components/FilterBar.tsx";
import { formatCost, formatPercent, formatTokens } from "../lib/format.ts";
import { deltaTone, formatCostDelta, formatDeltaPercent, formatNumberDelta } from "../lib/delta.ts";

const dayMs = 24 * 60 * 60 * 1000;

function deltaText(current: number, previous: number, unit: "cost" | "number" = "number"): string {
  const absolute = unit === "cost" ? formatCostDelta(current, previous) : formatNumberDelta(current, previous);
  return previous === 0 ? `${absolute} vs comparison` : `${formatDeltaPercent(current, previous)} vs comparison`;
}

type ChartData = { rows: Array<DailyRow | HourlyRow>; unpriced_count: number };
type RankedRow = { id: string; label: string; value: number; detail: string; href?: string };

function comparisonFilters(filters: Filters, range: { from: number; to: number }): Filters {
  return { ...filters, from: range.from, to: range.to };
}

function effectiveCostPerMtok(cost: number, tokens: number): string {
  if (tokens === 0) return "—";
  return formatCost(cost / tokens * 1_000_000);
}

function useHourlyRange(from: number, to: number): boolean {
  return to - from <= 2 * dayMs;
}

function periodLabel(from: number, to: number): string {
  if (from === 0) return "all time";
  const days = (to - from) / dayMs;
  if (days > 0.95 && days < 1.05) return "1 day";
  if (days > 6.8 && days < 7.2) return "7 days";
  if (days > 29 && days < 31) return "30 days";
  return `${Math.max(1, Math.round(days))} days`;
}

function navPeriodLabel(from: number, to: number): string {
  const label = periodLabel(from, to);
  if (label === "1 day") return "day";
  if (label === "7 days") return "week";
  if (label === "30 days") return "month";
  return label;
}

function rangeLabel(from: number, to: number): string {
  if (from === 0) return "All recorded analytics";
  const fmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
  return `${fmt.format(new Date(from))} – ${fmt.format(new Date(to))}`;
}

function metricDelta(current: number, previous: number, inverse = false) {
  return {
    text: deltaText(current, previous, inverse ? "cost" : "number"),
    tone: inverse ? deltaTone(current, previous, true) : "neutral" as const,
  };
}

function compactNumber(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function LoadingPanel() {
  return <div className="h-48 animate-pulse rounded-lg bg-gray-50" />;
}

function RankedBars({ rows, empty, valueFormatter }: { rows: RankedRow[]; empty: string; valueFormatter: (value: number) => string }) {
  const max = Math.max(...rows.map((row) => row.value), 0);
  if (rows.length === 0) return <div className="py-8 text-center text-sm text-gray-400">{empty}</div>;

  return (
    <div className="space-y-3">
      {rows.map((row) => {
        const body = (
          <>
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="truncate font-medium text-gray-800">{row.label}</span>
              <span className="shrink-0 tabular-nums text-gray-900">{valueFormatter(row.value)}</span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-gray-100">
              <div
                className="h-full rounded-full bg-blue-500"
                style={{ width: `${max > 0 ? Math.max(3, row.value / max * 100) : 0}%` }}
              />
            </div>
            <div className="mt-1 truncate text-xs text-gray-400">{row.detail}</div>
          </>
        );
        return row.href ? (
          <Link key={row.id} to={row.href} className="block rounded-md p-1 hover:bg-gray-50">{body}</Link>
        ) : (
          <div key={row.id} className="rounded-md p-1">{body}</div>
        );
      })}
    </div>
  );
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-medium text-gray-700">{title}</h2>
      {children}
    </div>
  );
}

export default function OverviewPage() {
  const f = useFilters("1d");
  const { filters, compareRange } = f;
  const [chartMetric, setChartMetric] = useState<ChartMetric>("cost_usd");
  const useHourly = useHourlyRange(filters.from, filters.to);
  const harnessKey = JSON.stringify(filters.harnesses);

  const summary = useApi(() => api.summary(filters), [filters.from, filters.to, harnessKey]);
  const daily = useApi<ChartData>(
    () => useHourly ? api.hourly(filters) : api.daily(filters),
    [filters.from, filters.to, harnessKey, useHourly]
  );
  const components = useApi(() => api.components(filters), [filters.from, filters.to, harnessKey]);
  const models = useApi(() => api.models(filters), [filters.from, filters.to, harnessKey]);
  const repos = useApi(() => api.repos(filters), [filters.from, filters.to, harnessKey]);
  const tools = useApi(() => api.tools(filters), [filters.from, filters.to, harnessKey]);
  const compareSummary = useApi(
    () => compareRange ? api.summary(comparisonFilters(filters, compareRange)) : Promise.resolve(null),
    [filters.from, filters.to, harnessKey, compareRange?.from, compareRange?.to]
  );
  const compareDaily = useApi<ChartData | null>(
    () => compareRange
      ? useHourly ? api.hourly(comparisonFilters(filters, compareRange)) : api.daily(comparisonFilters(filters, compareRange))
      : Promise.resolve(null),
    [filters.from, filters.to, harnessKey, compareRange?.from, compareRange?.to, useHourly]
  );

  const modelRows = useMemo((): RankedRow[] => {
    if (models.status !== "ok") return [];
    return models.data.rows.slice(0, 6).map((row: ModelRow) => ({
      id: `${row.harness_id}:${row.model_id}`,
      label: row.model_id,
      value: row.cost_usd,
      detail: `${row.harness_id} · ${formatTokens(row.billable_tokens)} billable · ${row.turns.toLocaleString()} turns`,
      href: `/models?model=${encodeURIComponent(row.model_id)}&from=${filters.from}&to=${filters.to}`,
    }));
  }, [filters.from, filters.to, models]);

  const harnessRows = useMemo((): RankedRow[] => {
    if (models.status !== "ok") return [];
    const byHarness = new Map<string, { cost: number; turns: number; tokens: number }>();
    for (const row of models.data.rows) {
      const current = byHarness.get(row.harness_id) ?? { cost: 0, turns: 0, tokens: 0 };
      current.cost += row.cost_usd;
      current.turns += row.turns;
      current.tokens += row.billable_tokens;
      byHarness.set(row.harness_id, current);
    }
    return Array.from(byHarness.entries())
      .map(([harness, row]) => ({
        id: harness,
        label: harness,
        value: row.cost,
        detail: `${formatTokens(row.tokens)} billable · ${row.turns.toLocaleString()} turns`,
      }))
      .sort((a, b) => b.value - a.value);
  }, [models]);

  const repoRows = useMemo((): RankedRow[] => {
    if (repos.status !== "ok") return [];
    return repos.data.rows.slice(0, 6).map((row: RepoRow) => ({
      id: `${row.harness_id}:${row.repo}`,
      label: row.repo,
      value: row.cost_usd,
      detail: `${row.harness_id} · ${row.sessions.toLocaleString()} sessions · ${row.top_tool ?? "no tool data"}`,
      href: `/repos?repo=${encodeURIComponent(row.repo)}&from=${filters.from}&to=${filters.to}`,
    }));
  }, [filters.from, filters.to, repos]);

  const toolRows = useMemo((): RankedRow[] => {
    if (tools.status !== "ok") return [];
    return tools.data.rows.slice(0, 6).map((row: ToolRow) => ({
      id: row.tool_name,
      label: row.tool_name,
      value: row.calls,
      detail: `${row.errors.toLocaleString()} errors · ${formatPercent(row.error_rate)} error rate`,
      href: `/tools?from=${filters.from}&to=${filters.to}`,
    }));
  }, [filters.from, filters.to, tools]);

  const compareData = compareSummary.status === "ok" ? compareSummary.data : null;
  const currentMessages = summary.status === "ok" ? summary.data.messages ?? 0 : 0;
  const compareMessages = compareData?.messages ?? 0;

  return (
    <div className="max-w-7xl p-6">
      <div className="mb-6 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-blue-600">Daily analytics</div>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-gray-950">Interactive day report</h1>
            <p className="mt-1 text-sm text-gray-500">
              {rangeLabel(filters.from, filters.to)} · {periodLabel(filters.from, filters.to)}
              {compareRange ? ` · compared with ${compareRange.label}` : ""}
            </p>
          </div>
          <div className="inline-flex h-9 overflow-hidden rounded border border-gray-200 bg-white shadow-sm">
            <button
              type="button"
              onClick={() => f.shiftPeriod(-1)}
              disabled={filters.from === 0}
              className="border-r border-gray-200 px-3 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:bg-gray-50 disabled:text-gray-300"
            >
              ← Previous {navPeriodLabel(filters.from, filters.to)}
            </button>
            <button
              type="button"
              onClick={() => f.shiftPeriod(1)}
              disabled={!f.canShiftNext}
              className="px-3 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:bg-gray-50 disabled:text-gray-300"
            >
              Next {navPeriodLabel(filters.from, filters.to)} →
            </button>
          </div>
        </div>
        <FilterBar f={f} />
      </div>

      {summary.status === "ok" && (
        <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
          <StatCard
            label="Total cost"
            value={formatCost(summary.data.cost_usd)}
            sub={summary.data.unpriced_count > 0 ? `+${summary.data.unpriced_count} unpriced messages` : "priced messages only"}
            delta={compareData ? {
              text: deltaText(summary.data.cost_usd, compareData.cost_usd, "cost"),
              tone: deltaTone(summary.data.cost_usd, compareData.cost_usd, true),
            } : undefined}
          />
          <StatCard
            label="Billable tokens"
            value={formatTokens(summary.data.billable_tokens)}
            sub={`${formatTokens(summary.data.input_tokens)} in · ${formatTokens(summary.data.output_tokens)} out`}
            delta={compareData ? metricDelta(summary.data.billable_tokens, compareData.billable_tokens) : undefined}
          />
          <StatCard
            label="Total tokens"
            value={formatTokens(summary.data.tokens)}
            sub={`${formatTokens(summary.data.cached_tokens)} cached`}
            delta={compareData ? metricDelta(summary.data.tokens, compareData.tokens) : undefined}
          />
          <StatCard
            label="Messages"
            value={currentMessages.toLocaleString()}
            sub={`${summary.data.turns.toLocaleString()} turns`}
            delta={compareData ? metricDelta(currentMessages, compareMessages) : undefined}
          />
          <StatCard
            label="Sessions"
            value={summary.data.sessions.toLocaleString()}
            sub={`${formatTokens(summary.data.turns ? summary.data.tokens / summary.data.turns : 0)} avg tok/turn`}
            delta={compareData ? metricDelta(summary.data.sessions, compareData.sessions) : undefined}
          />
          <StatCard
            label="Cached tokens"
            value={formatTokens(summary.data.cached_tokens)}
            sub={formatCost(summary.data.cached_cost_usd)}
            delta={compareData ? metricDelta(summary.data.cached_tokens, compareData.cached_tokens) : undefined}
          />
          <StatCard
            label="Effective $/1M"
            value={effectiveCostPerMtok(summary.data.cost_usd, summary.data.billable_tokens)}
            sub="per billable token"
            delta={compareData ? {
              text: deltaText(
                summary.data.billable_tokens ? summary.data.cost_usd / summary.data.billable_tokens : 0,
                compareData.billable_tokens ? compareData.cost_usd / compareData.billable_tokens : 0,
                "cost"
              ),
              tone: deltaTone(
                summary.data.billable_tokens ? summary.data.cost_usd / summary.data.billable_tokens : 0,
                compareData.billable_tokens ? compareData.cost_usd / compareData.billable_tokens : 0,
                true
              ),
            } : undefined}
          />
          <StatCard
            label="Cache savings"
            value={formatCost(summary.data.cache_savings_usd)}
            sub="estimated avoided input cost"
            delta={compareData ? {
              text: deltaText(summary.data.cache_savings_usd, compareData.cache_savings_usd, "cost"),
              tone: deltaTone(summary.data.cache_savings_usd, compareData.cache_savings_usd),
            } : undefined}
          />
        </div>
      )}

      {summary.status === "loading" && (
        <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-lg border border-gray-200 bg-white" />
          ))}
        </div>
      )}

      {summary.status === "error" && (
        <div className="mb-6 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-600">
          {summary.error}
        </div>
      )}

      <div className="mb-6 grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(340px,1fr)]">
        <SectionCard title={`${useHourly ? "Hourly" : "Daily"} trend`}>
          <div className="mb-3 flex flex-wrap gap-1">
            {(Object.keys(metricLabels) as ChartMetric[]).map((metric) => (
              <button
                key={metric}
                type="button"
                onClick={() => setChartMetric(metric)}
                className={`rounded-full border px-2 py-1 text-xs ${chartMetric === metric ? "border-blue-300 bg-blue-50 text-blue-700" : "border-gray-200 bg-white text-gray-500"}`}
              >
                {metricLabels[metric]}
              </button>
            ))}
          </div>
          {daily.status === "ok" && (
            <CostChart
              rows={daily.data.rows}
              compareRows={compareDaily.status === "ok" && compareDaily.data ? compareDaily.data.rows : undefined}
              metric={chartMetric}
              granularity={useHourly ? "hourly" : "daily"}
            />
          )}
          {daily.status === "loading" && <LoadingPanel />}
          {daily.status === "error" && <div className="text-sm text-red-600">{daily.error}</div>}
        </SectionCard>

        <SectionCard title="Token and cost mix">
          {components.status === "ok" && (
            <div className="space-y-3">
              {components.data.rows.map((row) => (
                <div key={row.component}>
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-gray-800">{row.label}</span>
                    <span className="tabular-nums text-gray-900">{formatCost(row.cost_usd)}</span>
                  </div>
                  <div className="mt-1 flex h-2 overflow-hidden rounded-full bg-gray-100">
                    <div className="rounded-full bg-emerald-500" style={{ width: `${Math.max(2, row.cost_share * 100)}%` }} />
                  </div>
                  <div className="mt-1 flex justify-between text-xs text-gray-400">
                    <span>{formatTokens(row.tokens)} · {formatPercent(row.token_share)} tokens</span>
                    <span>{effectiveCostPerMtok(row.cost_usd, row.tokens)}/1M</span>
                  </div>
                </div>
              ))}
            </div>
          )}
          {components.status === "loading" && <LoadingPanel />}
          {components.status === "error" && <div className="text-sm text-red-600">{components.error}</div>}
        </SectionCard>
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
        <SectionCard title="Model usage by cost">
          {models.status === "ok" ? <RankedBars rows={modelRows} empty="No model usage" valueFormatter={formatCost} /> : models.status === "loading" ? <LoadingPanel /> : <div className="text-sm text-red-600">{models.error}</div>}
        </SectionCard>
        <SectionCard title="Harness usage by cost">
          {models.status === "ok" ? <RankedBars rows={harnessRows} empty="No harness usage" valueFormatter={formatCost} /> : models.status === "loading" ? <LoadingPanel /> : <div className="text-sm text-red-600">{models.error}</div>}
        </SectionCard>
        <SectionCard title="Repositories by cost">
          {repos.status === "ok" ? <RankedBars rows={repoRows} empty="No repository usage" valueFormatter={formatCost} /> : repos.status === "loading" ? <LoadingPanel /> : <div className="text-sm text-red-600">{repos.error}</div>}
        </SectionCard>
        <SectionCard title="Tool calls">
          {tools.status === "ok" ? <RankedBars rows={toolRows} empty="No tool calls" valueFormatter={compactNumber} /> : tools.status === "loading" ? <LoadingPanel /> : <div className="text-sm text-red-600">{tools.error}</div>}
        </SectionCard>
      </div>

      {components.status === "ok" && (
        <div className="mb-6 rounded-lg border border-gray-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-medium text-gray-700">Detailed component ledger</h2>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="py-2 pr-3 text-left font-medium">Component</th>
                  <th className="px-3 py-2 text-right font-medium">Tokens</th>
                  <th className="px-3 py-2 text-right font-medium">Token share</th>
                  <th className="px-3 py-2 text-right font-medium">Cost</th>
                  <th className="px-3 py-2 text-right font-medium">Cost share</th>
                  <th className="py-2 pl-3 text-right font-medium">$/1M tokens</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {components.data.rows.map((row) => (
                  <tr key={row.component}>
                    <td className="py-2 pr-3 font-medium text-gray-900">{row.label}</td>
                    <td className="px-3 py-2 text-right text-gray-900">{formatTokens(row.tokens)}</td>
                    <td className="px-3 py-2 text-right text-gray-500">{formatPercent(row.token_share)}</td>
                    <td className="px-3 py-2 text-right text-gray-900">{formatCost(row.cost_usd)}</td>
                    <td className="px-3 py-2 text-right text-gray-500">{formatPercent(row.cost_share)}</td>
                    <td className="py-2 pl-3 text-right text-gray-500">{effectiveCostPerMtok(row.cost_usd, row.tokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
