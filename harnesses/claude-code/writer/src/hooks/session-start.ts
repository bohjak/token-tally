/**
 * hooks/session-start.ts — Handler for the Claude Code SessionStart event.
 *
 * Responsibilities:
 * 1. Register the claude-code harness with the store.
 * 2. Create a new session row, stash the central UUID in per-session state.
 * 3. Optionally record a subscription period if the user has configured one.
 * 4. Fire-and-forget git repo metadata capture (non-blocking).
 *
 * This handler runs at the very start of every Claude Code session (including
 * resumed sessions — the idempotent upserts in the store handle replays safely).
 */

import type { AnalyticsWriter } from "@token-tally/store";
import type { HookPayload } from "./types.js";
import type { SessionState } from "../state/session-state.js";
import { writeSessionState } from "../state/session-state.js";
import { captureRepoSnapshot } from "../git/capture.js";
import { loadClaudeCodeSubscriptionConfig } from "../subscription/config.js";
import { computeMonthlyPeriod } from "../subscription/periods.js";
import { INTEGRATION_VERSION } from "../version.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Handle a SessionStart hook payload.
 *
 * Safe to call multiple times for the same session (all store writes are
 * idempotent upserts). On resume/clear, the state file may already exist;
 * we intentionally overwrite it so the transcript offset and turn index
 * stay consistent with the new session slice.
 */
export async function handle(
  writer: AnalyticsWriter,
  payload: Extract<HookPayload, { hook_event_name: "SessionStart" }>,
): Promise<void> {
  // ── 1. Register harness ──────────────────────────────────────────────────
  await writer.recordHarness({
    name: "claude-code",
    displayName: "Claude Code",
    version: process.env["CLAUDE_CODE_VERSION"] ?? "unknown",
    integrationVersion: INTEGRATION_VERSION,
  });

  // ── 2. Create / upsert session ───────────────────────────────────────────
  const sessionResult = await writer.recordSession({
    harnessId: "claude-code",
    harnessSessionId: payload.session_id,
    cwd: payload.cwd,
    startedAt: Date.now(),
  });
  const centralSessionId = sessionResult.id;

  // ── 3. Subscription period ───────────────────────────────────────────────
  let subscriptionId: string | null = null;

  const subConfig = await loadClaudeCodeSubscriptionConfig();
  if (subConfig !== null) {
    const { periodStartMs, periodEndMs } = computeMonthlyPeriod(
      new Date(),
      subConfig.startDay,
    );
    const subResult = await writer.recordSubscription({
      harnessId: "claude-code",
      planName: subConfig.plan,
      periodStart: periodStartMs,
      periodEnd: periodEndMs,
      fixedCost: subConfig.fixedCostUSD,
      currency: "USD",
    });
    subscriptionId = subResult.id;
  }

  // ── 4. Persist initial session state ────────────────────────────────────
  const state: SessionState = {
    centralSessionId,
    harnessSessionId: payload.session_id,
    turnIndex: 0,
    currentTurnId: null,
    currentHarnessTurnId: null,
    transcriptPath: null,
    transcriptOffset: 0,
    lastModelId: null,
    lastProvider: null,
    subscriptionId,
    activeTools: {},
  };
  await writeSessionState(payload.session_id, state);

  // ── 5. Await git capture (M7 fix) ──────────────────────────────────────────
  // Previously fire-and-forget: the hook process could exit before git finished,
  // losing repo metadata. We now await so the capture completes before close().
  // captureRepoSnapshot is bounded by GIT_TIMEOUT_MS; if the outer
  // DISPATCH_TIMEOUT_MS fires first, this await is abandoned — that is
  // acceptable for the >3s case, but the common (<1s) case now succeeds.
  const snapshot = await captureRepoSnapshot(payload.cwd).catch(() => null);
  if (snapshot !== null) {
    await writer.recordSession({
      harnessId: "claude-code",
      harnessSessionId: payload.session_id,
      cwd: payload.cwd,
      startedAt: Date.now(),
      repoOwner: snapshot.repoOwner ?? undefined,
      repoName: snapshot.repoName ?? undefined,
      repoRemote: snapshot.repoRemote ?? undefined,
    });
  }
}
