/**
 * hooks/turn.ts — T8: Turn lifecycle observation.
 *
 * Subscribes to pi events:
 *   turn_start              — allocates a turn ID, emits TurnStartEvent
 *   after_provider_response — stashes HTTP status + rate-limit headers,
 *                             emits ProviderResponseEvent
 *   message_end             — stashes stop_reason from the final assistant
 *                             message (belt-and-suspenders for turn_end)
 *   turn_end                — emits TurnEndEvent, clears the active turn
 *   model_select            — tracks the active model/provider per session
 *   thinking_level_select   — tracks the active thinking level per session
 *
 * Exports `getActiveTurnId(sessionId)` for T9 (message.ts) and T10 (tool.ts)
 * to attach their events to the correct turn.
 *
 * ## Why T8 also subscribes to model_select / thinking_level_select
 *
 * Pi's `turn_start` payload only provides `{ turnIndex, timestamp }` — it
 * does not include model or thinking-level. T8 therefore maintains its own
 * per-session trackers by subscribing to the same model/thinking events that
 * T6 already handles for analytics emission. Pi's `pi.on()` supports multiple
 * listeners per event; both T6 and T8 will receive these events in registration
 * order. T8's handlers are read-only (no sink.write()) — they only update the
 * in-module tracking maps.
 *
 * ## stop_reason capture
 *
 * Pi's `turn_end` event carries `{ turnIndex, message, toolResults }`. The
 * `message.stopReason` field may be present on the real pi runtime. As belt-
 * and-suspenders, T8 also listens to `message_end` (alongside T9) and stashes
 * `event.message.stopReason` so that `turn_end` always has the value even if
 * the turn_end payload omits it.
 *
 * ## Observation-only
 *
 * No handler returns a replacement value. Every handler is wrapped in
 * try/catch so errors never propagate into pi's hot path.
 */

import {
  newId,
  type AnalyticsSink,
  type TurnStartEvent,
  type TurnEndEvent,
  type ProviderResponseEvent,
} from "../sinks/types.ts";
import type { HookContext, PiAPIStub, PiContextStub } from "./types.ts";
import { getActiveSessionId } from "./session-state.ts";
import { getLatestPromptId, getLatestPromptStartTs } from "./input.ts";

// ---------------------------------------------------------------------------
// Pi event payload shapes
// Confirmed from pi docs (extensions.md) + harness scenario payloads.
// ---------------------------------------------------------------------------

interface PiTurnStartEvent {
  /** 0-based index of this turn within the agent loop for the current prompt. */
  turnIndex: number;
  /** Unix ms timestamp assigned by pi at turn start. */
  timestamp: number;
}

interface PiTurnEndEvent {
  turnIndex: number;
  /** Final assistant message for this turn. Real pi may include stopReason. */
  message: {
    role: string;
    /** camelCase form used by pi's runtime. */
    stopReason?: string;
    /** snake_case alias — guard against provider-specific variations. */
    stop_reason?: string;
  };
  toolResults: unknown[];
}

interface PiAfterProviderResponseEvent {
  /** HTTP status code from the provider (e.g. 200, 429). */
  status: number;
  /**
   * Normalized response headers from pi. Availability depends on provider
   * and transport — some backends may not expose headers.
   */
  headers: Record<string, string>;
}

interface PiMessageEndEvent {
  message: {
    role: string;
    stopReason?: string;
    stop_reason?: string;
    /** Usage block — T9 reads this; T8 only needs the stop reason. */
    usage?: unknown;
  };
}

interface PiModelSelectEvent {
  model: { id: string; provider?: string };
  previousModel?: { id: string; provider?: string };
  source: string;
}

