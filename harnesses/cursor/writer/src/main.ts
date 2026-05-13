/**
 * main.ts — Dispatcher and lifecycle entrypoint for the Cursor writer.
 *
 * Cursor fires hooks by spawning a new process and writing the event payload
 * as JSON to stdin. This module:
 *   1. Reads and parses that stdin payload.
 *   2. Opens an AnalyticsWriter (falls back to spool on DB contention).
 *   3. Dispatches to the appropriate handler based on hook_event_name.
 *   4. Always resolves (never rejects) — exit 0 guaranteed by the caller.
 *
 * Design constraints:
 *   - The entire dispatch must complete within 3 seconds (wall clock). If the
 *     handler times out, we warn and proceed to writer.close() so spool data
 *     is still flushed.
 *   - Every error is caught and logged via console.warn; nothing here should
 *     ever propagate and crash the process.
 *   - Events with no analytics value are handled as explicit no-ops to satisfy
 *     TypeScript exhaustiveness and avoid silent drops.
 *
 * Key difference from Claude Code: event names are lower-camel (`sessionStart`,
 * not `SessionStart`) and IDs use `conversation_id` / `generation_id`.
 */

import { AnalyticsWriter } from "@token-tally/store";
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
// Constants
// ---------------------------------------------------------------------------

/** Hard wall-clock budget for a single hook dispatch (ms). */
const DISPATCH_TIMEOUT_MS = 3_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read all of stdin to a string. Resolves with "" on an empty stream. */
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

/** Reject after `ms` milliseconds with a named timeout error. */
function timeoutAfter(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`hook dispatch timed out after ${ms}ms`)), ms),
  );
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatch a validated HookPayload to the appropriate handler.
 *
 * Returns a promise that resolves when the handler completes. The caller
 * wraps this in try/catch + Promise.race with a timeout.
 */
async function dispatch(writer: AnalyticsWriter, payload: HookPayload): Promise<void> {
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
    // These events are installed to avoid missed-event warnings, but carry no
    // analytics value that the structured tables cannot capture.
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
      // Exhaustiveness guard: TypeScript flags a missing case above, but at
      // runtime a future Cursor version may add new event names.
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
  // ── 1. Read stdin ──────────────────────────────────────────────────────────
  let raw: string;
  try {
    raw = await readStdin();
  } catch (err) {
    console.warn("[cursor-writer] failed to read stdin:", err);
    return;
  }

  if (raw.trim() === "") {
    console.warn("[cursor-writer] empty stdin — nothing to process");
    return;
  }

  // ── 2. Parse JSON ──────────────────────────────────────────────────────────
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    console.warn("[cursor-writer] invalid JSON on stdin:", raw.slice(0, 200));
    return;
  }

  // ── 3. Validate minimal shape ──────────────────────────────────────────────
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("hook_event_name" in payload)
  ) {
    console.warn(
      "[cursor-writer] payload missing hook_event_name — ignoring",
    );
    return;
  }

  // ── 4. Open AnalyticsWriter ────────────────────────────────────────────────
  let writer: AnalyticsWriter;
  try {
    writer = await AnalyticsWriter.open({ harnessName: "cursor" });
  } catch (err) {
    console.warn("[cursor-writer] failed to open AnalyticsWriter:", err);
    return;
  }

  // ── 5. Dispatch with timeout, then close ──────────────────────────────────
  try {
    await Promise.race([
      dispatch(writer, payload as HookPayload),
      timeoutAfter(DISPATCH_TIMEOUT_MS),
    ]);
  } catch (err) {
    console.warn("[cursor-writer]", err);
  } finally {
    // Always close: rotates the active spool file and drains closed spools.
    // Errors here are best-effort — we cannot do anything useful with them.
    try {
      await writer.close();
    } catch (closeErr) {
      console.warn("[cursor-writer] error closing writer:", closeErr);
    }
  }
}
