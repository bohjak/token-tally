/**
 * main.ts — Dispatcher and lifecycle entrypoint for the Claude Code writer.
 *
 * Claude Code fires hooks by spawning a new process and writing the event
 * payload as JSON to stdin. This module dispatches to the appropriate handler
 * based on hook_event_name.
 *
 * The full stdin-to-dispatch lifecycle (read, parse, open writer, timeout,
 * close) is managed by runHookProcess from @token-tally/harness-kit, which
 * also fixes the malformed-stdin logging (m5: byte length + error position
 * only, never raw payload slices).
 *
 * Design constraints:
 *   - Always exits 0 — a non-zero exit would block Claude Code tools.
 *   - Dispatch must complete within 3 seconds (wall clock).
 *   - `Notification` and `PreCompact` events are intentionally ignored.
 */

import type { AnalyticsWriter } from "@token-tally/store";
import { runHookProcess } from "@token-tally/harness-kit";
import type { HookPayload } from "./hooks/types.js";
import * as sessionStart from "./hooks/session-start.js";
import * as sessionEnd from "./hooks/session-end.js";
import * as userPromptSubmit from "./hooks/user-prompt-submit.js";
import * as preToolUse from "./hooks/pre-tool-use.js";
import * as postToolUse from "./hooks/post-tool-use.js";
import * as stop from "./hooks/stop.js";
import * as subagentStop from "./hooks/subagent-stop.js";

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatch a validated HookPayload to the appropriate handler.
 */
async function dispatch(writer: AnalyticsWriter, rawPayload: Record<string, unknown>): Promise<void> {
  const payload = rawPayload as unknown as HookPayload;
  switch (payload.hook_event_name) {
    case "SessionStart":
      await sessionStart.handle(writer, payload);
      break;
    case "SessionEnd":
      await sessionEnd.handle(writer, payload);
      break;
    case "UserPromptSubmit":
      await userPromptSubmit.handle(writer, payload);
      break;
    case "PreToolUse":
      await preToolUse.handle(writer, payload);
      break;
    case "PostToolUse":
      await postToolUse.handle(writer, payload);
      break;
    case "Stop":
      await stop.handle(writer, payload);
      break;
    case "SubagentStop":
      await subagentStop.handle(writer, payload);
      break;
    case "Notification":
    case "PreCompact":
      // Intentionally ignored — no analytics value.
      break;
    default: {
      // Exhaustiveness guard: TypeScript would flag a missing case, but at
      // runtime a future Claude Code version may add new event names.
      const _exhaustive: never = payload;
      console.warn(
        "[claude-code-writer] unknown hook_event_name:",
        (_exhaustive as HookPayload).hook_event_name,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Main entrypoint for the Claude Code writer hook.
 *
 * Called by `bin/token-tally-claude-hook.ts`. Always resolves (never rejects)
 * so the caller can unconditionally `process.exit(0)`.
 */
export async function run(): Promise<void> {
  await runHookProcess({
    harnessName: "claude-code",
    dispatch,
  });
}
