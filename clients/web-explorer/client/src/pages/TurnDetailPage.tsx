import { useParams, Link } from "react-router";
import { useApi } from "../hooks/useApi.ts";
import { useRefreshNonce } from "../hooks/useRefreshSignal";
import { api, type LlmMessageRow, type ToolCallRow } from "../api.ts";
import DataTable from "../components/DataTable.tsx";
import StatCard from "../components/StatCard.tsx";
import { formatCost, formatTokens, formatDuration, formatDate } from "../lib/format.ts";
import type { ColumnDef } from "@tanstack/react-table";

const messageColumns: ColumnDef<LlmMessageRow>[] = [
  {
    accessorKey: "ts",
    header: "Time",
    cell: ({ getValue }) => (
      <span className="text-gray-400 text-xs">{formatDate(getValue() as number)}</span>
    ),
  },
  {
    accessorKey: "model_id",
    header: "Model",
    cell: ({ getValue }) => (
      <span className="text-xs font-mono text-gray-600">{(getValue() as string | null) ?? "—"}</span>
    ),
  },
  {
    accessorKey: "input_tokens",
    header: "In",
    cell: ({ getValue }) => formatTokens(getValue() as number),
  },
  {
    accessorKey: "output_tokens",
    header: "Out",
    cell: ({ getValue }) => formatTokens(getValue() as number),
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
    accessorKey: "cost_usd",
    header: "Cost",
    cell: ({ getValue }) => <span className="font-medium">{formatCost(getValue() as number)}</span>,
  },
  {
    accessorKey: "cost_source",
    header: "Source",
    cell: ({ getValue }) => (
      <span className="text-xs text-gray-400">{getValue() as string}</span>
    ),
  },
];

const toolColumns: ColumnDef<ToolCallRow>[] = [
  {
    accessorKey: "tool_name",
    header: "Tool",
    cell: ({ getValue }) => <span className="font-mono text-xs">{getValue() as string}</span>,
  },
  {
    accessorKey: "started_at",
    header: "Started",
    cell: ({ getValue }) => (
      <span className="text-gray-400 text-xs">{formatDate(getValue() as number)}</span>
    ),
  },
  {
    accessorKey: "duration_ms",
    header: "Duration",
    cell: ({ getValue }) => formatDuration(getValue() as number | null),
  },
  {
    accessorKey: "is_error",
    header: "Status",
    cell: ({ getValue }) => {
      const v = getValue() as number;
      return v === 0
        ? <span className="text-green-600 text-xs">ok</span>
        : <span className="text-red-600 text-xs">error</span>;
    },
  },
];

export default function TurnDetailPage() {
  const { sessionId, turnId } = useParams<{ sessionId: string; turnId: string }>();
  const refreshNonce = useRefreshNonce();
  const result = useApi(() => api.turnDetail(sessionId!, turnId!), [sessionId, turnId, refreshNonce]);

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

  const { turn, messages, toolCalls } = result.data;

  return (
    <div className="p-6 max-w-5xl">
      {/* Breadcrumb */}
      <div className="text-xs text-gray-400 mb-4">
        <Link to="/sessions" className="hover:text-blue-600">Sessions</Link>
        <span className="mx-1">›</span>
        <Link to={`/sessions/${sessionId}`} className="hover:text-blue-600">Session</Link>
        <span className="mx-1">›</span>
        <span className="text-gray-600">Turn {turn.turn_index ?? "—"}</span>
      </div>

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-gray-900">
          Turn {turn.turn_index != null ? `#${turn.turn_index}` : "detail"}
        </h1>
        <div className="flex gap-4 text-xs text-gray-500 mt-1">
          {turn.model_id && <span className="font-mono">{turn.model_id}</span>}
          <span>{formatDate(turn.started_at)}</span>
          {turn.duration_ms && <span>{formatDuration(turn.duration_ms)}</span>}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard label="Cost" value={formatCost(turn.cost_usd)} />
        <StatCard label="In tokens" value={formatTokens(turn.input_tokens)} />
        <StatCard label="Out tokens" value={formatTokens(turn.output_tokens)} />
        <StatCard label="Cached" value={formatTokens(turn.cached_tokens)} />
      </div>

      {/* LLM messages */}
      <div className="bg-white rounded-lg border border-gray-200 mb-6">
        <div className="px-4 py-3 border-b border-gray-100">
          <h2 className="text-sm font-medium text-gray-700">LLM messages ({messages.length})</h2>
        </div>
        <DataTable data={messages} columns={messageColumns} emptyMessage="No messages" />
      </div>

      {/* Tool calls */}
      {toolCalls.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200">
          <div className="px-4 py-3 border-b border-gray-100">
            <h2 className="text-sm font-medium text-gray-700">Tool calls ({toolCalls.length})</h2>
          </div>
          <DataTable data={toolCalls} columns={toolColumns} emptyMessage="No tool calls" />
        </div>
      )}
    </div>
  );
}
