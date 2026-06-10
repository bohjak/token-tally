/**
 * cli-writer.ts — Pi spool writer for ToTally.
 *
 * Appends analytics records to a single local NDJSON spool file per Pi
 * process instead of spawning a `token-tally record` subprocess per event.
 *
 * ## Why spool instead of subprocess
 *
 * The old approach spawned the 137 MB SEA binary on every hot-path event
 * (turn_start, turn_end, message_end, tool_execution_end). Each spawn took
 * 5-14 s when a large spool backlog was present because the store writer
 * attempted to drain the full spool directory on open/close. That blocked
 * Pi turns visibly and caused high CPU from repeated SQLite drain attempts.
 *
 * ## This writer
 *
 * - Appends lifecycle-ordered NDJSON records to one file per Pi process.
 *   Ordering: harness/session records first, then turns, then child records
 *   (LLM messages, tool calls). Pi fires events in this order naturally, so
 *   the file ordering is preserved by the serial write queue.
 * - Returns synthetic spool IDs immediately (no DB round-trip in hot path).
 * - Uses an async serial write queue: callers fire-and-forget; writes never
 *   block Pi turns or message handlers.
 * - Rotates the active file to `.ndjson.closed` on session_shutdown so the
 *   drain daemon can pick it up.
 * - Does NOT import better-sqlite3 or any store DB code — only type imports.
 *
 * ## Synthetic ID scheme  (store-compatible)
 *
 * The drain daemon resolves these IDs using the ordered records in the same
 * file. Parent records always appear before children, so the daemon can build
 * an in-file map from synthetic ID → real UUID as it processes each record.
 *
 *   session:      spool:${harnessId}:${harnessSessionId}
 *   turn:         spool:${sessionId}:${harnessTurnId}
 *   llm-message:  spool:${harnessId}:${harnessMessageId}
 *   tool-call:    spool:${harnessId}:${harnessToolCallId}
 *
 * ## File naming
 *
 *   Active:   pi-<pid>-<open-ts>.ndjson
 *   Closed:   pi-<pid>-<open-ts>-<close-ts>.ndjson.closed
 *
 * The PID in the name lets the drain daemon detect dead owner processes and
 * safely promote stale active files to `.closed` (see T6).
 */

import { appendFile, rename, stat, unlink } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type {
  HarnessPayload,
  LlmMessagePayload,
  RawEventPayload,
  SessionPayload,
  SubscriptionPayload,
  ToolCallPayload,
  TurnPayload,
} from "@token-tally/store";
import type { SpoolRecord } from "@token-tally/store";

// ---------------------------------------------------------------------------
// Public writer surface used by hook modules
// ---------------------------------------------------------------------------

export type WriteResult = { id: string };

export type AnalyticsWriterLike = {
  recordHarness(payload: HarnessPayload): Promise<WriteResult>;
  recordSession(payload: SessionPayload): Promise<WriteResult>;
  recordTurn(payload: TurnPayload): Promise<WriteResult>;
  recordLlmMessage(payload: LlmMessagePayload): Promise<WriteResult>;
  recordSubscription(payload: SubscriptionPayload): Promise<WriteResult>;
  recordToolCall(payload: ToolCallPayload): Promise<WriteResult>;
  recordRawEvent(payload: RawEventPayload): Promise<void>;
  close(): Promise<void>;
};

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const APP_DIR_NAME = "token-tally";

function defaultDataDir(): string {
  const xdgDataHome = process.env.XDG_DATA_HOME;
  const base =
    xdgDataHome != null && xdgDataHome !== ""
      ? xdgDataHome
      : join(homedir(), ".local", "share");
  return join(base, APP_DIR_NAME);
}

function defaultSpoolDir(): string {
  return join(defaultDataDir(), "spool");
}

// ---------------------------------------------------------------------------
// SpoolBasedWriter
// ---------------------------------------------------------------------------

class SpoolBasedWriter implements AnalyticsWriterLike {
  private readonly spoolDir: string;
  private readonly activeFilePath: string;

  /**
   * Serial write queue: each enqueue() chains onto the previous promise so
   * records are appended in the order they are enqueued with no concurrent
   * filesystem operations on the same file.
   */
  private writeQueue: Promise<void> = Promise.resolve();

  /**
   * Set to true immediately when close() is called so that any late enqueue()
   * calls (e.g. from async git capture resolving after session_shutdown) are
   * silently dropped rather than writing to an already-closed or rotated file.
   */
  private closed = false;

  /**
   * Error throttle: only log the first disk failure to avoid flooding Pi
   * logs when the spool directory is persistently unavailable.
   */
  private errorLogged = false;

  constructor(spoolDir: string, activeFilePath: string) {
    this.spoolDir = spoolDir;
    this.activeFilePath = activeFilePath;
  }

