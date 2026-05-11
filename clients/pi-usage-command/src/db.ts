/**
 * Read-only database connection helper for the ToTally central store.
 *
 * CONCURRENCY MODEL (from PLAN.md):
 *   The client must open the WAL database read-write (not SQLITE_OPEN_READONLY)
 *   because strict read-only connections cannot read a WAL-mode database — they
 *   lack write access to the -wal/-shm sidecar files. Immediately issuing
 *   PRAGMA query_only = 1 provides the equivalent safety guarantee: the SQLite
 *   engine enforces the restriction for the lifetime of the connection and the
 *   client never holds a write lock.
 *
 * USAGE:
 *   const { db, close } = openReadOnly(dbPath);
 *   try { ... use db ... } finally { close(); }
 */

import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Path helpers — mirrors store/src/paths.ts; inlined to avoid CJS/ESM import
// issues when the Pi runtime loads this ESM extension.
// ---------------------------------------------------------------------------

/**
 * Default path to the central ToTally database.
 * Honors $XDG_DATA_HOME when set; otherwise falls back to ~/.local/share.
 */
export function defaultDatabasePath(): string {
  const xdgDataHome = process.env["XDG_DATA_HOME"];
  const base =
    xdgDataHome != null && xdgDataHome !== ""
      ? xdgDataHome
      : join(homedir(), ".local", "share");
  return join(base, "token-tally", "events.db");
}

// ---------------------------------------------------------------------------
// Connection wrapper
// ---------------------------------------------------------------------------

export type ReadOnlyDb = {
  db: Database.Database;
  close: () => void;
};

/**
 * Opens the central store for reading.
 *
 * Returns { ok: false, reason } when the database file does not exist or
 * cannot be opened — callers should surface this as a user-facing message
 * rather than throwing so Pi command handlers stay fault-tolerant.
 */
export function openReadOnly(
  dbPath: string
): { ok: true; db: Database.Database; close: () => void } | { ok: false; reason: string } {
  if (!existsSync(dbPath)) {
    return {
      ok: false,
      reason:
        `ToTally database not found at ${dbPath}. ` +
        `Run 'token-tally migrate' to create it.`,
    };
  }

  let db: Database.Database;
  try {
    // Open read-write so WAL sidecar files (-wal, -shm) are accessible.
    // PRAGMA query_only = 1 immediately prevents any writes for this connection.
    db = new Database(dbPath);
    db.pragma("query_only = 1");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 2500");
  } catch (err) {
    return {
      ok: false,
      reason: `Cannot open database at ${dbPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { ok: true, db, close: () => db.close() };
}
