/**
 * hooks/pre-compact.ts — Handler for the Cursor preCompact event.
 *
 * Fires before Cursor summarises the context window. This is the ONLY Cursor
 * hook payload that includes token data (context_tokens / context_window_size).
 *
 * Default behaviour: no-op. Raw capture is opt-in via the config file:
 * ```json
 * { "harnesses": { "cursor": { "captureRaw": true } } }
 * ```
 *
 * When captureRaw is enabled, emits a minimal raw_event containing only the
 * context window token counts — no conversation text, no PII.
 *
 * Allowed raw_event kinds: "preCompact" (static allowlist).
 */

import type { AnalyticsWriter } from "@token-tally/store";
import type { HookPayload } from "./types.js";
import { loadCaptureRawFlag } from "../subscription/config.js";
import { extractHarnessSessionId } from "../ids/synthesize.js";

// ---------------------------------------------------------------------------
// Raw event kind allowlist
// ---------------------------------------------------------------------------

const RAW_KIND = "preCompact" as const;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle a preCompact event.
 *
 * No-op unless captureRaw is enabled in the cursor harness config.
 * When enabled, emits a minimal raw_event with token count metadata only.
 */
export async function handle(
  writer: AnalyticsWriter,
  payload: Extract<HookPayload, { hook_event_name: "preCompact" }>,
): Promise<void> {
  // ── 1. Check captureRaw flag ──────────────────────────────────────────────
  const captureRaw = await loadCaptureRawFlag();
  if (!captureRaw) {
    // Normal path: preCompact is installed but this hook is a no-op unless
    // the user opts in to raw capture.
    return;
  }

  // ── 2. Derive harness session id (for completeness in the event) ─────────
  const harnessSessionId = extractHarnessSessionId(payload);

  // ── 3. Emit minimal raw event ─────────────────────────────────────────────
  // Only token window metrics are recorded — never conversation content.
  // The doctor command samples raw_events rows for sensitive-key violations;
  // this payload contains only numeric context stats.
  const safePayload: Record<string, unknown> = {
    trigger: payload.trigger ?? "auto",
    context_tokens: payload.context_tokens ?? null,
    context_window_size: payload.context_window_size ?? null,
    context_usage_percent: payload.context_usage_percent ?? null,
    is_first_compaction: payload.is_first_compaction ?? null,
  };
  if (harnessSessionId !== undefined) {
    safePayload["session_id"] = harnessSessionId;
  }

  await writer.recordRawEvent({
    harnessId: "cursor",
    ts: Date.now(),
    kind: RAW_KIND,
    payloadJson: JSON.stringify(safePayload),
  });
}
