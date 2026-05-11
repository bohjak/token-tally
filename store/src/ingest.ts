/**
 * Spool ingestion utilities for the ToTally central store.
 *
 * `ingestFile` and `ingestDir` are the programmatic entry points used by both
 * the CLI (`token-tally ingest`) and `AnalyticsWriter.close()` during its
 * drain pass.
 *
 * The drain semantics follow PLAN.md:
 *   - Active spool files (`*.ndjson`)  — NEVER touched; a live writer may
 *     hold them open.
 *   - Closed spool files (`*.ndjson.closed`) — parsed and committed in a
 *     single SQLite transaction per file, then deleted on success.
 *
 * Ingestion writes through `AnalyticsWriter` so all idempotency, FK, and
 * schema-version rules are enforced automatically. There is no path that
 * bypasses the writer's INSERT … ON CONFLICT semantics.
 */

import { existsSync, readdirSync, renameSync } from "fs";
import { join } from "path";
import type { SpoolRecord } from "./spool";
import { AnalyticsWriter } from "./writer";
import type { WriterOptions } from "./types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Options accepted by the ingest functions. */
export type IngestOptions = WriterOptions;

/** Result of ingesting a single file or a directory of spool files. */
export type IngestResult = {
  /** Number of spool files successfully ingested and deleted. */
  ingested: number;
  /** Number of spool files skipped because they are still active (*.ndjson). */
  skipped: number;
  /** Errors for files that could not be fully ingested. */
  errors: Array<{ file: string; message: string }>;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ingests a single NDJSON file into the central store.
 *
 * The file may be either:
 *   - A `*.ndjson.closed` file — ingested directly.
 *   - A `*.ndjson` (active) file supplied explicitly — promoted to `.closed`
 *     first (safe to do only when the caller is certain the writer process is
 *     dead, e.g. after `token-tally ingest <path>` with a dead PID).
 *
 * This function opens a fresh `AnalyticsWriter` for the DB specified in
 * `options` (or the default DB path if omitted), drains the single file, and
 * closes the writer. Using the writer ensures all idempotency and FK rules
 * apply to every record in the file.
 */
export async function ingestFile(
  filePath: string,
  options?: IngestOptions
): Promise<IngestResult> {
  if (!existsSync(filePath)) {
    return {
      ingested: 0,
      skipped: 0,
      errors: [{ file: filePath, message: "File not found." }],
    };
  }

  // If the file is an active spool file, promote it to .closed before
  // draining. The caller is responsible for confirming the writer is dead.
  let targetPath = filePath;
  if (filePath.endsWith(".ndjson") && !filePath.endsWith(".ndjson.closed")) {
    const closedPath = filePath.replace(/\.ndjson$/, `-manual-${Date.now()}.ndjson.closed`);
    try {
      renameSync(filePath, closedPath);
      targetPath = closedPath;
    } catch (err) {
      return {
        ingested: 0,
        skipped: 0,
        errors: [
          {
            file: filePath,
            message: `Cannot promote active spool file to .closed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  }

  // Open the writer for a DB-backed connection. We disable automatic spool
  // drain on open (by pointing at an empty spool dir) so writer.open() doesn't
  // drain unrelated files — we only want to drain `targetPath`.
  const writer = await AnalyticsWriter.open(options);

  const errors: Array<{ file: string; message: string }> = [];
  let ingested = 0;

  try {
    const { readFileSync, unlinkSync } = await import("fs");
    const lines = readFileSync(targetPath, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "");
    const records = lines.map((line) => JSON.parse(line) as SpoolRecord);
    await applyRecordsToWriter(writer, records);
    unlinkSync(targetPath);
    ingested = 1;
  } catch (err) {
    errors.push({
      file: targetPath,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  await writer.close();

  return { ingested, skipped: 0, errors };
}

/**
 * Ingests all `*.ndjson.closed` files in `spoolDir` (or the default spool
 * directory if omitted) into the central store. Active files are skipped.
 *
 * This is the same drain pass that `AnalyticsWriter.close()` performs on
 * clean shutdown; calling it manually is useful after a crashed writer left
 * files that could not auto-drain.
 */
export async function ingestDir(
  spoolDir?: string,
  options?: IngestOptions
): Promise<IngestResult> {
  const { defaultSpoolDir } = await import("./paths");
  const dir = spoolDir ?? defaultSpoolDir();

  if (!existsSync(dir)) {
    return { ingested: 0, skipped: 0, errors: [] };
  }

  // Count active (non-closed) files so the caller can report them as skipped.
  const allFiles = readdirSync(dir);
  const activeFiles = allFiles.filter(
    (f) => f.endsWith(".ndjson") && !f.endsWith(".ndjson.closed")
  );

  const writer = await AnalyticsWriter.open({ ...options, spoolDir: dir });

  // drainClosedSpoolFiles is called by writer.close() via runSpoolDrain.
  // We call writer.flush() first so any pending spool is rotated, then close.
  await writer.flush();
  await writer.close();

  // Re-read to count what's left (drain errors leave files on disk).
  const remaining = readdirSync(dir).filter((f) =>
    f.endsWith(".ndjson.closed")
  );

  const drained = allFiles.filter((f) => f.endsWith(".ndjson.closed")).length - remaining.length;

  return {
    ingested: Math.max(0, drained),
    skipped: activeFiles.length,
    errors: remaining.map((f) => ({
      file: join(dir, f),
      message: "File could not be drained (check for JSON errors or DB issues).",
    })),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Applies a batch of SpoolRecords to a live AnalyticsWriter.
 *
 * Records are applied in order. All writes use the writer's idempotent upsert
 * semantics so replaying the same records is always safe. Errors propagate to
 * the caller so the drain loop can mark the file as failed.
 */
async function applyRecordsToWriter(
  writer: AnalyticsWriter,
  records: SpoolRecord[]
): Promise<void> {
  // Session/turn/subscription IDs that come out of spool mode are synthetic
  // placeholders (prefix "spool:"). Map them to real DB IDs as we process
  // parent rows first.
  const sessionIds = new Map<string, string>();
  const turnIds = new Map<string, string>();
  const subscriptionIds = new Map<string, string>();

  for (const record of records) {
    switch (record.type) {
      case "harness":
        await writer.recordHarness(record.payload);
        break;

      case "session": {
        const result = await writer.recordSession(record.payload);
        // Map the spool placeholder to the real UUID.
        const spoolKey = `spool:${record.payload.harnessId}:${record.payload.harnessSessionId}`;
        sessionIds.set(spoolKey, result.id);
        break;
      }

      case "turn": {
        const payload = {
          ...record.payload,
          sessionId: sessionIds.get(record.payload.sessionId) ?? record.payload.sessionId,
        };
        const result = await writer.recordTurn(payload);
        const spoolKey = `spool:${record.payload.sessionId}:${record.payload.harnessTurnId}`;
        turnIds.set(spoolKey, result.id);
        break;
      }

      case "llm-message":
        await writer.recordLlmMessage({
          ...record.payload,
          sessionId: sessionIds.get(record.payload.sessionId) ?? record.payload.sessionId,
          turnId: record.payload.turnId != null
            ? (turnIds.get(record.payload.turnId) ?? record.payload.turnId)
            : undefined,
          subscriptionId: record.payload.subscriptionId != null
            ? (subscriptionIds.get(record.payload.subscriptionId) ?? record.payload.subscriptionId)
            : undefined,
        });
        break;

      case "subscription": {
        const result = await writer.recordSubscription(record.payload);
        const spoolKey = `spool:${record.payload.harnessId}:${record.payload.planName}:${record.payload.periodStart}`;
        subscriptionIds.set(spoolKey, result.id);
        break;
      }

      case "tool-call":
        await writer.recordToolCall({
          ...record.payload,
          sessionId: sessionIds.get(record.payload.sessionId) ?? record.payload.sessionId,
          turnId: record.payload.turnId != null
            ? (turnIds.get(record.payload.turnId) ?? record.payload.turnId)
            : undefined,
        });
        break;

      case "raw-event":
        await writer.recordRawEvent(record.payload);
        break;
    }
  }
}
