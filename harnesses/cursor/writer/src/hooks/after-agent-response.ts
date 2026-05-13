/**
 * hooks/after-agent-response.ts — Handler for the Cursor afterAgentResponse event.
 *
 * Fires after the agent produces an assistant message. We record a placeholder
 * LLM message row with zero tokens (Cursor hook payloads do not include token
 * counts). The `stop` handler will attempt to backfill tokens/model/cost from
 * the hook-provided transcript_path or Cursor's private state.vscdb (T7/T8).
 *
 * The assistant response text is intentionally NOT stored — data minimisation.
 *
 * The harness_message_id uses the canonical form:
 *   cursor:<conversation_id>:<generation_id>:assistant
 * which allows a later backfill to upsert the same row by id.
 */

import type { AnalyticsWriter } from "@token-tally/store";
import type { HookPayload } from "./types.js";
import {
  readSessionState,
  writeSessionState,
} from "../state/session-state.js";
import {
  extractHarnessSessionId,
  computeHarnessMessageId,
} from "../ids/synthesize.js";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle an afterAgentResponse event.
 *
 * Inserts a placeholder llm_messages row. Zero tokens and unknown cost are
 * correct defaults — the DB CHECK constraint allows this (0 = 0+0+0+0).
 */
export async function handle(
  writer: AnalyticsWriter,
  payload: Extract<HookPayload, { hook_event_name: "afterAgentResponse" }>,
): Promise<void> {
  // ── 1. Derive harness session id ─────────────────────────────────────────
  const harnessSessionId = extractHarnessSessionId(payload);
  if (harnessSessionId === undefined) {
    console.warn(
      "[cursor-writer] afterAgentResponse: no conversation_id in payload — ignoring",
    );
    return;
  }

  // ── 2. Load state ─────────────────────────────────────────────────────────
  const state = await readSessionState(harnessSessionId);
  if (state === null) {
    console.warn(
      "[cursor-writer] afterAgentResponse: no state for session",
      harnessSessionId,
      "— skipping (writer may have missed sessionStart)",
    );
    return;
  }

  // ── 3. Compute message id ─────────────────────────────────────────────────
  const harnessMessageId = computeHarnessMessageId(
    payload.conversation_id,
    payload.generation_id,
    harnessSessionId,
    state.messageIndex,
  );

  // ── 4. Advance message counter ────────────────────────────────────────────
  state.messageIndex += 1;

  // ── 5. Record placeholder LLM message ────────────────────────────────────
  // Tokens are zero because Cursor hook payloads do not carry token counts.
  // T7/T8 will upsert this row later with real counts if the transcript or
  // state.vscdb provides them.
  const modelId = payload.model ?? state.lastModelId ?? undefined;
  await writer.recordLlmMessage({
    sessionId: state.centralSessionId,
    turnId: state.currentTurnId ?? undefined,
    harnessId: "cursor",
    harnessMessageId,
    ts: Date.now(),
    modelId,
    provider: modelId ? (inferProvider(modelId) ?? undefined) : undefined,
    // Explicit zero tokens — not an omission, just the current best knowledge.
    inputTokens: 0,
    outputTokens: 0,
    costSource: "unknown",
    subscriptionId: state.subscriptionId ?? undefined,
  });

  // ── 6. Update state ───────────────────────────────────────────────────────
  if (payload.model) {
    state.lastModelId = payload.model;
  }

  await writeSessionState(harnessSessionId, state);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inferProvider(modelId: string): string | null {
  if (modelId.startsWith("claude-")) return "anthropic";
  if (
    modelId.startsWith("gpt-") ||
    modelId.startsWith("o1-") ||
    modelId.startsWith("o3-") ||
    modelId.startsWith("o4-")
  )
    return "openai";
  if (modelId.startsWith("gemini-")) return "google";
  if (modelId.startsWith("grok-")) return "xai";
  return null;
}
