/**
 * main.ts — Dispatcher and lifecycle entrypoint for the Cursor writer.
 *
 * Cursor fires hooks by spawning a new process and writing the event payload
 * as JSON to stdin. This module dispatches to the appropriate handler based
 * on hook_event_name.
 *
 * The full stdin-to-dispatch lifecycle (read, parse, open writer, timeout,
 * close) is managed by runHookProcess from @token-tally/harness-kit, which
 * also fixes the malformed-stdin logging (m5: byte length + error position
 * only, never raw payload slices).
 *
 * Design constraints:
 *   - Always resolves (never rejects) — exit 0 guaranteed by the caller.
 *   - Dispatch must complete within 3 seconds (wall clock).
 *   - Events with no analytics value are explicit no-ops (TypeScript
 *     exhaustiveness guard) to avoid silent drops.
 *
 * Key difference from Claude Code: event names are lower-camel (`sessionStart`,
 * not `SessionStart`) and IDs use `conversation_id` / `generation_id`.
 */

import type { AnalyticsWriter } from "@token-tally/store";
import { runHookProcess } from "@token-tally/harness-kit";
import type { HookPayload } from "./hooks/types.js";
import * as sessionStart from "./hooks/session-start.js";
import * as sessionEnd from "./hooks/session-end.js";
import * as beforeSubmitPrompt from "./hooks/before-submit-prompt.js";
import * as afterAgentResponse from "./hooks/after-agent-response.js";
import * as preToolUse from "./hooks/pre-tool-use.js";
import * as postToolUse from "./hooks/post-tool-use.js";
import * as postToolUseFailure from "./hooks/post-tool-use-failure.js";
import * as stop from "./hooks/stop.js";
import * as subagentStop from "./hooks/subagent-stop.js";
import * as preCompact from "./hooks/pre-compact.js";

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatch a validated HookPayload to the appropriate handler.
 */
async function dispatch(writer: AnalyticsWriter, rawPayload: Record<string, unknown>): Promise<void> {
  const payload = rawPayload as unknown as HookPayload;
  switch (payload.hook_event_name) {
    // ── Core session lifecycle ──────────────────────────────────────────────
    case "sessionStart":
      await sessionStart.handle(writer, payload);
      break;
    case "sessionEnd":
      await sessionEnd.handle(writer, payload);
      break;

    // ── Prompt / response ───────────────────────────────────────────────────
    case "beforeSubmitPrompt":
      await beforeSubmitPrompt.handle(writer, payload);
      break;
    case "afterAgentResponse":
      await afterAgentResponse.handle(writer, payload);
      break;

    // ── Tool use ────────────────────────────────────────────────────────────
    case "preToolUse":
      await preToolUse.handle(writer, payload);
      break;
    case "postToolUse":
      await postToolUse.handle(writer, payload);
      break;
    case "postToolUseFailure":
      await postToolUseFailure.handle(writer, payload);
      break;

    // ── Agent completion ────────────────────────────────────────────────────
    case "stop":
      await stop.handle(writer, payload);
      break;
    case "subagentStop":
      await subagentStop.handle(writer, payload);
      break;

    // ── Context compaction ──────────────────────────────────────────────────
    case "preCompact":
      await preCompact.handle(writer, payload);
      break;

    // ── Observed but not processed ──────────────────────────────────────────
    case "afterAgentThought":
    case "subagentStart":
    case "beforeShellExecution":
    case "afterShellExecution":
    case "beforeMCPExecution":
    case "afterMCPExecution":
    case "beforeReadFile":
    case "afterFileEdit":
    case "beforeTabFileRead":
    case "afterTabFileEdit":
    case "workspaceOpen":
      // Intentional no-op.
      break;

    default: {
      const _exhaustive: never = payload;
      console.warn(
        "[cursor-writer] unknown hook_event_name:",
        (_exhaustive as HookPayload).hook_event_name,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Main entrypoint for the Cursor writer hook.
 *
 * Called by `bin/token-tally-cursor-hook.ts`. Always resolves (never rejects)
 * so the caller can unconditionally `process.exit(0)`.
 */
export async function run(): Promise<void> {
  await runHookProcess({
    harnessName: "cursor",
    dispatch,
  });
}
