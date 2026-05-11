/**
 * turn-state.ts — In-process turn and model state.
 *
 * Tracks the active turn for each session so that message and tool hooks can
 * attach their records to the correct turn without coupling to turn.ts internals.
 *
 * Model tracking is here too: Pi's `turn_start` payload does not include the
 * model — it must be read from the most recent `model_select` event, or
 * (more reliably) from the `message.model` field on `message_end`.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** State for one in-flight Pi turn. */
export type TurnState = {
  /**
   * Stable harness-level turn ID synthesised as `${harnessSessionId}:t${turnIndex}`.
   * Used as the idempotency key when upserting the turn row.
   */
  harnessTurnId: string;
  /** ToTally-internal UUID returned by writer.recordTurn(). */
  centralTurnId: string;
  /** Pi's zero-based turn index within the session (from turn_start event). */
  turnIndex: number;
  /** Wall-clock ms when the turn started — for accurate ended_at. */
  startedAt: number;
  /** Counter incremented for each message_end within this turn. */
  messageCounter: number;
};

/** Current model info tracked per session. */
export type ModelInfo = {
  modelId: string;
  provider: string | null;
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Maps centralSessionId → in-flight turn state.
 * At most one turn is active per session at a time in Pi's sequential model.
 */
const activeTurns = new Map<string, TurnState>();

/**
 * Maps centralSessionId → current model info.
 * Updated by `model_select` and by each `message_end` (which carries the
 * authoritative model used for the response).
 */
const activeModels = new Map<string, ModelInfo>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Store the active turn for a session. Called at turn_start. */
export function setTurn(centralSessionId: string, state: TurnState): void {
  activeTurns.set(centralSessionId, state);
}

/** Retrieve the active turn for a session, or undefined if none is registered. */
export function getTurn(centralSessionId: string): TurnState | undefined {
  return activeTurns.get(centralSessionId);
}

/** Remove the active turn for a session. Called at turn_end. */
export function clearTurn(centralSessionId: string): void {
  activeTurns.delete(centralSessionId);
}

/** Update the active model for a session. Called from model_select and message_end. */
export function setActiveModel(centralSessionId: string, info: ModelInfo): void {
  activeModels.set(centralSessionId, info);
}

/** Return the current model info for a session, or null if none has been set. */
export function getActiveModel(centralSessionId: string): ModelInfo | null {
  return activeModels.get(centralSessionId) ?? null;
}

/** Remove model state for a session. Called at session_shutdown. */
export function clearModel(centralSessionId: string): void {
  activeModels.delete(centralSessionId);
}
