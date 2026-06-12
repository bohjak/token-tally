/**
 * message.ts — LLM message usage hooks for the Pi writer extension.
 *
 * Subscribes to `message_end` to capture token counts and costs from Pi's
 * AssistantMessage. Only assistant-role messages carry usage data; user and
 * toolResult messages are ignored.
 *
 * ## Cost handling
 * Pi emits costs as IEEE-754 USD floats (e.g. 0.001234). We convert to
 * integer micro-dollars (Math.round(usd * 1_000_000)) to match the central
 * store schema.
 *
 * When Pi provides a non-zero cost total, cost_source is "harness".
 * When Pi emits no cost (zero or missing total), we fall back to the shared
 * @token-tally/store/pricing module: cost_source becomes "writer" when rates
 * are found, or "unknown" when the model is not in the table or the pricing
 * module is unavailable (e.g. a bare checkout without `make install`).
 *
 * ## Message ID selection
 * Pi's AssistantMessage carries the provider response ID (`responseId`,
 * e.g. `msg_...` / `resp_...`) for successful responses. We use it as the
 * canonical harness_message_id so live-writer rows and session-log import
 * rows share the same identity (the importer also keys on responseId).
 *
 * When responseId is absent (aborted/error responses), we fall back to a
 * synthesized ID:
 *   `${harnessSessionId}:t${turnIndex}:m${messageCounter}`
 * where messageCounter is a per-turn integer that resets on turn_start.
 * This is deterministic given the same sequence of events, satisfying the
 * UNIQUE (harness_id, harness_message_id) idempotency key.
 *
 * ## Model attribution
 * Every AssistantMessage carries `message.model` (the authoritative model
 * used for the response). We push it to the turn-state model map via
 * setActiveModel() so that the upcoming turn_end writes the correct model
 * to the turns row — even when model_select never fired for this session.
 *
 * ## Privacy
 * No prompt text, assistant response text, or cache payloads are stored.
 * Only token counts, cost values, model ID, provider, and timing are recorded.
 */

import type { AnalyticsWriterLike } from "../cli-writer.ts";
import type { PiAPIStub, PiContextStub } from "./types.ts";
import { getCentralSessionId, getSession } from "./session-state.ts";
import { getTurn, setActiveModel } from "./turn-state.ts";

// ---------------------------------------------------------------------------
// Pi event payload shapes
// ---------------------------------------------------------------------------

type PiUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
};

type PiMessageEndEvent = {
  message: {
    role: string;
    model?: string;
    provider?: string;
    /** Provider response ID (e.g. msg_... / resp_...); absent on aborted/error responses. */
    responseId?: string;
    usage?: PiUsage;
  };
};

// ---------------------------------------------------------------------------
// Shared pricing module — dynamically imported to avoid loading better-sqlite3
// ---------------------------------------------------------------------------
//
// Pi's extension process must not import @token-tally/store at the top level
// because that package loads native SQLite code. The pricing subpath
// (@token-tally/store/pricing) is dependency-free, but dynamic import is still
// used so that even a partial checkout (no `make install`, store not built)
// never crashes the extension — it just falls back to costSource='unknown'.

type StorePricing = typeof import("@token-tally/store/pricing");

// Mutable slot updated by the load promise. Exported for test injection only.
export let _pricingModule: StorePricing | null = null;

// Mutable promise — awaited in the handler before checking _pricingModule.
// Replaced by _setPricingForTest to cancel any in-flight real import so tests
// are not subject to a race between the injected value and the async import.
export let _pricingLoadPromise: Promise<void> = import("@token-tally/store/pricing")
  .then((m) => {
    _pricingModule = m;
  })
  .catch(() => {
    // Store dist not available (e.g. bare checkout without `make install`).
    // _pricingModule stays null; we'll fall back to costSource='unknown'.
  });

/**
 * Inject a pricing module for testing without relying on real dynamic imports.
 * Also replaces the load promise with an already-resolved one so the real
 * async import cannot race against and overwrite the injected value.
 *
 * Only for test use — do not call in production code.
 */
