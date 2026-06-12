/**
 * Spool ingestion utilities for the ToTally central store.
 *
 * `ingestFile` and `ingestDir` are the programmatic entry points for draining
 * closed spool files into the central database. They are used by the CLI
 * (`token-tally ingest`) and by the drain daemon (T6).
 *
 * Drain semantics:
 *   - Active spool files (`*.ndjson`)  — NEVER touched; a live writer may
 *     hold them open.
 *   - Closed spool files (`*.ndjson.closed`) — parsed and committed in a
 *     single transaction per file, then deleted on success.
 *
 * Neither function scans the default spool directory as a side effect.
 * Callers opt in to directory drain by using `ingestDir` or by passing a
 * directory path to the CLI. Hot-path callers (CLI `record`, harness hooks)
 * should not call either function — they rely on the daemon for background
 * persistence.
 *
 * Ingestion now uses `writer.drainRecords()` — the same canonical drain engine
 * used by the writer-internal drain paths. This ensures T10 legacy cross-file
 * spool-ID repair is applied uniformly: the same `.closed` file produces the
 * same result regardless of which code path drains it.
 */

import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { defaultFailedDir, quarantineSpoolFile } from "./spool";
import type { BoundedDrainOptions, SpoolRecord } from "./spool";
import { AnalyticsWriter } from "./writer";
import type { WriterOptions } from "./types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options accepted by the ingest functions.
 *
 * Extends `WriterOptions` with optional drain bounds. The bounds apply to
 * directory drain passes (`ingestDir`). Single-file ingest (`ingestFile`)
 * ignores bounds because it processes exactly one file by definition.
 */
export type IngestOptions = WriterOptions & BoundedDrainOptions;

