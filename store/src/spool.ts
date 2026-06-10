/**
 * NDJSON spool: write-ahead fallback for when the SQLite DB is unavailable.
 *
 * When a writer cannot reach the database (busy, locked, schema too new, or
 * unreachable), it appends events to a local NDJSON file instead. A drain
 * pass on the next successful DB open replays those events.
 *
 * FILE NAMING
 *   Active (this process is writing):  <harness>-<pid>.ndjson
 *   Closed (safe to drain and delete): <harness>-<pid>-<ts>.ndjson.closed
 *
 * ROTATION TRIGGERS (PLAN.md spec)
 *   Size ≥ 4 MiB
 *   Age  ≥ 1 hour
 *   Clean shutdown (writer.close())
 *
 * DRAIN RULE
 *   Drain code must NEVER touch active files (*.ndjson). Only *.ndjson.closed
 *   files are safe to read and delete, because active files may still be held
 *   open by a live writer process.
 *
 * DATA MINIMIZATION
 *   The spool mirrors the same privacy contract as the structured tables —
 *   no prompts, tool I/O, file contents, or secrets.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { basename, join } from "path";
import type {
  HarnessPayload,
  LlmMessagePayload,
  RawEventPayload,
  SessionPayload,
  SubscriptionPayload,
  ToolCallPayload,
  TurnPayload,
} from "./types";

// ---------------------------------------------------------------------------
// Spool record format
// ---------------------------------------------------------------------------

/**
 * A tagged spool record. Each record is stored as a single JSON line
 * (NDJSON format). The `type` field determines which writer method is called
 * when the record is drained back into the database.
 */
export type SpoolRecord =
  | { type: "harness"; payload: HarnessPayload }
  | { type: "session"; payload: SessionPayload }
  | { type: "turn"; payload: TurnPayload }
  | { type: "llm-message"; payload: LlmMessagePayload }
  | { type: "subscription"; payload: SubscriptionPayload }
  | { type: "tool-call"; payload: ToolCallPayload }
  | { type: "raw-event"; payload: RawEventPayload };

// ---------------------------------------------------------------------------
// Rotation thresholds (from PLAN.md)
// ---------------------------------------------------------------------------

const SPOOL_MAX_BYTES = 4 * 1024 * 1024; // 4 MiB
const SPOOL_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

// ---------------------------------------------------------------------------
// SpoolWriter
// ---------------------------------------------------------------------------

/**
 * Writes events to an NDJSON spool file when the database is unavailable.
 *
 * Rotate the file (move to .closed) by calling `rotate()`. This happens
 * automatically on size/age limits and must be called explicitly on shutdown.
 */
export class SpoolWriter {
  private readonly spoolDir: string;
  private readonly activeFilePath: string;
  // Tracks when the current active file was first written to, for age-based
  // rotation. Refreshed on each rotation.
  private openedAt: number;

  constructor(spoolDir: string, harnessName: string) {
    this.spoolDir = spoolDir;
    mkdirSync(spoolDir, { recursive: true });
    // Active file is named for this process so concurrent writer processes
    // don't write to the same file.
    this.activeFilePath = join(
      spoolDir,
      `${harnessName}-${process.pid}.ndjson`
    );
    this.openedAt = Date.now();
  }

  /**
   * Appends a record to the active spool file as a single JSON line.
   * Rotates the file first if it has exceeded the size or age limit.
   */
  write(record: SpoolRecord): void {
    this.rotateIfNeeded();
    appendFileSync(
      this.activeFilePath,
      JSON.stringify(record) + "\n",
      "utf8"
    );
  }

  /**
   * Renames the active spool file to a `.ndjson.closed` name so it can be
   * safely drained on the next successful DB open.
   *
   * Returns the path of the closed file on success, or `null` when there is
   * nothing to rotate (file absent or empty). Callers that want to drain only
   * this writer's own file (not the whole directory) can pass the returned
   * path to `drainSingleSpoolFile`.
   */
  rotate(): string | null {
    if (!existsSync(this.activeFilePath)) {
      return null;
    }

    const stats = statSync(this.activeFilePath);
    if (stats.size === 0) {
      // Nothing was written; clean up rather than leave an empty closed file.
      unlinkSync(this.activeFilePath);
      this.openedAt = Date.now();
      return null;
    }

    const ts = Date.now();
    // Active filename:  pi-1234.ndjson
    // Closed filename:  pi-1234-<ts>.ndjson.closed
    const activeName = basename(this.activeFilePath);
    const closedName = activeName.replace(/\.ndjson$/, `-${ts}.ndjson.closed`);
    const closedPath = join(this.spoolDir, closedName);
    renameSync(this.activeFilePath, closedPath);
    this.openedAt = Date.now();
    return closedPath;
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.activeFilePath)) {
      // File doesn't exist yet; track from now so age is measured from first write.
      this.openedAt = Date.now();
      return;
    }

    const stats = statSync(this.activeFilePath);
    const ageMs = Date.now() - this.openedAt;

    if (stats.size >= SPOOL_MAX_BYTES || ageMs >= SPOOL_MAX_AGE_MS) {
      this.rotate();
    }
  }
}

