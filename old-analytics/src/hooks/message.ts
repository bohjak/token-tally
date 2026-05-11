/**
 * hooks/message.ts — T9: LLM message usage extraction.
 *
 * Subscribes to `message_end` (alongside T8 which stashes stop_reason).
 * Pi supports multiple listeners per event; both handlers receive the event
 * independently in registration order.
 *
 * ## Payload mapping (pi reality vs PLAN.md)
 *
 * Pi's `AssistantMessage.usage` uses camelCase field names, not snake_case:
 *
 *   pi field              → our LlmMessageEvent field
 *   ─────────────────────────────────────────────────
 *   usage.input           → input_tokens
 *   usage.output          → output_tokens
 *   usage.cacheRead       → cache_read_tokens
 *   usage.cacheWrite      → cache_write_tokens
 *   usage.cost.input      → cost_input
 *   usage.cost.output     → cost_output
 *   usage.cost.cacheRead  → cost_cache_read
 *   usage.cost.cacheWrite → cost_cache_write
 *   usage.cost.total      → cost_total
 *   stopReason            → stop_reason
 *
 * PLAN.md referred to these as `input_tokens` etc., but those names are the
 * *target* column names in SQLite, not the pi payload names. We map here.
 *
 * ## Timing
 *
 * Pi's `AssistantMessage` has no `timeToFirstToken` or `totalDuration` field.
 * Therefore:
 *   - `time_to_first_token_ms` is always null (not observable from pi events).
 *   - `total_duration_ms` is computed as `message_end time − turn_start time`
 *     by subscribing to `turn_start` here (non-exclusively) to capture the
 *     start timestamp in a local map. The local map is cleaned up on
 *     `turn_end`.
 *
 * ## Observation-only
 *
 * This hook never returns a replacement message. Every handler is wrapped in
 * try/catch so errors never propagate into pi's hot path.
 */

import {
  newId,
  type AnalyticsSink,
  type LlmMessageEvent,
} from "../sinks/types.ts";
import type { HookContext, PiAPIStub, PiContextStub } from "./types.ts";
import { getActiveSessionId } from "./session-state.ts";
import { getActiveTurnId, setActiveModel } from "./turn.ts";

// ---------------------------------------------------------------------------
// Pi event payload shapes (confirmed from pi d.ts + extensions.md)
// ---------------------------------------------------------------------------

/**
 * Shape of `event.message.usage` on a real `AssistantMessage`.
 * Fields are camelCase — see mapping in module header.
 */
interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

/**
 * Shape of the `message` field on a `message_end` event.
 * Only the fields this hook cares about are typed here.
 */
interface PiMessageEndPayload {
  message: {
    role: string;
    /** camelCase — confirmed from @mariozechner/pi-ai dist/types.d.ts */
    stopReason?: string;
    /** snake_case alias — guard against any provider-specific variation */
    stop_reason?: string;
    /** Present on AssistantMessage; absent on UserMessage / ToolResultMessage */
    usage?: PiUsage;
    /**
     * Model id reported by the provider (e.g. "claude-sonnet-4-5").  Source
     * of truth for which model was actually used — `model_select` events only
     * fire on user-initiated changes, so the default model never trips them.
     */
    model?: string;
    /** Provider name (e.g. "anthropic", "openai"). */
    provider?: string;
    /**
     * Unix ms timestamp assigned by pi when this message was created.
     * Used as a fallback for total_duration_ms when no local start time
     * is available (e.g. turn_start fired before this hook was registered).
     */
    timestamp?: number;
  };
}

/** Minimal turn_start event shape — we only need the timestamp. */
interface PiTurnStartEvent {
  turnIndex: number;
  timestamp?: number;
}

// ---------------------------------------------------------------------------
// Module-level timing state
//
// We subscribe to `turn_start` solely to capture the wall-clock time at which
// the turn began so we can compute `total_duration_ms` on `message_end`.
//
// Keyed by session_id (the analytics UUID, not the pi session file).
// Cleaned up on `turn_end` to avoid unbounded memory growth.
// ---------------------------------------------------------------------------

/** session_id → wall-clock ms when the most recent turn began. */
const turnStartedAtMap = new Map<string, number>();

/**
 * session_id → prompt-cache write retention observed on the latest provider
 * request for that session.  This is captured from before_provider_request
 * because AssistantMessage.usage only reports aggregate cache write tokens,
 * not whether Anthropic billed them at 5m or 1h cache creation rates.
 */
