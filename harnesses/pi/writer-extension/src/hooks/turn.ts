/**
 * turn.ts — Turn lifecycle hooks for the Pi writer extension.
 *
 * Handles:
 *   turn_start    — creates a turn row in the central store.
 *   turn_end      — updates turn with end time, final model, and provider.
 *   model_select  — secondary subscription to keep the per-session model
 *                   tracker current; session.ts also subscribes (Pi supports
 *                   multiple listeners per event).
 *
 * ## Model attribution
 * Pi's turn_start payload does not include model/provider — those come from
 * the most recent model_select event or (more reliably) from message.model on
 * message_end. turn.ts tracks models from model_select; message.ts calls
 * setActiveModel() from the actual message, so turn_end always writes the
 * authoritative model even when model_select never fired.
 *
 * ## Idempotency
 * harnessTurnId is synthesised as `${harnessSessionId}:t${turnIndex}`.
 * The UNIQUE (session_id, harness_turn_id) constraint ensures upserts are safe.
 */

import type { AnalyticsWriter } from "@token-tally/store";
import type { PiAPIStub, PiContextStub } from "./types.ts";
import { getCentralSessionId, getSession } from "./session-state.ts";
import {
  setTurn,
  getTurn,
  clearTurn,
  setActiveModel,
  getActiveModel,
} from "./turn-state.ts";

// ---------------------------------------------------------------------------
// Pi event payload shapes
// ---------------------------------------------------------------------------

type PiTurnStartEvent = {
  turnIndex: number;
  timestamp?: number;
};

type PiTurnEndEvent = {
  turnIndex: number;
  message?: {
    role?: string;
    stopReason?: string;
    stop_reason?: string;
  };
};

type PiModelSelectEvent = {
  model: { id: string; provider?: string };
};

// ---------------------------------------------------------------------------
// register() — the single public export
// ---------------------------------------------------------------------------

/**
 * Register all turn-lifecycle event handlers.
 *
 * @param pi     Pi ExtensionAPI.
 * @param writer The open AnalyticsWriter.
 */
export function register(pi: PiAPIStub, writer: AnalyticsWriter): void {

  // ── model_select (secondary — tracking only, no sink write) ───────────────

  pi.on("model_select", (_rawEvent: unknown, piCtx: PiContextStub) => {
    try {
      const event = _rawEvent as PiModelSelectEvent;
      const centralSessionId = getCentralSessionId(
        piCtx.sessionManager.getSessionFile(),
      );
      if (centralSessionId == null) return;

      setActiveModel(centralSessionId, {
        modelId: event.model.id,
        provider: event.model.provider ?? null,
      });
    } catch (err: unknown) {
      console.warn("[pi-writer:turn] model_select tracking error:", err);
    }
  });

  // ── turn_start ────────────────────────────────────────────────────────────

  pi.on("turn_start", async (rawEvent: unknown, piCtx: PiContextStub) => {
    try {
      const event = rawEvent as PiTurnStartEvent;
      const sessionFile = piCtx.sessionManager.getSessionFile();
      const state = getSession(sessionFile);

      if (state == null) {
        // Extension loaded mid-session or session_start hasn't fired.
        console.warn("[pi-writer:turn] turn_start without registered session");
        return;
      }

      const { centralSessionId, harnessSessionId } = state;

      // Synthesise a stable turn ID: session file path + turn index.
      // This makes upserts idempotent — same session + same turn index = same row.
      const harnessTurnId = `${harnessSessionId}:t${event.turnIndex}`;

      const now = event.timestamp ?? Date.now();
      const modelInfo = getActiveModel(centralSessionId);

      const turnResult = await writer.recordTurn({
        harnessId: "pi",
        sessionId: centralSessionId,
        harnessTurnId,
        turnIndex: event.turnIndex,
        startedAt: now,
        provider: modelInfo?.provider ?? undefined,
        modelId: modelInfo?.modelId ?? undefined,
      });

      setTurn(centralSessionId, {
        harnessTurnId,
        centralTurnId: turnResult.id,
        turnIndex: event.turnIndex,
        startedAt: now,
        messageCounter: 0,
      });
    } catch (err: unknown) {
      console.warn("[pi-writer:turn] turn_start error:", err);
    }
  });

  // ── turn_end ──────────────────────────────────────────────────────────────

  pi.on("turn_end", async (rawEvent: unknown, piCtx: PiContextStub) => {
    try {
      const event = rawEvent as PiTurnEndEvent;
      const sessionFile = piCtx.sessionManager.getSessionFile();
      const state = getSession(sessionFile);
      if (state == null) return;

      const { centralSessionId } = state;
      const turnState = getTurn(centralSessionId);

      if (turnState == null) {
        console.warn("[pi-writer:turn] turn_end without registered turn");
        return;
      }

      const now = Date.now();
      // Prefer the model updated by message_end (via setActiveModel in message.ts)
      // over the model frozen at turn_start — the message carries the authoritative
      // model used for the response even when model_select never fired.
      const modelInfo = getActiveModel(centralSessionId);

      // Upsert turn row with end time and final model.
      await writer.recordTurn({
        harnessId: "pi",
        sessionId: centralSessionId,
        harnessTurnId: turnState.harnessTurnId,
        turnIndex: event.turnIndex,
        startedAt: turnState.startedAt,
        endedAt: now,
        provider: modelInfo?.provider ?? undefined,
        modelId: modelInfo?.modelId ?? undefined,
      });

      clearTurn(centralSessionId);
    } catch (err: unknown) {
      console.warn("[pi-writer:turn] turn_end error:", err);
    }
  });
}
