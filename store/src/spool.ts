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
   * safely drained on the next successful DB open. No-op if the active file
   * is empty or absent.
   */
  rotate(): void {
    if (!existsSync(this.activeFilePath)) {
      return;
    }

    const stats = statSync(this.activeFilePath);
    if (stats.size === 0) {
      // Nothing was written; skip to avoid leaving empty closed files.
      unlinkSync(this.activeFilePath);
      this.openedAt = Date.now();
      return;
    }

    const ts = Date.now();
    // Active filename:  pi-1234.ndjson
    // Closed filename:  pi-1234-<ts>.ndjson.closed
    const activeName = basename(this.activeFilePath);
    const closedName = activeName.replace(/\.ndjson$/, `-${ts}.ndjson.closed`);
    renameSync(this.activeFilePath, join(this.spoolDir, closedName));
    this.openedAt = Date.now();
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
// Drain
// ---------------------------------------------------------------------------

export type DrainResult = {
  /** Number of files successfully drained and deleted. */
  drained: number;
  /** Entries for files that could not be drained (parse error, write error, etc.). */
  errors: Array<{ file: string; message: string }>;
};

/**
 * Drains all `*.ndjson.closed` files in `spoolDir` by passing each file's
 * records to `processRecordsFromFile`.
 *
 * The caller is responsible for wrapping `processRecordsFromFile` in a
 * transaction so that either all records in a file are committed or none are
 * (preserving the "at-least-once within a file" guarantee).
 *
 * Files that fail (bad JSON, write error in the callback) are reported in the
 * result and left on disk for manual inspection. They are NOT deleted.
 *
 * Active spool files (*.ndjson without .closed) are never touched.
 */
export function drainClosedSpoolFiles(
  spoolDir: string,
  processRecordsFromFile: (records: SpoolRecord[]) => void
): DrainResult {
  if (!existsSync(spoolDir)) {
    return { drained: 0, errors: [] };
  }

  const closedFiles = readdirSync(spoolDir).filter((f) =>
    f.endsWith(".ndjson.closed")
  );

  const errors: Array<{ file: string; message: string }> = [];
  let drained = 0;

  for (const entry of closedFiles) {
    const filePath = join(spoolDir, entry);
    try {
      const lines = readFileSync(filePath, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "");

      // Parse all lines upfront so a JSON error surfaces before any writes.
      const records = lines.map((line) => JSON.parse(line) as SpoolRecord);

      processRecordsFromFile(records);

      // File committed successfully — safe to delete.
      unlinkSync(filePath);
      drained++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ file: filePath, message });
      // Leave the file in place for manual recovery or the next drain attempt.
    }
  }

  return { drained, errors };
}
