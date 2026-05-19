/**
 * tool.ts — Tool execution hooks for the Pi writer extension.
 *
 * Handles:
 *   tool_execution_start — stashes the start time keyed by toolCallId.
 *   tool_execution_end   — writes a tool_calls row with timing and error flag.
 *
 * ## Privacy
 * Tool input arguments and output content are NOT stored (data minimisation).
 * Only: tool name, timing, error flag, and the harness-provided toolCallId.
 *
 * ## Parallel tool calls
 * Pi may issue multiple tool calls concurrently within the same turn. Each
 * has a unique toolCallId, so the per-toolCallId map handles interleaving
 * correctly without session-level locking.
 *
 * ## Idempotency
 * The Pi-provided toolCallId is used directly as harnessToolCallId.
 * UNIQUE (harness_id, harness_tool_call_id) deduplicates replays.
 */

import type { AnalyticsWriterLike } from "../cli-writer.ts";
import type { PiAPIStub, PiContextStub } from "./types.ts";
import { getCentralSessionId } from "./session-state.ts";
import { getTurn } from "./turn-state.ts";

// ---------------------------------------------------------------------------
// Pi event payload shapes
// ---------------------------------------------------------------------------

type PiToolExecutionStartEvent = {
  toolCallId: string;
  toolName: string;
};

type PiToolExecutionEndEvent = {
  toolCallId: string;
  toolName: string;
  isError?: boolean;
};

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/**
 * Maps toolCallId → start timestamp for in-flight tool calls.
 * Created at tool_execution_start; deleted at tool_execution_end.
 */
const activeTools = new Map<string, { startedAt: number; toolName: string }>();

// ---------------------------------------------------------------------------
// register() — the single public export
// ---------------------------------------------------------------------------

/**
 * Register all tool-execution event handlers.
 *
 * @param pi     Pi ExtensionAPI.
 * @param writer The open AnalyticsWriter.
 */
export function register(pi: PiAPIStub, writer: AnalyticsWriterLike): void {

  // ── tool_execution_start ──────────────────────────────────────────────────

  pi.on("tool_execution_start", (rawEvent: unknown, _piCtx: PiContextStub) => {
    try {
      const ev = rawEvent as PiToolExecutionStartEvent;
      activeTools.set(ev.toolCallId, {
        startedAt: Date.now(),
        toolName: ev.toolName,
      });
    } catch (err: unknown) {
      console.warn("[pi-writer:tool] tool_execution_start error:", err);
    }
  });

  // ── tool_execution_end ────────────────────────────────────────────────────

  pi.on(
    "tool_execution_end",
    async (rawEvent: unknown, piCtx: PiContextStub) => {
      try {
        const ev = rawEvent as PiToolExecutionEndEvent;

        const record = activeTools.get(ev.toolCallId);
        if (record == null) {
          // Missed the start event — extension may have been loaded mid-session.
          console.warn(
            "[pi-writer:tool] tool_execution_end without matching start for",
            ev.toolCallId,
          );
          return;
        }

        activeTools.delete(ev.toolCallId);

        const sessionFile = piCtx.sessionManager.getSessionFile();
        const centralSessionId = getCentralSessionId(sessionFile);
        if (centralSessionId == null) return;

        const turnState = getTurn(centralSessionId);
        const now = Date.now();

        await writer.recordToolCall({
          harnessId: "pi",
          sessionId: centralSessionId,
          turnId: turnState?.centralTurnId,
          // Pi's toolCallId is a stable identifier for this invocation.
          harnessToolCallId: ev.toolCallId,
          toolName: record.toolName,
          startedAt: record.startedAt,
          endedAt: now,
          isError: ev.isError === true,
        });
      } catch (err: unknown) {
        console.warn("[pi-writer:tool] tool_execution_end error:", err);
      }
    },
  );
}
