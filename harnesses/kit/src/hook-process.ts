/**
 * hook-process.ts — Stdin-to-dispatch lifecycle helpers for hook-process writers.
 *
 * Replaces near-identical boilerplate in:
 *   harnesses/claude-code/writer/src/main.ts
 *   harnesses/cursor/writer/src/main.ts
 *
 * BEHAVIORAL FIX: malformed stdin logging (m5)
 * ─────────────────────────────────────────────
 * The old code logged `raw.slice(0, 200)` on JSON parse failure, which could
 * echo prompt text to stderr and into logs. This module logs only:
 *   - The byte length of the received payload
 *   - The parse error position (SyntaxError.message)
 * so diagnostics remain useful without leaking conversation content.
 */

import { AnalyticsWriter } from "@token-tally/store";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A dispatch function receives the open writer and the parsed (but not yet
 * validated beyond shape) payload. It is responsible for routing to the
 * correct hook handler. Should resolve even on handler errors — errors should
 * be caught inside the dispatch function and logged, not re-thrown.
 */
export type DispatchFn = (
  writer: AnalyticsWriter,
  payload: Record<string, unknown>,
) => Promise<void>;

// ---------------------------------------------------------------------------
// Low-level helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Read all of stdin to a UTF-8 string. Resolves with "" on an empty stream.
 */
export function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

/**
 * Returns a promise that rejects after `ms` milliseconds with a named
 * timeout error. Use with `Promise.race`.
 */
export function timeoutAfter(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`hook dispatch timed out after ${ms}ms`)), ms),
  );
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Run the full hook-process lifecycle:
 *   1. Read stdin.
 *   2. JSON-parse (log byte length + error position on failure, not raw content).
 *   3. Validate that the payload has a `hook_event_name` field.
 *   4. Open an AnalyticsWriter.
 *   5. Race dispatch against a timeout.
 *   6. Close the writer (always, in finally).
 *
 * Always resolves — never throws. The caller can unconditionally `process.exit(0)`.
 *
 * @param opts.harnessName   - Writer harness name, used for AnalyticsWriter.open
 *                             and as the log prefix.
 * @param opts.dispatch      - Hook-specific dispatch function (the switch statement).
 * @param opts.timeoutMs     - Hard deadline for dispatch + writer ops (default: 3000).
 */
export async function runHookProcess(opts: {
  harnessName: string;
  dispatch: DispatchFn;
  timeoutMs?: number;
}): Promise<void> {
  const { harnessName, dispatch, timeoutMs = 3_000 } = opts;
  const tag = `[${harnessName}-writer]`;

  // ── 1. Read stdin ──────────────────────────────────────────────────────────
  let raw: string;
  try {
    raw = await readStdin();
  } catch (err) {
    console.warn(`${tag} failed to read stdin:`, err);
    return;
  }

  if (raw.trim() === "") {
    console.warn(`${tag} empty stdin — nothing to process`);
    return;
  }

  // ── 2. Parse JSON ──────────────────────────────────────────────────────────
  // Log byte length + error position — never the raw payload (m5: prevents
  // echoing user prompt text to stderr/logs).
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (err: unknown) {
    const byteLen = Buffer.byteLength(raw, "utf8");
    const errMsg = err instanceof SyntaxError ? err.message : String(err);
    console.warn(
      `${tag} invalid JSON on stdin (${byteLen} bytes): ${errMsg}`,
    );
    return;
  }

  // ── 3. Validate minimal shape ──────────────────────────────────────────────
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("hook_event_name" in payload)
  ) {
    console.warn(`${tag} payload missing hook_event_name — ignoring`);
    return;
  }

  // ── 4. Open AnalyticsWriter ────────────────────────────────────────────────
  let writer: AnalyticsWriter;
  try {
    writer = await AnalyticsWriter.open({
      harnessName,
      // Hot-path hook: opt out of full-directory spool drain. Each hook
      // invocation is short-lived — full-directory drain on every event
      // would cause high latency when a large backlog exists. The daemon
      // owns full-directory drain; on close() the writer still drains its
      // own just-rotated file.
      drain: {},
    });
  } catch (err) {
    console.warn(`${tag} failed to open AnalyticsWriter:`, err);
    return;
  }

  // ── 5. Dispatch with timeout, then close ──────────────────────────────────
  try {
    await Promise.race([
      dispatch(writer, payload as Record<string, unknown>),
      timeoutAfter(timeoutMs),
    ]);
  } catch (err) {
    console.warn(`${tag}`, err);
  } finally {
    // Always close: rotates the active spool file so the drain daemon can
    // pick it up. Errors here are best-effort only.
    try {
      await writer.close();
    } catch (closeErr) {
      console.warn(`${tag} error closing writer:`, closeErr);
    }
  }
}
