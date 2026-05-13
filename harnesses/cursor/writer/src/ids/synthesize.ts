/**
 * ids/synthesize.ts — ID synthesis helpers for the Cursor writer.
 *
 * Cursor hook payloads identify sessions and turns with different fields than
 * Claude Code. This module centralises all ID derivation so the rest of the
 * codebase never has to reason about the mapping:
 *
 *   Harness session id  = conversation_id ?? session_id  (absent → undefined)
 *   Harness turn id     = generation_id when present, else synthesized counter
 *   Harness message id  = "cursor:<cid>:<gid>:assistant" when both present,
 *                         else synthesized counter
 *   Harness tool id     = tool_use_id when present, else synthesized counter
 *
 * Synthesized IDs use the harness session id as a namespace so they are
 * globally unique and stable for a given session (same index → same ID).
 */

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Session ID
// ---------------------------------------------------------------------------

/**
 * Derive the harness session id from a raw hook payload.
 *
 * Cursor uses `conversation_id` on most hooks and `session_id` (an alias) on
 * sessionStart / sessionEnd. We prefer `conversation_id`; fall back to
 * `session_id`. Return `undefined` when neither is present — callers should
 * warn and skip the event.
 */
export function extractHarnessSessionId(payload: {
  conversation_id?: string;
  session_id?: string;
}): string | undefined {
  return payload.conversation_id ?? payload.session_id ?? undefined;
}

// ---------------------------------------------------------------------------
// Turn ID
// ---------------------------------------------------------------------------

/**
 * Derive the harness turn id.
 *
 * When Cursor provides a `generation_id` (every distinct user submit), use it
 * directly — it is already stable and unique within the conversation. When
 * absent, synthesize a deterministic string from the session id and the turn
 * counter maintained in session state.
 *
 * @param generationId  Value of `generation_id` from the hook payload, if any.
 * @param sessionId     Harness session id (used as namespace for synthesis).
 * @param turnIndex     Per-session monotonic counter from session state.
 */
export function computeHarnessTurnId(
  generationId: string | undefined,
  sessionId: string,
  turnIndex: number,
): string {
  if (generationId !== undefined && generationId !== "") {
    return generationId;
  }
  // Synthesized format mirrors Claude Code's convention: <sessionId>:t<index>
  return `${sessionId}:t${turnIndex}`;
}

// ---------------------------------------------------------------------------
// LLM Message ID
// ---------------------------------------------------------------------------

/**
 * Derive the harness message id for an `afterAgentResponse` event.
 *
 * When both `conversation_id` and `generation_id` are present, build a
 * deterministic prefixed ID. This is the canonical form because it correlates
 * with the turn and lets a later backfill drain upsert the same row.
 *
 * When either field is absent (e.g. during early Cursor versions or in tests
 * that omit them), fall back to a state-counter ID so the row is still
 * recorded — just without stable correlation.
 *
 * @param conversationId  Value of `conversation_id` from the hook payload.
 * @param generationId    Value of `generation_id` from the hook payload.
 * @param sessionId       Harness session id (namespace for synthesis).
 * @param messageIndex    Per-session monotonic message counter from state.
 */
export function computeHarnessMessageId(
  conversationId: string | undefined,
  generationId: string | undefined,
  sessionId: string,
  messageIndex: number,
): string {
  if (
    conversationId !== undefined &&
    conversationId !== "" &&
    generationId !== undefined &&
    generationId !== ""
  ) {
    // Canonical form: unambiguously identifies this assistant turn across runs.
    return `cursor:${conversationId}:${generationId}:assistant`;
  }
  // Synthesized fallback: stable within session, but opaque without state.
  return `${sessionId}:m${messageIndex}`;
}

// ---------------------------------------------------------------------------
// Tool Call ID
// ---------------------------------------------------------------------------

/**
 * Derive the harness tool call id.
 *
 * When Cursor provides a `tool_use_id` (present on preToolUse, postToolUse,
 * and postToolUseFailure), use it — it is the canonical cross-event key.
 * Otherwise synthesize from the session id and a monotonic tool counter.
 *
 * @param toolUseId   Value of `tool_use_id` from the hook payload, if any.
 * @param sessionId   Harness session id (namespace for synthesis).
 * @param toolIndex   Per-session monotonic tool counter from session state.
 */
export function computeHarnessToolCallId(
  toolUseId: string | undefined,
  sessionId: string,
  toolIndex: number,
): string {
  if (toolUseId !== undefined && toolUseId !== "") {
    return toolUseId;
  }
  return `${sessionId}:tc${toolIndex}`;
}

// ---------------------------------------------------------------------------
// ToTally-internal UUID
// ---------------------------------------------------------------------------

/**
 * Mint a new random UUID for ToTally-internal primary keys (sessions, turns,
 * messages). Thin wrapper over crypto.randomUUID() so callers don't need to
 * import node:crypto directly.
 */
export function centralUuid(): string {
  return randomUUID();
}