// ---------------------------------------------------------------------------
// Quarantine support (T8)
// ---------------------------------------------------------------------------

/**
 * Diagnostic metadata written alongside a quarantined spool file.
 *
 * The metadata file lives next to the quarantined spool file with the
 * additional `.failed.json` suffix, e.g.:
 *   `spool.failed/pi-1234-ts.ndjson.closed.failed.json`
 *
 * This file is preserved for T10/T11 repair analysis and T11 backlog recovery.
 */
export type QuarantineMetadata = {
  /** Schema version for forward compatibility. Always 1. */
  version: 1;
  /** Absolute path of the file before it was quarantined. */
  originalPath: string;
  /** ISO 8601 timestamp when quarantine happened. */
  quarantinedAt: string;
  /**
   * The actual underlying error — JSON parse failure, SQLite FK violation,
   * constraint error, etc. This replaces the previous generic
   * "File could not be drained" message.
   */
  error: string;
  /**
   * The first record from the file after successful JSON parsing, or null
   * when the file could not be parsed at all. Preserved so T10/T11 can
   * inspect the record shape without re-reading the quarantined file.
   */
  firstRecord: unknown | null;
};

/**
 * Returns the default quarantine directory for a given spool directory.
 *
 * Convention: if spool is `/path/to/spool`, the failed dir is
 * `/path/to/spool.failed`. This keeps the failed files adjacent to the
 * active spool without cluttering the spool directory itself.
 */
export function defaultFailedDir(spoolDir: string): string {
  return spoolDir + '.failed';
}

/**
 * Moves a failed spool file to `failedDir` and writes a `.failed.json`
 * metadata file alongside it. Returns the quarantine path on success, or
 * null when the quarantine itself fails (disk full, permission error, etc.).
 *
 * On quarantine failure the original file is left in the spool directory so
 * no data is lost; the caller should include this in its error output.
 *
 * @param filePath    Absolute path of the failed file to quarantine.
 * @param failedDir   Destination directory for quarantined files.
 * @param error       Human-readable description of the ingest failure.
 * @param firstRecord First parsed record from the file for T10/T11 analysis,
 *   or null when parsing failed entirely.
 */