const cacheWriteRetentionMap = new Map<string, "5m" | "1h">();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Safely extract stop_reason from the pi message object. */
function extractStopReason(msg: PiMessageEndPayload["message"]): string | null {
  return msg.stopReason ?? msg.stop_reason ?? null;
}

/**
 * Safely read a number from `usage`, returning 0 when the field is missing
 * or not a finite number. This guards against future API changes or providers
 * that omit optional fields.
 */
function safeNum(value: number | undefined | null): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Inspect an Anthropic provider payload and return the cache write retention
 * it requests.  Pi emits either:
 *   cache_control: { type: "ephemeral" }              → 5m
 *   cache_control: { type: "ephemeral", ttl: "1h" }  → 1h
 *
 * The payload can contain cache_control on system blocks, message content
 * blocks, or tools.  If any block asks for 1h, record 1h for the request;
 * otherwise any cache_control means 5m.  No cache_control returns null.
 */
function extractCacheWriteRetention(payload: unknown): "5m" | "1h" | null {
  let sawCacheControl = false;

  const visit = (value: unknown): "1h" | null => {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (visit(item) === "1h") return "1h";
      }
      return null;
    }

    if (!isRecord(value)) return null;

    const cacheControl = value.cache_control;
    if (isRecord(cacheControl)) {
      sawCacheControl = true;
      if (cacheControl.ttl === "1h") return "1h";
    }

    for (const child of Object.values(value)) {
      if (visit(child) === "1h") return "1h";
    }

    return null;
  };

  if (visit(payload) === "1h") return "1h";
  return sawCacheControl ? "5m" : null;
}

// ---------------------------------------------------------------------------
// register() — the single public export
// ---------------------------------------------------------------------------

/**
 * Register `message_end` (and supporting `turn_start`/`turn_end`) handlers.
 *
 * Called once by T15 during extension startup. All state is captured in
 * module-level maps (not in closures or per-call objects) for consistency
 * with the rest of the hook modules.
 */
