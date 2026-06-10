/**
 * main.ts — Dispatcher and lifecycle entrypoint for the Claude Code writer.
 *
 * Claude Code fires hooks by spawning a new process and writing the event
 * payload as JSON to stdin. This module:
 *   1. Reads and parses that stdin payload.
 *   2. Opens an AnalyticsWriter (falls back to spool on DB contention).
 *   3. Dispatches to the appropriate handler based on hook_event_name.
 *   4. Always exits 0 — a non-zero exit would block Claude Code tools.
 *
 * Design constraints:
 *   - The entire dispatch must complete within 3 seconds (wall clock). If
 *     the handler times out, we warn and proceed to writer.close() so spool
 *     data is still flushed.
 *   - Every error is caught and logged via console.warn; nothing here should
 *     ever propagate and crash the process.
 *   - `Notification` and `PreCompact` events are intentionally ignored.
 */

import { AnalyticsWriter } from "@token-tally/store";
import type { HookPayload } from "./hooks/types.js";
import * as sessionStart from "./hooks/session-start.js";
import * as sessionEnd from "./hooks/session-end.js";
import * as userPromptSubmit from "./hooks/user-prompt-submit.js";
import * as preToolUse from "./hooks/pre-tool-use.js";
import * as postToolUse from "./hooks/post-tool-use.js";
import * as stop from "./hooks/stop.js";
import * as subagentStop from "./hooks/subagent-stop.js";

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
 * Returns a promise that resolves when the handler completes (or rejects on
 * handler error — the caller wraps this in try/catch).
 */
async function dispatch(writer: AnalyticsWriter, payload: HookPayload): Promise<void> {
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
  // ── 1. Read stdin ──────────────────────────────────────────────────────────
  let raw: string;
  try {
    raw = await readStdin();
  } catch (err) {
    console.warn("[claude-code-writer] failed to read stdin:", err);
    return;
  }

  if (raw.trim() === "") {
    console.warn("[claude-code-writer] empty stdin — nothing to process");
    return;
  }

  // ── 2. Parse JSON ──────────────────────────────────────────────────────────
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    console.warn("[claude-code-writer] invalid JSON on stdin:", raw.slice(0, 200));
    return;
  }

  // ── 3. Validate minimal shape ──────────────────────────────────────────────
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("hook_event_name" in payload)
  ) {
    console.warn(
      "[claude-code-writer] payload missing hook_event_name — ignoring",
    );
    return;
  }

  // ── 4. Open AnalyticsWriter ────────────────────────────────────────────────
  let writer: AnalyticsWriter;
  try {
    writer = await AnalyticsWriter.open({
      harnessName: "claude-code",
      // Hot-path hook: explicitly opt out of full-directory spool drain.
      // Each hook invocation is a short-lived one-shot process — scanning
      // and draining the whole spool directory on every tool call or session
      // event would cause high CPU and latency when a large backlog exists.
      // The drain daemon (T6) owns full-directory drain. On close(), the
      // writer still drains its own just-rotated file (one file, bounded).
      drain: {},
    });
  } catch (err) {
    console.warn("[claude-code-writer] failed to open AnalyticsWriter:", err);
    return;
  }

  // ── 5. Dispatch with timeout, then close ──────────────────────────────────
  try {
    await Promise.race([
      dispatch(writer, payload as HookPayload),
      timeoutAfter(DISPATCH_TIMEOUT_MS),
    ]);
  } catch (err) {
    console.warn("[claude-code-writer]", err);
  } finally {
    // Always close: rotates the active spool file so the drain daemon can
    // pick it up. Does NOT drain the full spool directory (see drain: {} above).
    // Errors here are best-effort — we cannot do anything useful with them.
    try {
      await writer.close();
    } catch (closeErr) {
      console.warn("[claude-code-writer] error closing writer:", closeErr);
    }
  }
}