  // ── record methods — return synthetic IDs immediately ────────────────────

  recordHarness(payload: HarnessPayload): Promise<WriteResult> {
    this.enqueue({ type: "harness", payload });
    // Harness rows are keyed by name — no synthetic spool prefix needed.
    return Promise.resolve({ id: payload.name });
  }

  recordSession(payload: SessionPayload): Promise<WriteResult> {
    this.enqueue({ type: "session", payload });
    return Promise.resolve({
      id: `spool:${payload.harnessId}:${payload.harnessSessionId}`,
    });
  }

  recordTurn(payload: TurnPayload): Promise<WriteResult> {
    this.enqueue({ type: "turn", payload });
    // payload.sessionId is itself a synthetic spool ID. Embedding it in the
    // turn key lets the drain daemon compute the same key from the record.
    return Promise.resolve({
      id: `spool:${payload.sessionId}:${payload.harnessTurnId}`,
    });
  }

  recordLlmMessage(payload: LlmMessagePayload): Promise<WriteResult> {
    this.enqueue({ type: "llm-message", payload });
    return Promise.resolve({
      id: `spool:${payload.harnessId}:${payload.harnessMessageId}`,
    });
  }

  recordSubscription(payload: SubscriptionPayload): Promise<WriteResult> {
    this.enqueue({ type: "subscription", payload });
    return Promise.resolve({
      id: `spool:${payload.harnessId}:${payload.planName}:${payload.periodStart}`,
    });
  }

  recordToolCall(payload: ToolCallPayload): Promise<WriteResult> {
    this.enqueue({ type: "tool-call", payload });
    return Promise.resolve({
      id: `spool:${payload.harnessId}:${payload.harnessToolCallId}`,
    });
  }

  recordRawEvent(payload: RawEventPayload): Promise<void> {
    this.enqueue({ type: "raw-event", payload });
    return Promise.resolve();
  }

  // ── close — flush queue then rotate ──────────────────────────────────────

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();

    // Block new enqueues immediately, before the async flush completes, so
    // late callers (e.g. async git capture) are dropped cleanly.
    this.closed = true;

    return this.writeQueue
      .then(() => this.rotate())
      .catch((err: unknown) => {
        console.warn("[pi-writer:spool] error flushing queue before close:", err);
        return this.rotate();
      });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private enqueue(record: SpoolRecord): void {
    if (this.closed) {
      // Silently drop writes after close(). This is expected for async git
      // captures that resolve after session_shutdown — the metadata is
      // best-effort and acceptable to lose on session end.
      return;
    }

    // Chain onto the serial write queue. A failed write is caught and logged
    // once so that one bad record does not block subsequent records.
    this.writeQueue = this.writeQueue
      .then(() =>
        appendFile(
          this.activeFilePath,
          JSON.stringify(record) + "\n",
          "utf8",
        ),
      )
      .catch((err: unknown) => {
        if (!this.errorLogged) {
          console.warn(
            "[pi-writer:spool] write error (further errors suppressed):",
            err,
          );
          this.errorLogged = true;
        }
      });
  }

  private async rotate(): Promise<void> {
    if (!existsSync(this.activeFilePath)) {
      // Nothing was written during this session — no file to rotate.
      return;
    }

    try {
      const stats = await stat(this.activeFilePath);
      if (stats.size === 0) {
        // Empty file: clean up without leaving a zero-byte closed file.
        await unlink(this.activeFilePath);
        return;
      }

      const ts = Date.now();
      const activeName = basename(this.activeFilePath);
      // Active:   pi-<pid>-<open-ts>.ndjson
      // Closed:   pi-<pid>-<open-ts>-<close-ts>.ndjson.closed
      const closedName = activeName.replace(/\.ndjson$/, `-${ts}.ndjson.closed`);
      await rename(this.activeFilePath, join(this.spoolDir, closedName));
    } catch (err: unknown) {
      console.warn("[pi-writer:spool] rotate error:", err);
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a SpoolBasedWriter that appends records to the default spool
 * directory. The active file uses a PID-bearing name so the drain daemon (T6)
 * can detect dead owner processes and promote stale active files.
 */
export function createCliAnalyticsWriter(): AnalyticsWriterLike {
  const spoolDir = defaultSpoolDir();
  try {
    mkdirSync(spoolDir, { recursive: true });
  } catch (err: unknown) {
    // Non-fatal — the writer will fail on the first appendFile and log once.
    console.warn("[pi-writer:spool] could not create spool directory:", err);
  }
  const ts = Date.now();
  const activeFilePath = join(spoolDir, `pi-${process.pid}-${ts}.ndjson`);
  return new SpoolBasedWriter(spoolDir, activeFilePath);
}
