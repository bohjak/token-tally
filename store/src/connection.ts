/**
 * SQLite connection management for the ToTally central store.
 *
 * Every writer connection must apply the pragmas defined here before doing any
 * DML. The tray and other read clients should open via their own read-only
 * path (not this module); this module is writer-focused.
 *
 * CONNECTION REQUIREMENTS (from PLAN.md, also documented in 001_initial.sql):
 *   PRAGMA foreign_keys = ON;     — every connection
 *   PRAGMA journal_mode = WAL;    — writers only
 *   PRAGMA synchronous  = NORMAL; — writers only
 *   PRAGMA busy_timeout = 5000;   — writers only (ms, SQLite-internal retry)
 *
 * Additionally, this module applies an application-level SQLITE_BUSY retry
 * (withBusyRetry) on top of SQLite's internal retry to handle pathological
 * lock contention.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";
import type { SchemaCompatibilityStatus } from "./types";

// ---------------------------------------------------------------------------
// Schema version constants
// ---------------------------------------------------------------------------

// Oldest schema version this build of the writer understands.
// DB schema < MIN_SUPPORTED → run `token-tally migrate` before using.
export const MIN_SUPPORTED_SCHEMA_VERSION = 1;

// Newest schema version this build was written against.
// DB schema > MAX_KNOWN → writer is outdated; behaviour depends on how far.
export const MAX_KNOWN_SCHEMA_VERSION = 1;

// Number of schema versions beyond MAX_KNOWN that readers/writers tolerate
// in degraded mode before refusing to open entirely.
// Plan specification: N = 2.
export const SCHEMA_FORWARD_WINDOW = 2;

// ---------------------------------------------------------------------------
// Connection helpers
// ---------------------------------------------------------------------------

/**
 * Opens a SQLite database for writing, applying all required pragmas.
 * Creates parent directories if they do not exist.
 *
 * Throws on connection errors that are unrelated to SQLITE_BUSY (e.g. a
 * corrupt database file). SQLITE_BUSY handling is the caller's responsibility
 * via `withBusyRetry`.
 */
export function openWriterConnection(dbPath: string): {
  db: Database.Database;
  compatibility: SchemaCompatibilityStatus;
} {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);

  // Order matters: foreign_keys must be set before any DML or FK lookups.
  db.pragma("foreign_keys = ON");
  // WAL allows concurrent readers while a single writer is active.
  // Switching to WAL is a no-op if the DB is already in WAL mode.
  db.pragma("journal_mode = WAL");
  // NORMAL sync is sufficient for analytics data. FULL would add fsync on
  // every commit — more durability than local analytics requires.
  db.pragma("synchronous = NORMAL");
  // Let SQLite retry internally for up to 5 s before surfacing SQLITE_BUSY.
  // Application-level retry (withBusyRetry) sits on top of this.
  db.pragma("busy_timeout = 5000");

  const compatibility = readSchemaCompatibility(db);
  return { db, compatibility };
}

/**
 * Reads `schema_metadata.schema_version` and maps it to a compatibility
 * status for this binary.
 *
 * Returns `needs_migration` when the table is absent (fresh DB) or when the
 * version predates MIN_SUPPORTED.
 */
export function readSchemaCompatibility(
  db: Database.Database
): SchemaCompatibilityStatus {
  // Check whether the schema_metadata table exists at all. A fresh database
  // won't have it; the migration runner creates it.
  const tableRow = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_metadata'"
    )
    .get() as { name: string } | undefined;

  if (tableRow == null) {
    return {
      status: "needs_migration",
      version: 0,
      minSupported: MIN_SUPPORTED_SCHEMA_VERSION,
    };
  }

  const versionRow = db
    .prepare("SELECT value FROM schema_metadata WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;

  const version = versionRow != null ? parseInt(versionRow.value, 10) : 0;

  if (version < MIN_SUPPORTED_SCHEMA_VERSION) {
    return {
      status: "needs_migration",
      version,
      minSupported: MIN_SUPPORTED_SCHEMA_VERSION,
    };
  }

  if (version <= MAX_KNOWN_SCHEMA_VERSION) {
    return { status: "ok", version };
  }

  if (version <= MAX_KNOWN_SCHEMA_VERSION + SCHEMA_FORWARD_WINDOW) {
    // Schema is ahead of this binary's MAX_KNOWN but within the forward window.
    // Readers may operate carefully; writers must refuse to write.
    return { status: "degraded", version, maxKnown: MAX_KNOWN_SCHEMA_VERSION };
  }

  // Schema is so far ahead that even degraded operation is unsafe.
  return {
    status: "too_new",
    version,
    maxKnown: MAX_KNOWN_SCHEMA_VERSION,
    forwardWindow: SCHEMA_FORWARD_WINDOW,
  };
}

// ---------------------------------------------------------------------------
// Busy retry
// ---------------------------------------------------------------------------

/**
 * Retries `fn` with exponential backoff when SQLite raises SQLITE_BUSY.
 * Gives up and re-throws after the total elapsed time exceeds `maxTotalMs`.
 *
 * This layer sits on top of `busy_timeout = 5000`: that pragma makes SQLite
 * retry internally for up to 5 s per operation; this function handles the
 * rare case where contention persists beyond that window.
 *
 * The loop is bounded by the deadline, not by an iteration counter, so it
 * is effectively finite for any positive `maxTotalMs`.
 */
export function withBusyRetry<T>(fn: () => T, maxTotalMs = 10_000): T {
  const deadline = Date.now() + maxTotalMs;
  // Delay starts at 50 ms and doubles each attempt, capped at 1 s.
  let delayMs = 50;

  while (true) {
    try {
      return fn();
    } catch (err) {
      const isBusy =
        err != null &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code: unknown }).code === "SQLITE_BUSY";

      if (!isBusy || Date.now() >= deadline) {
        // Either not a busy error, or we've exhausted our budget — give up.
        throw err;
      }

      const remaining = deadline - Date.now();
      // Sleep for the smaller of: next delay, remaining budget, 1 s cap.
      const sleep = Math.min(delayMs, remaining, 1_000);

      // Atomics.wait is the only synchronous sleep available in Node.js.
      // It works in the main thread on Node 24+ (the minimum required version).
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleep);
      delayMs = Math.min(delayMs * 2, 1_000);
    }
  }
}
