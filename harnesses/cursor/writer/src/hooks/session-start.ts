/**
 * hooks/session-start.ts — Handler for the Cursor sessionStart event.
 *
 * Fires once when a new Cursor composer conversation opens. Responsibilities:
 *   1. Register the cursor harness with the store.
 *   2. Create (or upsert) the session row; store the central UUID in state.
 *   3. Optionally record a subscription period if the user configured one.
 *   4. Fire-and-forget git metadata capture (non-blocking).
 *
 * This event has BOTH `session_id` and `conversation_id` per Cursor's docs —
 * both are equivalent here. We use `conversation_id ?? session_id` as the
 * harness session id for consistency with all other events.
 */

import type { AnalyticsWriter } from "@token-tally/store";
import type { HookPayload } from "./types.js";
import {
  makeInitialSessionState,
  writeSessionState,
} from "../state/session-state.js";
import { extractHarnessSessionId, centralUuid } from "../ids/synthesize.js";
import { captureRepoSnapshot } from "../git/capture.js";
import { loadCursorSubscriptionConfig } from "../subscription/config.js";
import { computeMonthlyPeriod } from "../subscription/periods.js";
import { INTEGRATION_VERSION } from "../version.js";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle a sessionStart event.
 *
 * Idempotent: all store writes upsert on stable IDs, so replaying is safe
 * (e.g. Cursor may fire sessionStart on resume/clear).
 */
export async function handle(
  writer: AnalyticsWriter,
  payload: Extract<HookPayload, { hook_event_name: "sessionStart" }>,
): Promise<void> {
  // ── 1. Derive harness session id ─────────────────────────────────────────
  const harnessSessionId = extractHarnessSessionId(payload);
  if (harnessSessionId === undefined) {
    console.warn(
      "[cursor-writer] sessionStart: payload missing both conversation_id and session_id — ignoring",
    );
    return;
  }

  // ── 2. Register harness ──────────────────────────────────────────────────
  await writer.recordHarness({
    name: "cursor",
    displayName: "Cursor",
    version: payload.cursor_version ?? undefined,
    integrationVersion: INTEGRATION_VERSION,
  });

  // ── 3. Create / upsert session ───────────────────────────────────────────
  const cwd =
    payload.cwd ??
    (payload.workspace_roots && payload.workspace_roots.length > 0
      ? payload.workspace_roots[0]
      : undefined);

  const sessionResult = await writer.recordSession({
    harnessId: "cursor",
    harnessSessionId,
    cwd,
    startedAt: Date.now(),
  });
  const centralSessionId = sessionResult.id;

  // ── 4. Subscription period ───────────────────────────────────────────────
  let subscriptionId: string | null = null;

  const subConfig = await loadCursorSubscriptionConfig();
  if (subConfig !== null) {
    const { periodStartMs, periodEndMs } = computeMonthlyPeriod(
      new Date(),
      subConfig.startDay,
    );
    const subResult = await writer.recordSubscription({
      harnessId: "cursor",
      planName: subConfig.plan,
      periodStart: periodStartMs,
      periodEnd: periodEndMs,
      fixedCost: subConfig.fixedCostUSD,
      currency: "USD",
    });
    subscriptionId = subResult.id;
  }

  // ── 5. Persist initial session state ────────────────────────────────────
  // centralUuid() is imported but not used here — we use the value from
  // recordSession since the store owns the UUID for sessions.
  void centralUuid; // keep import used; actual session UUID comes from the store
  const state = makeInitialSessionState(centralSessionId, harnessSessionId);
  state.subscriptionId = subscriptionId;
  if (payload.model) {
    state.lastModelId = payload.model;
    state.lastProvider = inferProvider(payload.model);
  }
  await writeSessionState(harnessSessionId, state);

  // ── 6. Fire-and-forget git capture ───────────────────────────────────────
  // Do not await — git metadata is best-effort and must not delay the hook.
  // The idempotent upsert on (harness_id, harness_session_id) safely patches
  // the repo fields in once the subprocess completes.
  if (cwd) {
    captureRepoSnapshot(cwd)
      .then(async (snapshot) => {
        if (snapshot === null) return;
        await writer.recordSession({
          harnessId: "cursor",
          harnessSessionId,
          cwd,
          startedAt: 0, // NULLIF guard: preserves original start time
          repoOwner: snapshot.repoOwner ?? undefined,
          repoName: snapshot.repoName ?? undefined,
          repoRemote: snapshot.repoRemote ?? undefined,
        });
      })
      .catch(() => {
        // Best-effort: never surface to caller.
      });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Infer the LLM provider from a model ID using well-known prefixes.
 * Returns null for unknown or ambiguous model IDs.
 */
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
