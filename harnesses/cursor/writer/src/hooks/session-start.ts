/**
 * hooks/session-start.ts — Handler for the Cursor sessionStart event.
 *
 * Fires once when a new Cursor composer conversation opens. Responsibilities:
 *   1. Register the cursor harness with the store.
 *   2. Create (or upsert) the session row; store the central UUID in state.
 *   3. Optionally record a subscription period if the user configured one.
 *   4. Await git metadata capture (M7 fix: was fire-and-forget; now awaited
 *      so the capture completes before the hook process closes the writer).
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
import { computeMonthlyPeriod, inferProvider } from "@token-tally/harness-kit";
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
  // centralUuid() is imported but not used here — the store owns the session UUID.
  void centralUuid;
  const state = makeInitialSessionState(centralSessionId, harnessSessionId);
  state.subscriptionId = subscriptionId;
  if (payload.model) {
    state.lastModelId = payload.model;
    state.lastProvider = inferProvider(payload.model);
  }
  await writeSessionState(harnessSessionId, state);

  // ── 6. Await git capture (M7 fix) ─────────────────────────────────────────
  // Previously fire-and-forget: the hook could exit before git finished,
  // losing repo metadata. We now await so the capture completes before
  // writer.close(). captureRepoSnapshot is bounded by GIT_TIMEOUT_MS; if the
  // outer DISPATCH_TIMEOUT_MS fires first, this await is abandoned — acceptable
  // for the >3s case; the common (<1s) case now reliably records repo metadata.
  if (cwd) {
    const snapshot = await captureRepoSnapshot(cwd).catch(() => null);
    if (snapshot !== null) {
      await writer.recordSession({
        harnessId: "cursor",
        harnessSessionId,
        cwd,
        startedAt: 0, // NULLIF guard: preserves original start time
        repoOwner: snapshot.repoOwner ?? undefined,
        repoName: snapshot.repoName ?? undefined,
        repoRemote: snapshot.repoRemote ?? undefined,
      });
    }
  }
}