export function register(
  pi: PiAPIStub,
  sink: AnalyticsSink,
  _hookCtx: HookContext,
): void {

  // ── before_provider_request ───────────────────────────────────────────────
  // Capture provider-payload cache retention before the LLM request is sent.
  // This is the only place where Anthropic's 5m vs 1h cache_control TTL is
  // visible; the final AssistantMessage.usage only exposes aggregate
  // cacheWrite tokens and cost.

  pi.on("before_provider_request", (rawEvent: unknown, piCtx: PiContextStub) => {
    try {
      const sessionId = getActiveSessionId(piCtx.sessionManager.getSessionFile());
      if (!sessionId) return;

      const payload = isRecord(rawEvent) ? rawEvent.payload : null;
      const retention = extractCacheWriteRetention(payload);
      if (retention) {
        cacheWriteRetentionMap.set(sessionId, retention);
      } else {
        cacheWriteRetentionMap.delete(sessionId);
      }
    } catch (err) {
      console.warn(
        "[analytics:hooks/message] before_provider_request cache retention capture error:",
        err,
      );
    }
  });

  // ── turn_start ────────────────────────────────────────────────────────────
  // Secondary subscription — T8 owns the canonical TurnStartEvent emission.
  // We only capture the wall-clock start time here so message_end can compute
  // total_duration_ms without depending on T8's private state.

  pi.on("turn_start", (rawEvent: unknown, piCtx: PiContextStub) => {
    try {
      const _ev = rawEvent as PiTurnStartEvent; // available if needed later
      const sessionId = getActiveSessionId(piCtx.sessionManager.getSessionFile());
      if (!sessionId) return;

      // Record the time this turn started so message_end can compute duration.
      // Date.now() is slightly after pi's event.timestamp, but is the most
      // accurate reflection of when we began waiting for the LLM.
      turnStartedAtMap.set(sessionId, Date.now());
    } catch (err) {
      console.warn(
        "[analytics:hooks/message] turn_start timing capture error:",
        err,
      );
    }
  });

  // ── turn_end ──────────────────────────────────────────────────────────────
  // Secondary subscription — clean up the timing map to avoid memory leaks.

  pi.on("turn_end", (_rawEvent: unknown, piCtx: PiContextStub) => {
    try {
      const sessionId = getActiveSessionId(piCtx.sessionManager.getSessionFile());
      if (sessionId) {
        turnStartedAtMap.delete(sessionId);
        cacheWriteRetentionMap.delete(sessionId);
      }
    } catch (err) {
      console.warn(
        "[analytics:hooks/message] turn_end cleanup error:",
        err,
      );
    }
  });

  // ── message_end ───────────────────────────────────────────────────────────

  pi.on("message_end", (rawEvent: unknown, piCtx: PiContextStub) => {
    try {
      const ev = rawEvent as PiMessageEndPayload;
      const msg = ev?.message;

      // Skip non-assistant messages — user and toolResult messages carry no
      // token usage and should not produce llm_message rows.
      if (!msg || msg.role !== "assistant") return;

      const sessionFile = piCtx.sessionManager.getSessionFile();
      const sessionId = getActiveSessionId(sessionFile);
      if (!sessionId) {
        // No session registered yet — extension loaded mid-session.
        return;
      }

      const turnId = getActiveTurnId(sessionId);
      // turnId may be null in rare edge cases (e.g. turn_end fired before
      // message_end, which shouldn't happen but defensive programming here).

      // Authoritative model/provider source: every AssistantMessage carries
      // the model id used for the response.  Push it into T8's activeModels
      // map so the upcoming `turn_end` UPDATE writes the correct value to
      // turns.model_id / turns.provider — even when the user never invoked
      // /model and `model_select` consequently never fired for this session.
      if (typeof msg.model === "string" && msg.model.length > 0) {
        setActiveModel(sessionId, msg.model, msg.provider ?? null);
      }

      const now = Date.now();

      // ── Token / cost extraction ──────────────────────────────────────────
      // Pi uses camelCase field names; map to snake_case for our event schema.
      const usage = msg.usage;
      const cost = usage?.cost;

      const inputTokens     = safeNum(usage?.input);
      const outputTokens    = safeNum(usage?.output);
      const cacheReadTokens = safeNum(usage?.cacheRead);
      const cacheWriteTokens= safeNum(usage?.cacheWrite);

      const costInput      = safeNum(cost?.input);
      const costOutput     = safeNum(cost?.output);
      const costCacheRead  = safeNum(cost?.cacheRead);
      const costCacheWrite = safeNum(cost?.cacheWrite);
      const costTotal      = safeNum(cost?.total);

      // ── Timing ──────────────────────────────────────────────────────────
      // `time_to_first_token_ms` is not observable from pi's event payload —
      // pi does not expose a "first token" timestamp in message_end.
      const timeToFirstTokenMs: number | null = null;

      // `total_duration_ms`: prefer the locally tracked turn start time.
      // Fall back to the message's own timestamp field (set at message creation
      // by pi, which is close to LLM-call start for single-LLM-call turns).
      // If neither is available, set to null.
      let totalDurationMs: number | null = null;
      const turnStart = turnStartedAtMap.get(sessionId);
      if (turnStart != null) {
        totalDurationMs = now - turnStart;
      } else if (typeof msg.timestamp === "number" && msg.timestamp > 0) {
        // Best-effort fallback: message.timestamp is when pi created the
        // AssistantMessage — a reasonable proxy for turn start in single-
        // turn scenarios.
        totalDurationMs = now - msg.timestamp;
      }

      // ── Emit ────────────────────────────────────────────────────────────
      const event: LlmMessageEvent = {
        kind:              "llm_message",
        ts:                now,
        id:                newId(),
        turn_id:           turnId ?? "unknown",
        session_id:        sessionId,
        role:              "assistant",
        input_tokens:      inputTokens,
        output_tokens:     outputTokens,
        cache_read_tokens: cacheReadTokens,
        cache_write_tokens: cacheWriteTokens,
        cost_input:        costInput,
        cost_output:       costOutput,
        cost_cache_read:   costCacheRead,
        cost_cache_write:  costCacheWrite,
        cost_total:        costTotal,
        cache_write_retention: cacheWriteRetentionMap.get(sessionId) ?? null,
        time_to_first_token_ms: timeToFirstTokenMs,
        total_duration_ms:      totalDurationMs,
        stop_reason:       extractStopReason(msg),
        // Store model attribution directly on the message row so it survives
        // even if turns.model_id was not populated (e.g. missing model_select).
        // These fields were added by migration 002; pre-002 NDJSON replay
        // events will have undefined here, which coerces to null.
        model_id: typeof msg.model === "string" && msg.model.length > 0
          ? msg.model
          : null,
        provider: typeof msg.provider === "string" && msg.provider.length > 0
          ? msg.provider
          : null,
      };

      sink.write(event);
    } catch (err) {
      console.warn(
        "[analytics:hooks/message] message_end handler error:",
        err,
      );
    }
    // Returning nothing — observation-only, no message replacement.
  });
}