/** Result of ingesting a single file or a directory of spool files. */
export type IngestResult = {
  /** Number of spool files successfully ingested and deleted. */
  ingested: number;
  /** Number of active spool files skipped because they are still open (*.ndjson). */
  skipped: number;
  /**
   * Number of closed spool files that were present but not attempted because
   * a `maxFiles` or `maxMs` bound was hit. These files remain on disk for the
   * next drain pass (daemon or manual ingest).
   */
  skippedByBound: number;
  /**
   * Number of files that failed ingest and were moved to the quarantine
   * directory with a `.failed.json` metadata file. These files will NOT be
   * retried from the active spool directory (they are out of the spool dir).
   * Non-zero means data was not persisted; see the quarantine dir for details.
   */
  quarantined: number;
  /**
   * Files that failed ingest AND could not be quarantined (still in the spool
   * directory). An empty array with `quarantined > 0` means all failures were
   * handled cleanly. Non-empty means files are stuck in the spool dir and
   * need manual intervention.
   */
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
 *     first (safe only when the caller is certain the writer process is dead,
 *     e.g. after `token-tally ingest <path>` targeting a dead writer's file).
 *
 * This function does NOT scan or drain the default spool directory as a side
 * effect. It opens a writer for the DB connection, processes the single
 * specified file, and closes the writer. All idempotency and FK rules apply
 * via the writer's INSERT … ON CONFLICT semantics.
 *
 * Bounds (`maxFiles`, `maxMs`) in `options` are accepted but ignored for
 * single-file ingest — exactly one file is always processed.
 */
export async function ingestFile(
  filePath: string,
  options?: IngestOptions
): Promise<IngestResult> {
  if (!existsSync(filePath)) {
    return {
      ingested: 0,
      skipped: 0,
      skippedByBound: 0,
      quarantined: 0,
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
        skippedByBound: 0,
        quarantined: 0,
        errors: [
          {
            file: filePath,
            message: `Cannot promote active spool file to .closed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  }

  // Open a writer for the DB connection. No drain options are set so the
  // writer will not scan the default spool directory during open or close.
  // We handle exactly the one file ourselves below.
  const writer = await AnalyticsWriter.open({
    dbPath: options?.dbPath,
    harnessName: options?.harnessName ?? "token-tally-ingest",
    spoolDir: options?.spoolDir,
    // Explicitly no full-directory drain — this function processes one file.
  });

  // Abort early if the DB is not writable. Proceeding in spool-only mode would
  // silently re-spool the file's records into a new spool file, delete the
  // source, and report success while zero rows actually reach SQLite.
  if (!writer.status.writable) {
    const reason = writer.status.reason;
    await writer.close();
    return {
      ingested: 0,
      skipped: 0,
      skippedByBound: 0,
      quarantined: 0,
      errors: [{
        file: targetPath,
        message: `Database is not writable${
          reason != null ? `: ${reason}` : ""
        }. Ingest aborted; file left in place.`,
      }],
    };
  }

  const errors: Array<{ file: string; message: string }> = [];
  let ingested = 0;
  let quarantined = 0;

  try {
    const lines = readFileSync(targetPath, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "");
    const records = lines.map((line) => JSON.parse(line) as SpoolRecord);
    // Use the canonical drain engine — same path as writer-internal drain.
    // T10 legacy cross-file spool-ID repair is applied here.
    writer.drainRecords(records);
    unlinkSync(targetPath);
    ingested = 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Attempt to quarantine so the file is not retried on future ingest passes.
    // Only quarantine .ndjson.closed files (not explicitly-promoted active files
    // that the caller wanted to ingest in-place).
    const resolvedFailedDir: string | null =
      options?.failedDir !== undefined
        ? options.failedDir
        : defaultFailedDir(dirname(targetPath));

    if (resolvedFailedDir != null) {
      // Try to get the first record for quarantine metadata.
      let firstRecord: unknown = null;
      try {
        const rawLines = readFileSync(targetPath, "utf8").split("\n").filter(l => l.trim() !== "");
        if (rawLines.length > 0) firstRecord = JSON.parse(rawLines[0]!);
      } catch { /* parsing failed, firstRecord stays null */ }

      const quarantinePath = quarantineSpoolFile(targetPath, resolvedFailedDir, message, firstRecord);
      if (quarantinePath != null) {
        quarantined++;
        errors.push({
          file: targetPath,
          message: `${message} (quarantined to ${quarantinePath})`,
        });
      } else {
        // Quarantine itself failed — file stays where it is.
        errors.push({
          file: targetPath,
          message: `${message} (quarantine failed — file left in place)`,
        });
      }
    } else {
      // Quarantine disabled (options.failedDir === null).
      errors.push({ file: targetPath, message });
    }
  }

  await writer.close();

  return { ingested, skipped: 0, skippedByBound: 0, quarantined, errors };
}

/**
 * Ingests all `*.ndjson.closed` files in `dir` into the central store.
 * Active `*.ndjson` files are skipped — they may be held open by live writers.
 *
 * Callers control how many files or how much wall time to budget via
 * `options.maxFiles` and `options.maxMs`. Files skipped due to a bound remain
 * on disk for the next drain pass. Omit both to drain all closed files.
 *
 * This function is explicit — it does NOT drain the default spool directory
 * unless `dir` is omitted, and it never scans unrelated directories.
 *
 * ## T10 legacy repair
 *
 * Each file is processed via `writer.drainRecords()`, which uses the canonical
 * `drainBatch` engine from `drain-engine.ts`. This includes T10 legacy
 * synthetic spool-ID repair and ensures cross-file `spool:*` IDs are resolved
 * (or quarantined with a clear error) rather than failing with an FK constraint.
 */
export async function ingestDir(
  dir?: string,
  options?: IngestOptions
): Promise<IngestResult> {
  const { defaultSpoolDir } = await import("./paths");
  const targetDir = dir ?? defaultSpoolDir();

  if (!existsSync(targetDir)) {
    return { ingested: 0, skipped: 0, skippedByBound: 0, quarantined: 0, errors: [] };
  }

  const allFiles = readdirSync(targetDir);
  const activeFiles = allFiles.filter(
    (f) => f.endsWith(".ndjson") && !f.endsWith(".ndjson.closed")
  );
  const closedFiles = allFiles.filter((f) => f.endsWith(".ndjson.closed"));

  if (closedFiles.length === 0) {
    return { ingested: 0, skipped: activeFiles.length, skippedByBound: 0, quarantined: 0, errors: [] };
  }

  const resolvedFailedDir: string | null =
    options?.failedDir !== undefined
      ? options.failedDir
      : defaultFailedDir(targetDir);

  // Evaluate bounds. Infinity makes bound checks uniform without conditionals.
  const maxFiles = options?.maxFiles ?? Infinity;
  const deadline = options?.maxMs != null ? Date.now() + options.maxMs : Infinity;

  // Open the writer ONCE for the whole batch — one DB open/close per ingestDir
  // call regardless of file count. No drain-on-open: we process files manually
  // using writer.drainRecords() so T10 legacy repair applies to every file.
  const writer = await AnalyticsWriter.open({
    dbPath: options?.dbPath,
    harnessName: options?.harnessName ?? "token-tally-ingest",
    spoolDir: targetDir,
    // Explicit no-drain: this writer is opened solely for its DB connection.
    // We handle drain manually below.
  });

  // Abort early if the DB is not writable. Proceeding in spool-only mode would
  // re-spool every closed file into a new spool file, delete the originals,
  // and report success while zero rows actually reach SQLite.
  if (!writer.status.writable) {
    const reason = writer.status.reason;
    await writer.close();
    return {
      ingested: 0,
      skipped: activeFiles.length,
      skippedByBound: closedFiles.length,
      quarantined: 0,
      errors: [{
        file: targetDir,
        message: `Database is not writable${
          reason != null ? `: ${reason}` : ""
        }. Ingest aborted; all closed files left in place.`,
      }],
    };
  }

  let ingested = 0;
  let quarantined = 0;
  let skippedByBound = 0;
  const errors: Array<{ file: string; message: string }> = [];
  let processed = 0;

  for (const filename of closedFiles) {
    // Check both bounds before attempting the next file.
    if (processed >= maxFiles || Date.now() > deadline) {
      skippedByBound++;
      continue;
    }
    processed++;

    const filePath = join(targetDir, filename);
    let drainError: string | null = null;
    let firstRecord: unknown = null;

    try {
      const lines = readFileSync(filePath, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "");
      const records = lines.map((line) => JSON.parse(line) as SpoolRecord);
      // Capture first record for quarantine metadata even if drain fails.
      firstRecord = records[0] ?? null;
      // Use the canonical drain engine — same path as writer-internal drain.
      writer.drainRecords(records);
      unlinkSync(filePath);
      ingested++;
    } catch (err) {
      drainError = err instanceof Error ? err.message : String(err);
    }

    if (drainError != null) {
      if (resolvedFailedDir != null) {
        const quarantinePath = quarantineSpoolFile(
          filePath,
          resolvedFailedDir,
          drainError,
          firstRecord,
        );
        if (quarantinePath != null) {
          quarantined++;
          errors.push({
            file: filePath,
            message: `${drainError} (quarantined to ${quarantinePath})`,
          });
        } else {
          // Quarantine itself failed — file left in spool dir.
          errors.push({
            file: filePath,
            message: `${drainError} (quarantine failed — file left in spool directory)`,
          });
        }
      } else {
        // Quarantine disabled (failedDir: null) — leave file in place.
        errors.push({ file: filePath, message: drainError });
      }
    }
  }

  await writer.close();

  return { ingested, skipped: activeFiles.length, skippedByBound, quarantined, errors };
}
