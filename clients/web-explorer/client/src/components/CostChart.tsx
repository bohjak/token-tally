import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import type { DailyRow, HourlyRow } from "../api.ts";
import { formatCost, formatTokens } from "../lib/format.ts";

export type ChartMetric = "cost_usd" | "billable_tokens" | "tokens" | "input_tokens" | "output_tokens" | "cached_tokens";

type ChartSourceRow = DailyRow | HourlyRow;

type Props = {
  rows: ChartSourceRow[];
  compareRows?: ChartSourceRow[];
  metric?: ChartMetric;
  granularity?: "daily" | "hourly";
};

const metricLabels: Record<ChartMetric, string> = {
  cost_usd: "Cost",
  billable_tokens: "Billable tokens",
  tokens: "Total tokens",
  input_tokens: "Input tokens",
  output_tokens: "Output tokens",
  cached_tokens: "Cached tokens",
};

function rowLabel(row: ChartSourceRow): string {
  return "hour" in row ? row.hour : row.date;
}

function formatValue(value: number, metric: ChartMetric): string {
  return metric === "cost_usd" ? formatCost(value) : formatTokens(value);
}

function formatYAxis(metric: ChartMetric): (value: number) => string {
  return (value) => formatValue(value, metric);
}

type ChartRow = ChartSourceRow & {
  label: string;
  current_value: number;
  compare_value?: number;
  compare_label?: string;
};

export default function CostChart({ rows, compareRows, metric = "cost_usd", granularity = "daily" }: Props) {
  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-gray-400 text-sm">
        No data for this period
      </div>
    );
  }

  const chartRows: ChartRow[] = rows.map((row, index) => ({
    ...row,
    label: rowLabel(row),
    current_value: row[metric],
    compare_value: compareRows?.[index]?.[metric],
    compare_label: compareRows?.[index] ? rowLabel(compareRows[index]) : undefined,
  }));

  return (
    <ResponsiveContainer width="100%" height={180} minWidth={200}>
      <BarChart data={chartRows} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis
          dataKey="label"
          tick={{ fontSize: 10, fill: "#9ca3af" }}
          tickFormatter={(v: string) => {
            if (granularity === "hourly") return v.slice(11, 16);
            const [, m, d] = v.split("-");
            return `${m}/${d}`;
          }}
          interval="preserveStartEnd"
        />
        <YAxis
          tick={{ fontSize: 10, fill: "#9ca3af" }}
          tickFormatter={formatYAxis(metric)}
          width={56}
        />
        <Tooltip
          formatter={(value: number, name: string) => [
            formatValue(value, metric),
            name === "compare_value" ? "Comparison" : "Current",
          ]}
          labelFormatter={(label: string, payload: unknown[]) => {
            const item = (payload?.[0] as { payload?: ChartRow } | undefined)?.payload;
            return item?.compare_label ? `${label} vs ${item.compare_label}` : label;
          }}
          contentStyle={{ fontSize: 12 }}
        />
        {compareRows && <Bar dataKey="compare_value" fill="#d1d5db" radius={[2, 2, 0, 0]} maxBarSize={20} />}
        <Bar dataKey="current_value" fill="#3b82f6" radius={[2, 2, 0, 0]} maxBarSize={24} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export { metricLabels };