export function _setPricingForTest(m: StorePricing | null): void {
  _pricingModule = m;
  _pricingLoadPromise = Promise.resolve();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return a finite number from `value`, or 0 when the field is missing, null,
 * or non-finite. Guards against providers that omit optional usage fields.
 */
function safeNum(value: number | undefined | null): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Convert a USD float to an integer micro-dollar value.
 * Math.round eliminates floating-point drift (e.g. 0.001500000001 → 1500).
 */
function toMicros(usd: number): number {
  return Math.round(usd * 1_000_000);
}

// ---------------------------------------------------------------------------
// register() — the single public export
// ---------------------------------------------------------------------------

/**
 * Register `message_end` handler.
 *
 * @param pi     Pi ExtensionAPI.
 * @param writer The open AnalyticsWriter.
 */
export function register(pi: PiAPIStub, writer: AnalyticsWriterLike): void {

  // ── message_end ───────────────────────────────────────────────────────────

  pi.on("message_end", async (rawEvent: unknown, piCtx: PiContextStub) => {
    try {
      const ev = rawEvent as PiMessageEndEvent;
      const msg = ev?.message;

      // Only assistant messages carry usage data worth recording.
      if (!msg || msg.role !== "assistant") return;

      const sessionFile = piCtx.sessionManager.getSessionFile();
      const centralSessionId = getCentralSessionId(sessionFile);
      if (centralSessionId == null) {
        // Extension loaded mid-session or session_start hasn't fired.
        return;
      }

      const state = getSession(sessionFile);
      const turnState = getTurn(centralSessionId);

      // Update the turn-state model map with the authoritative model from
      // the actual response — this ensures turn_end writes the correct model
      // even when model_select never fired (e.g. default model at startup).
      if (typeof msg.model === "string" && msg.model.length > 0) {
        setActiveModel(centralSessionId, {
          modelId: msg.model,
          provider: typeof msg.provider === "string" ? msg.provider : null,
        });
      }

      // Prefer the provider response ID — it is the canonical identity shared
      // with the session-log importer. Fall back to a synthesized ID
      // (session + turn index + per-turn counter) when responseId is absent.
      const harnessSessionId = state?.harnessSessionId ?? `unknown:${centralSessionId}`;
      const turnIndex = turnState?.turnIndex ?? 0;
      const msgCounter = turnState?.messageCounter ?? 0;
      const harnessMessageId =
        typeof msg.responseId === "string" && msg.responseId.length > 0
          ? msg.responseId
          : `${harnessSessionId}:t${turnIndex}:m${msgCounter}`;

      // Increment the per-turn message counter (stored on the TurnState reference).
      if (turnState != null) {
        turnState.messageCounter += 1;
      }

      // Extract token counts (camelCase in Pi's AssistantMessage.usage).
      const usage = msg.usage;
      const cost = usage?.cost;

      const inputTokens = safeNum(usage?.input);
      const outputTokens = safeNum(usage?.output);
      const cacheReadTokens = safeNum(usage?.cacheRead);
      const cacheWriteTokens = safeNum(usage?.cacheWrite);

      // Prefer Pi's emitted cost when it is non-zero (cost_source = "harness").
      // When Pi reports no cost (missing or zero total), fall back to the shared
      // store pricing module (cost_source = "writer" or "unknown").
      let costInputMicros: number;
      let costOutputMicros: number;
      let costCacheReadMicros: number;
      let costCacheWriteMicros: number;
      let costSource: "harness" | "writer" | "unknown";

      if (safeNum(cost?.total) > 0) {
        // Pi provided cost data — use it directly.
        costInputMicros = toMicros(safeNum(cost?.input));
        costOutputMicros = toMicros(safeNum(cost?.output));
        costCacheReadMicros = toMicros(safeNum(cost?.cacheRead));
        costCacheWriteMicros = toMicros(safeNum(cost?.cacheWrite));
        costSource = "harness";
      } else {
        // Pi did not emit cost data. Await the shared pricing module
        // (@token-tally/store/pricing, which is dependency-free). If it's not
        // available, all costs fall back to 0 / costSource='unknown'.
        await _pricingLoadPromise;
        const modelId = typeof msg.model === "string" && msg.model.length > 0
          ? msg.model
          : undefined;
        if (_pricingModule !== null && modelId !== undefined) {
          const breakdown = _pricingModule.computeCostMicros({
            modelId,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
          });
          costInputMicros = breakdown.costInputMicros;
          costOutputMicros = breakdown.costOutputMicros;
          costCacheReadMicros = breakdown.costCacheReadMicros;
          costCacheWriteMicros = breakdown.costCacheWriteMicros;
          costSource = breakdown.costSource; // "writer" | "unknown"
        } else {
          // Pricing unavailable or no model ID — record zero costs.
          costInputMicros = 0;
          costOutputMicros = 0;
          costCacheReadMicros = 0;
          costCacheWriteMicros = 0;
          costSource = "unknown";
        }
      }

      await writer.recordLlmMessage({
        harnessId: "pi",
        sessionId: centralSessionId,
        turnId: turnState?.centralTurnId,
        harnessMessageId,
        ts: Date.now(),
        provider: typeof msg.provider === "string" && msg.provider.length > 0
          ? msg.provider
          : undefined,
        modelId: typeof msg.model === "string" && msg.model.length > 0
          ? msg.model
          : undefined,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        costInputMicros,
        costOutputMicros,
        costCacheReadMicros,
        costCacheWriteMicros,
        costSource,
      });
    } catch (err: unknown) {
      console.warn("[pi-writer:message] message_end error:", err);
    }
  });
}