interface PiThinkingLevelSelectEvent {
  level: string;
  previousLevel: string;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/**
 * In-flight turn record — one per active session.
 * Created on `turn_start`, patched on `after_provider_response` and
 * `message_end`, consumed and deleted on `turn_end`.
 */
type ActiveTurnRecord = {
  turnId: string;
  promptId: string | null;
  idx: number;
  startedAt: number;
  model_id: string | null;
  provider: string | null;
  thinking_level: string | null;
  // Fields patched by after_provider_response:
  http_status: number | null;
  ratelimit_remaining: number | null;
  ratelimit_reset: number | null;
  // Field patched by message_end (belt-and-suspenders):
  stop_reason: string | null;
};

/** session_id → in-flight turn record (one turn active per session at a time). */
const activeTurns = new Map<string, ActiveTurnRecord>();

/**
 * session_id → current model info.
 * Updated by `model_select` subscriptions so turn_start can denormalize model
 * onto TurnStartEvent without it being in the turn_start payload.
 */
const activeModels = new Map<string, { model_id: string; provider: string | null }>();

/**
 * session_id → current thinking level.
 * Updated by `thinking_level_select` subscriptions.
 */
const activeThinkingLevels = new Map<string, string>();

// ---------------------------------------------------------------------------
// Exported reader — consumed by T9 (message.ts) and T10 (tool.ts)
// ---------------------------------------------------------------------------

/**
 * Returns the analytics turn ID for the currently active turn in `sessionId`,
 * or null if no turn is in progress (e.g. between turns, or turn_start has
 * not yet fired for this session).
 *
 * T9 calls this inside `message_end` to link LlmMessageEvent → turn.
 * T10 calls this inside `tool_execution_end` to link ToolCallEvent → turn.
 */
/**
 * Sets/updates the active model+provider for a session.  Called by T9
 * (message.ts) on each `message_end` so the in-flight turn's UPDATE picks up
 * the actual model used for the response — even when the user never invoked
 * `/model` and `model_select` consequently never fired.  pi's `AssistantMessage`
 * carries `model: string` and `provider: Provider` on every assistant message,
 * which is the authoritative source.
 */
export function setActiveModel(
  sessionId: string,
  model_id: string,
  provider: string | null,
): void {
  if (!sessionId || !model_id) return;
  activeModels.set(sessionId, { model_id, provider });
}

export function getActiveTurnId(sessionId: string): string | null {
  return activeTurns.get(sessionId)?.turnId ?? null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse `ratelimit_remaining` (request quota) from normalized response headers.
 * Prefers Anthropic-specific headers; falls back to common `x-ratelimit-*`.
 * Returns null when no recognizable header is present or the value is non-numeric.
 */
function parseRatelimitRemaining(
  headers: Record<string, string>,
): number | null {
  const candidates = [
    headers["anthropic-ratelimit-requests-remaining"],
    headers["anthropic-ratelimit-tokens-remaining"],
    headers["x-ratelimit-remaining-requests"],
    headers["x-ratelimit-remaining-tokens"],
    headers["x-ratelimit-remaining"],
  ];
  for (const val of candidates) {
    if (val == null) continue;
    const n = Number(val);
    if (!Number.isNaN(n)) return n;
  }
  return null;
}

/**
 * Parse `ratelimit_reset` (Unix ms when the rate-limit resets) from headers.
 *
 * Anthropic returns reset times as ISO 8601 timestamps
 * (`anthropic-ratelimit-*-reset`). OpenAI-style providers use Unix seconds in
 * `x-ratelimit-reset-*`. `retry-after` may be relative seconds or an HTTP
 * date string.
 *
 * Returns null when no recognizable header is present or the value cannot be
 * parsed as a timestamp.
 */
function parseRatelimitReset(
  headers: Record<string, string>,
): number | null {
  // Anthropic ISO 8601 timestamp headers.
  const isoHeaders = [
    headers["anthropic-ratelimit-requests-reset"],
    headers["anthropic-ratelimit-tokens-reset"],
  ];
  for (const val of isoHeaders) {
    if (!val) continue;
    const ms = Date.parse(val);
    if (!Number.isNaN(ms)) return ms;
  }

  // `retry-after` may be a relative-seconds integer or an HTTP date string.
  const retryAfter = headers["retry-after"];
  if (retryAfter) {
    const asSeconds = Number(retryAfter);
    if (!Number.isNaN(asSeconds) && asSeconds > 0) {
      // Treat as relative seconds from now → convert to Unix ms.
      return Date.now() + asSeconds * 1_000;
    }
    const asDate = Date.parse(retryAfter);
    if (!Number.isNaN(asDate)) return asDate;
  }

  // OpenAI-style `x-ratelimit-reset-*` headers (Unix seconds).
  const candidates = [
    headers["x-ratelimit-reset-requests"],
    headers["x-ratelimit-reset-tokens"],
    headers["x-ratelimit-reset"],
  ];
  for (const val of candidates) {
    if (!val) continue;
    const n = Number(val);
    if (!Number.isNaN(n) && n > 0) {
      // Values < 1e12 are Unix seconds; ≥ 1e12 are already Unix ms.
      return n < 1e12 ? n * 1_000 : n;
    }
  }

  return null;
}

/**
 * Extract `stop_reason` from a pi message object.
 * Pi uses camelCase `stopReason`; guard against snake_case variations too.
 */
function extractStopReason(
  msg:
    | { stopReason?: string; stop_reason?: string }
    | null
    | undefined,
): string | null {
  if (!msg) return null;
  return msg.stopReason ?? msg.stop_reason ?? null;
}

// ---------------------------------------------------------------------------
// register() — the single public export
// ---------------------------------------------------------------------------

/**
 * Register all turn-lifecycle event handlers onto the pi ExtensionAPI.
 *
 * Called once by T15 (src/index.ts) during extension startup. The function
 * closes over `sink` — do not store references outside.
 *
 * Registration order (matters for model/thinking tracking preceding turns):
 *   1. model_select         — update activeModels map (no sink write)
 *   2. thinking_level_select — update activeThinkingLevels map (no sink write)
 *   3. turn_start           — allocate turn, emit TurnStartEvent
 *   4. after_provider_response — patch turn record, emit ProviderResponseEvent
 *   5. message_end          — stash stop_reason onto turn record
 *   6. turn_end             — emit TurnEndEvent, clear turn record
 */
export function register(
  pi: PiAPIStub,
  sink: AnalyticsSink,
  _hookCtx: HookContext,
): void {

  // ── model_select ──────────────────────────────────────────────────────────
  // Track the current model/provider per session so turn_start can denormalize
  // them. T6 also subscribes to this event for analytics emission — that's fine,
  // both listeners receive the same event in registration order.

  pi.on("model_select", (rawEvent: unknown, piCtx: PiContextStub) => {
    try {
      const event = rawEvent as PiModelSelectEvent;
      const sessionId = getActiveSessionId(piCtx.sessionManager.getSessionFile());
      if (!sessionId) return;

      activeModels.set(sessionId, {
        model_id: event.model.id,
        provider: event.model.provider ?? null,
      });
    } catch (err) {
      console.warn("[analytics:hooks/turn] model_select tracking error:", err);
    }
  });

  // ── thinking_level_select ─────────────────────────────────────────────────
  // Track the current thinking level per session.

  pi.on("thinking_level_select", (rawEvent: unknown, piCtx: PiContextStub) => {
    try {
      const event = rawEvent as PiThinkingLevelSelectEvent;
      const sessionId = getActiveSessionId(piCtx.sessionManager.getSessionFile());
      if (!sessionId) return;

      activeThinkingLevels.set(sessionId, event.level);
    } catch (err) {
      console.warn(
        "[analytics:hooks/turn] thinking_level_select tracking error:",
        err,
      );
    }
  });

  // ── turn_start ────────────────────────────────────────────────────────────

  pi.on("turn_start", (rawEvent: unknown, piCtx: PiContextStub) => {
    try {
      const event = rawEvent as PiTurnStartEvent;
      const sessionFile = piCtx.sessionManager.getSessionFile();
      const sessionId = getActiveSessionId(sessionFile);

      if (!sessionId) {
        // Extension loaded mid-session, or session_start not yet fired.
        console.warn(
          "[analytics:hooks/turn] turn_start fired without an active session",
        );
        return;
      }

      const turnId = newId();

      // Link this turn to the most recent prompt (set by T7 on `input`).
      const promptId = getLatestPromptId(sessionId);

      // `before_agent_start` fires just before the agent loop; T7 stashes
      // its timestamp there. Use it as `started_at` for user-perceived
      // latency. Fall back to pi's own turn timestamp, then Date.now().
      const startedAt =
        getLatestPromptStartTs(sessionId) ?? event.timestamp ?? Date.now();

      const modelInfo = activeModels.get(sessionId) ?? null;
      const thinkingLevel = activeThinkingLevels.get(sessionId) ?? null;

      // Store in-flight record so other handlers can look up the turn ID.
      activeTurns.set(sessionId, {
        turnId,
        promptId,
        idx: event.turnIndex,
        startedAt,
        model_id: modelInfo?.model_id ?? null,
        provider: modelInfo?.provider ?? null,
        thinking_level: thinkingLevel,
        http_status: null,
        ratelimit_remaining: null,
        ratelimit_reset: null,
        stop_reason: null,
      });

      const turnStartEvent: TurnStartEvent = {
        kind: "turn_start",
        ts: Date.now(),
        id: turnId,
        session_id: sessionId,
        // Use "unknown" when no prompt has been recorded yet (e.g. agent
        // loop started before input hook registered — unlikely but safe).
        prompt_id: promptId ?? "unknown",
        idx: event.turnIndex,
        started_at: startedAt,
        model_id: modelInfo?.model_id ?? null,
        provider: modelInfo?.provider ?? null,
        thinking_level: thinkingLevel,
      };

      sink.write(turnStartEvent);
    } catch (err) {
      console.warn("[analytics:hooks/turn] turn_start handler error:", err);
    }
  });

  // ── after_provider_response ───────────────────────────────────────────────

  pi.on(
    "after_provider_response",
    (rawEvent: unknown, piCtx: PiContextStub) => {
      try {
        const event = rawEvent as PiAfterProviderResponseEvent;
        const sessionId = getActiveSessionId(
          piCtx.sessionManager.getSessionFile(),
        );
        if (!sessionId) return;

        const record = activeTurns.get(sessionId);
        if (!record) return; // turn_start may not have fired yet — defensive

        const httpStatus = event.status ?? null;
        const headers = event.headers ?? {};
        const ratelimitRemaining = parseRatelimitRemaining(headers);
        const ratelimitReset = parseRatelimitReset(headers);

        // Patch the in-flight record so turn_end can include the latest values.
        record.http_status = httpStatus;
        record.ratelimit_remaining = ratelimitRemaining;
        record.ratelimit_reset = ratelimitReset;

        const providerEvent: ProviderResponseEvent = {
          kind: "provider_response",
          ts: Date.now(),
          turn_id: record.turnId,
          session_id: sessionId,
          http_status: httpStatus,
          ratelimit_remaining: ratelimitRemaining,
          ratelimit_reset: ratelimitReset,
        };

        sink.write(providerEvent);
      } catch (err) {
        console.warn(
          "[analytics:hooks/turn] after_provider_response handler error:",
          err,
        );
      }
    },
  );

  // ── message_end ───────────────────────────────────────────────────────────
  // Stash stop_reason from the final assistant message so turn_end can include
  // it even if pi's turn_end event payload omits it. T9 also subscribes to
  // message_end for token/cost data — multiple subscriptions are fine.

  pi.on("message_end", (rawEvent: unknown, piCtx: PiContextStub) => {
    try {
      const event = rawEvent as PiMessageEndEvent;
      // Only care about assistant messages — user / toolResult messages carry
      // no stop_reason.
      if (event.message?.role !== "assistant") return;

      const sessionId = getActiveSessionId(
        piCtx.sessionManager.getSessionFile(),
      );
      if (!sessionId) return;

      const record = activeTurns.get(sessionId);
      if (!record) return;

      const stopReason = extractStopReason(event.message);
      if (stopReason) {
        record.stop_reason = stopReason;
      }
    } catch (err) {
      console.warn(
        "[analytics:hooks/turn] message_end stop_reason stash error:",
        err,
      );
    }
  });

  // ── turn_end ──────────────────────────────────────────────────────────────

  pi.on("turn_end", (rawEvent: unknown, piCtx: PiContextStub) => {
    try {
      const event = rawEvent as PiTurnEndEvent;
      const sessionId = getActiveSessionId(
        piCtx.sessionManager.getSessionFile(),
      );
      if (!sessionId) return;

      const record = activeTurns.get(sessionId);
      if (!record) {
        console.warn(
          "[analytics:hooks/turn] turn_end fired without an active turn record",
        );
        return;
      }

      const now = Date.now();

      // Prefer stop_reason from the turn_end event's message field (real pi
      // may include it). Fall back to the value stashed from message_end.
      const stopReason =
        extractStopReason(event.message) ?? record.stop_reason ?? null;

      // Read the latest model from `activeModels` rather than the record
      // snapshot frozen at turn_start time.  T9 (`hooks/message.ts`) calls
      // `setActiveModel(sessionId, msg.model, msg.provider)` during
      // `message_end`, which fires AFTER turn_start but BEFORE turn_end.  If
      // we used `record.model_id` here, turn 0 of every session whose user
      // never invoked `/model` would write NULL — even though the assistant
      // message clearly identified the model.  See
      // `scripts/NULL-MODEL-INVESTIGATION.md` for the data backing this.
      // Fall back to the record so an explicit `model_select` before
      // `turn_start` (the path that already worked pre-fix) still wins when
      // present.
      const latestModel = activeModels.get(sessionId);
      const turnEndEvent: TurnEndEvent = {
        kind: "turn_end",
        ts: now,
        turn_id: record.turnId,
        session_id: sessionId,
        ended_at: now,
        model_id: latestModel?.model_id ?? record.model_id,
        provider:  latestModel?.provider ?? record.provider,
        thinking_level: record.thinking_level,
        stop_reason: stopReason,
      };

      sink.write(turnEndEvent);

      // Clear the active turn — ready for the next turn in this session.
      activeTurns.delete(sessionId);
    } catch (err) {
      console.warn("[analytics:hooks/turn] turn_end handler error:", err);
    }
  });
}