export function quarantineSpoolFile(
  filePath: string,
  failedDir: string,
  error: string,
  firstRecord: unknown | null,
): string | null {
  try {
    mkdirSync(failedDir, { recursive: true });
    const filename = basename(filePath);
    const destPath = join(failedDir, filename);
    // Atomic rename keeps the file content safe even if metadata write fails.
    renameSync(filePath, destPath);
    const meta: QuarantineMetadata = {
      version: 1,
      originalPath: filePath,
      quarantinedAt: new Date().toISOString(),
      error,
      firstRecord,
    };
    writeFileSync(destPath + '.failed.json', JSON.stringify(meta, null, 2) + '\n', 'utf8');
    return destPath;
  } catch {
    // Quarantine failed — return null so the caller can report the file as
    // stuck in spool rather than silently losing it.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Bounded drain options
// ---------------------------------------------------------------------------

/**
 * Limits applied to a drain pass to prevent unbounded directory scans.
 *
 * Both limits are optional and independent. When a limit is hit the pass stops
 * cleanly; remaining files are left on disk for the next pass (daemon, manual
 * ingest, or a later writer open).
 */
export type BoundedDrainOptions = {
  /**
   * Maximum number of `.ndjson.closed` files to attempt in one pass.
   * Files beyond this limit are left for the next drain run.
   */
  maxFiles?: number;

  /**
   * Maximum wall-clock time in milliseconds for the entire pass.
   * The check happens before each file; an in-progress file always completes.
   */
  maxMs?: number;

  /**
   * Directory to quarantine files that fail ingest. Files are moved here
   * with a `.failed.json` metadata file alongside them so they are never
   * retried from the active spool directory.
   *
   * - `undefined` (default) — derive from the spool dir as `<spoolDir>.failed`.
   * - `string` — use the given path.
   * - `null` — disable quarantine; failed files are left in place (legacy
   *   behavior) and reported in `DrainResult.errors`.
   */
  failedDir?: string | null;
};

// ---------------------------------------------------------------------------
// Drain
// ---------------------------------------------------------------------------

export type DrainResult = {
  /** Number of files successfully drained and deleted. */
  drained: number;
  /**
   * Files that could not be drained AND could not be quarantined (still in
   * the spool directory). An empty array means all failures were quarantined
   * cleanly; `quarantined > 0` tells you failures occurred.
   */
  errors: Array<{ file: string; message: string }>;
  /**
   * Number of files that were present but skipped because a `maxFiles` or
   * `maxMs` bound was reached before they could be attempted.
   */
  skippedByBound: number;
  /**
   * Number of files that failed ingest and were moved to the quarantine
   * directory with a `.failed.json` metadata file. These files will NOT
   * be retried on the next drain pass (they are out of the spool dir).
   */
  quarantined: number;
};

/**
 * Drains a single `*.ndjson.closed` spool file by parsing its records and
 * passing them to `processRecordsFromFile` in one call. On success the file is
 * deleted. On failure the file is left on disk and the error is returned.
 *
 * The caller is responsible for wrapping `processRecordsFromFile` in a
 * transaction so that either all records are committed or none are.
 *
 * `firstRecord` in the failure return is the first parsed record from the file
 * (available when JSON parsing succeeded but the callback threw), or null when
 * JSON parsing itself failed. It is used by `drainClosedSpoolFiles` to populate
 * quarantine metadata for T10/T11 analysis.
 *
 * Useful for draining a specific file (e.g. the writer's own just-rotated
 * file) without scanning the whole spool directory.
 */
export function drainSingleSpoolFile(
  filePath: string,
  processRecordsFromFile: (records: SpoolRecord[]) => void
): { drained: number; error?: { file: string; message: string }; firstRecord?: unknown } {
  let firstRecord: unknown = null;
  try {
    const lines = readFileSync(filePath, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "");
    // Parse all lines upfront so a JSON error surfaces before any DB writes.
    const records = lines.map((line) => JSON.parse(line) as SpoolRecord);
    // Capture the first record after successful parsing so quarantine metadata
    // can include it even when the DB write (callback) fails.
    firstRecord = records[0] ?? null;
    processRecordsFromFile(records);
    // File committed successfully — safe to delete.
    unlinkSync(filePath);
    return { drained: 1 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { drained: 0, error: { file: filePath, message }, firstRecord };
  }
}

/**
 * Drains all `*.ndjson.closed` files in `spoolDir` by passing each file's
 * records to `processRecordsFromFile`.
 *
 * The caller is responsible for wrapping `processRecordsFromFile` in a
 * transaction so that either all records in a file are committed or none are
 * (preserving the "at-least-once within a file" guarantee).
 *
 * ## Failure handling (T8)
 *
 * Files that fail (bad JSON, DB write error) are quarantined by default:
 * moved to `<spoolDir>.failed/` (or `options.failedDir`) and a `.failed.json`
 * metadata file is written alongside them. Quarantined files are counted in
 * `result.quarantined` and are NOT reported in `result.errors`.
 *
 * Pass `options.failedDir = null` to disable quarantine and use legacy
 * behavior — failed files stay in the spool directory and appear in
 * `result.errors`.
 *
 * `result.errors` only contains files that failed AND could NOT be quarantined
 * (i.e. the quarantine itself failed, or quarantine was disabled). An empty
 * `errors` array with `quarantined > 0` means failures were handled cleanly.
 *
 * Active spool files (*.ndjson without .closed) are never touched.
 *
 * Pass `maxFiles`/`maxMs` to bound how many files or how much wall time this
 * pass may consume. Files skipped due to a bound are counted in
 * `result.skippedByBound` and left for the next drain pass.
 */
export function drainClosedSpoolFiles(
  spoolDir: string,
  processRecordsFromFile: (records: SpoolRecord[]) => void,
  options?: BoundedDrainOptions
): DrainResult {
  if (!existsSync(spoolDir)) {
    return { drained: 0, errors: [], skippedByBound: 0, quarantined: 0 };
  }

  // Resolve the quarantine dir. `undefined` → derive from spoolDir (default).
  // `null` → quarantine disabled (legacy: leave failed files in place).
  // `string` → use the given path.
  const failedDir: string | null =
    options?.failedDir !== undefined
      ? options.failedDir   // may be null (disabled) or a custom path
      : defaultFailedDir(spoolDir);  // safe default: adjacent to spool dir

  const closedFiles = readdirSync(spoolDir).filter((f) =>
    f.endsWith(".ndjson.closed")
  );

  // Evaluate bounds once up front. Infinity makes the bound checks uniform
  // without conditional branches in the loop.
  const maxFiles = options?.maxFiles ?? Infinity;
  const deadline = options?.maxMs != null ? Date.now() + options.maxMs : Infinity;

  const errors: Array<{ file: string; message: string }> = [];
  let drained = 0;
  let processed = 0;
  let quarantined = 0;

  for (const entry of closedFiles) {
    // Check both bounds before attempting the next file.
    if (processed >= maxFiles || Date.now() > deadline) break;
    processed++;

    const filePath = join(spoolDir, entry);
    const result = drainSingleSpoolFile(filePath, processRecordsFromFile);

    if (result.error == null) {
      drained++;
      continue;
    }

    // Drain failed. Try to quarantine the file so it is never retried from
    // the active spool directory again.
    if (failedDir != null) {
      const quarantinePath = quarantineSpoolFile(
        filePath,
        failedDir,
        result.error.message,
        result.firstRecord ?? null,
      );
      if (quarantinePath != null) {
        // File is now out of the spool dir — counted separately, NOT in errors.
        quarantined++;
      } else {
        // Quarantine itself failed (disk full, permission error, etc.).
        // File is still in the spool dir — report so the caller is aware.
        errors.push({
          file: filePath,
          message: `${result.error.message} (quarantine failed — file left in spool)`,
        });
      }
    } else {
      // Quarantine disabled (failedDir: null) — leave file in place, legacy behavior.
      errors.push(result.error);
    }
  }

  // Files we never got to (bound was hit before attempting them).
  const skippedByBound = closedFiles.length - processed;

  return { drained, errors, skippedByBound, quarantined };
}

// ---------------------------------------------------------------------------
// Stale active-file promotion (T6 daemon)
// ---------------------------------------------------------------------------

/**
 * An active spool file that was successfully promoted to `.ndjson.closed`.
 */
export type PromotedEntry = {
  /** Absolute path of the original active file (no longer exists). */
  activePath: string;
  /** Absolute path of the new closed file. */
  closedPath: string;
  /** Why promotion was triggered. Currently always 'dead-pid'. */
  reason: 'dead-pid';
};

/**
 * Result of a `promoteStaleActiveFiles` call.
 */
export type PromoteResult = {
  /** Active files successfully renamed to `.ndjson.closed`. */
  promoted: PromotedEntry[];
  /**
   * Active files examined but not promoted, with the reason.
   * These are diagnostic notes, not errors — the files remain safely on disk.
   */
  skipped: Array<{ file: string; reason: string }>;
};

/**
 * Default minimum mtime age (ms) before a dead-PID active file may be
 * promoted. Guards against the PID-reuse race: if a process just exited and
 * another process has not yet been assigned the same PID, its newly created
 * spool file would be much more recent than this threshold.
 */
const DEFAULT_MIN_PROMOTE_AGE_MS = 5 * 60 * 1_000; // 5 minutes

/**
 * Parses the owning process PID from an active spool filename.
 *
 * Recognises two filename conventions:
 *   T3 Pi writer:   `<prefix>-<pid>-<open_ts>.ndjson`  (open_ts ≥ 10 digits)
 *   Store writer:   `<prefix>-<pid>.ndjson`
 *
 * Returns null for any filename that does not match either pattern or where
 * the extracted value is outside the plausible Unix PID range 1–4 194 303.
 * Unrecognised filenames are never promoted.
 */
function parseActivePid(filename: string): number | null {
  if (!filename.endsWith('.ndjson') || filename.endsWith('.ndjson.closed')) {
    return null;
  }
  const base = filename.slice(0, -7); // strip ".ndjson"

  // T3 Pi writer format: <prefix>-<pid>-<open_ts>
  // The open_ts is a Unix epoch millisecond value (at least 10 digits).
  const t3Match = base.match(/^.+-([1-9]\d{0,6})-\d{10,}$/);
  if (t3Match != null) {
    const pid = parseInt(t3Match[1]!, 10);
    if (pid > 0 && pid <= 4_194_303) return pid;
  }

  // Store writer format: <prefix>-<pid>
  const storeMatch = base.match(/^.+-([1-9]\d{0,6})$/);
  if (storeMatch != null) {
    const pid = parseInt(storeMatch[1]!, 10);
    if (pid > 0 && pid <= 4_194_303) return pid;
  }

  return null;
}

/**
 * Returns true when a process with the given PID is running on this machine.
 *
 * Uses `process.kill(pid, 0)`: signal 0 probes process existence without
 * delivering a signal. `ESRCH` means "no such process" (dead). `EPERM` means
 * the process exists but we cannot signal it — treated as alive to err on the
 * side of caution and never steal a live writer's file.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process. Any other error (EPERM) = assume alive.
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Scans `spoolDir` for active NDJSON spool files whose owning process has
 * been confirmed dead, and atomically renames them to `.ndjson.closed` so the
 * daemon drain loop can persist their records to the database.
 *
 * ## Safety policy
 *
 * A file is promoted only when **all** of the following are true:
 *
 * 1. The filename follows a recognised PID-bearing convention
 *    (`<prefix>-<pid>.ndjson` or `<prefix>-<pid>-<open_ts>.ndjson`).
 * 2. `process.kill(pid, 0)` confirms the owning PID is **dead** (ESRCH).
 * 3. The file's mtime is older than `minAgeMs` (default 5 min) as a guard
 *    against PID reuse: a process that just received a recycled PID would have
 *    created any new spool file more recently than this threshold.
 *
 * Files whose PID appears alive are **never** promoted regardless of age.
 * Files with unrecognised filenames are **never** promoted.
 * `renameSync` is atomic on POSIX so the file is never in a half-moved state.
 *
 * @param spoolDir    Directory to scan for active spool files.
 * @param options.minAgeMs  Minimum file mtime age before a dead-PID file may
 *   be promoted. Default: 5 minutes.
 */
export function promoteStaleActiveFiles(
  spoolDir: string,
  options?: { minAgeMs?: number }
): PromoteResult {
  const minAgeMs = options?.minAgeMs ?? DEFAULT_MIN_PROMOTE_AGE_MS;

  if (!existsSync(spoolDir)) {
    return { promoted: [], skipped: [] };
  }

  const activeFiles = readdirSync(spoolDir).filter(
    (f) => f.endsWith('.ndjson') && !f.endsWith('.ndjson.closed')
  );

  const promoted: PromotedEntry[] = [];
  const skipped: Array<{ file: string; reason: string }> = [];

  for (const filename of activeFiles) {
    const filePath = join(spoolDir, filename);

    // Step 1: parse PID from filename — bail out if unrecognised.
    const pid = parseActivePid(filename);
    if (pid === null) {
      skipped.push({
        file: filename,
        reason: 'filename does not follow a recognised PID-bearing convention — skipping for safety',
      });
      continue;
    }

    // Step 2: confirm the owning PID is dead before touching the file.
    if (isProcessAlive(pid)) {
      skipped.push({
        file: filename,
        reason: `PID ${pid} appears alive — will not steal an active writer's file`,
      });
      continue;
    }

    // Step 3: minimum age guard to protect against the PID-reuse race window.
    let ageMs: number;
    try {
      const st = statSync(filePath);
      ageMs = Date.now() - st.mtimeMs;
    } catch (err) {
      skipped.push({
        file: filename,
        reason: `cannot stat: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    if (ageMs < minAgeMs) {
      skipped.push({
        file: filename,
        reason:
          `PID ${pid} dead but file is too recent ` +
          `(age ${Math.round(ageMs / 1_000)}s < minimum ${Math.round(minAgeMs / 1_000)}s) — ` +
          `waiting for next pass`,
      });
      continue;
    }

    // All checks passed — atomically rename to .closed.
    try {
      const ts = Date.now();
      const closedName = filename.replace(/\.ndjson$/, `-promoted-${ts}.ndjson.closed`);
      const closedPath = join(spoolDir, closedName);
      renameSync(filePath, closedPath);
      promoted.push({ activePath: filePath, closedPath, reason: 'dead-pid' });
    } catch (err) {
      skipped.push({
        file: filename,
        reason: `rename to .closed failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return { promoted, skipped };
}
