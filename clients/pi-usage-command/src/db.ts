/**
 * Read-only database connection helper for the ToTally central store.
 *
 * CONCURRENCY MODEL (from PLAN.md):
 *   The client must open the WAL database read-write (not SQLITE_OPEN_READONLY)
 *   because strict read-only connections cannot read a WAL-mode database -- they
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
// Schema version constants -- mirrors store/src/connection.ts.
// Inlined here to avoid CJS/ESM import issues when the Pi runtime loads this
// ESM extension directly via type-stripping.
// ---------------------------------------------------------------------------

const MIN_SUPPORTED_SCHEMA_VERSION = 1;
const MAX_KNOWN_SCHEMA_VERSION = 1;
const SCHEMA_FORWARD_WINDOW = 2;

// ---------------------------------------------------------------------------
// Path helpers -- mirrors store/src/paths.ts; inlined to avoid CJS/ESM import
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
 * Opens the central store for reading and validates the schema version.
 *
 * Four-branch compatibility window (mirrors store/src/connection.ts and docs/schema.md):
 *   - version < MIN_SUPPORTED  -> refuse; prompt to run 'token-tally migrate'
 *   - MIN <= version <= MAX_KNOWN -> proceed normally
 *   - MAX < version <= MAX + WINDOW -> proceed in degraded mode; set schemaWarning
 *   - version > MAX + WINDOW   -> refuse; prompt to update the binary
 *
 * Returns { ok: false, reason } on unrecoverable errors so Pi command handlers
 * stay fault-tolerant rather than throwing.
 */
export function openReadOnly(
  dbPath: string
):
  | { ok: true; db: Database.Database; close: () => void; schemaWarning?: string }
  | { ok: false; reason: string } {
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

  // Schema compatibility check (reader expectation #2 from docs/schema.md).
  const compat = checkSchemaCompatibility(db);
  if (compat.status === "needs_migration") {
    db.close();
    return {
      ok: false,
      reason:
        `ToTally database schema version ${compat.version} is too old ` +
        `(minimum supported: ${MIN_SUPPORTED_SCHEMA_VERSION}). ` +
        `Run 'token-tally migrate' to upgrade.`,
    };
  }
  if (compat.status === "too_new") {
    db.close();
    return {
      ok: false,
      reason:
        `ToTally database schema version ${compat.version} is too new ` +
        `(max known: ${MAX_KNOWN_SCHEMA_VERSION}, forward window: ${SCHEMA_FORWARD_WINDOW}). ` +
        `Update the token-tally binary to read this database.`,
    };
  }

  const schemaWarning =
    compat.status === "degraded"
      ? `[token-tally:usage] Database schema version ${compat.version} is ahead of ` +
        `this build (max known: ${MAX_KNOWN_SCHEMA_VERSION}). Operating in degraded ` +
        `read-only mode -- update the token-tally binary when convenient.`
      : undefined;

  return { ok: true, db, close: () => db.close(), schemaWarning };
}

// ---------------------------------------------------------------------------
// Internal: schema compatibility check
// Mirrors the logic in store/src/connection.ts:readSchemaCompatibility.
// ---------------------------------------------------------------------------

type SchemaCheckResult =
  | { status: "needs_migration"; version: number }
  | { status: "ok"; version: number }
  | { status: "degraded"; version: number }
  | { status: "too_new"; version: number };

function checkSchemaCompatibility(db: Database.Database): SchemaCheckResult {
  const tableRow = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_metadata'")
    .get() as { name: string } | undefined;

  if (tableRow == null) {
    return { status: "needs_migration", version: 0 };
  }

  const versionRow = db
    .prepare("SELECT value FROM schema_metadata WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;

  const version = versionRow != null ? parseInt(versionRow.value, 10) : 0;

  if (version < MIN_SUPPORTED_SCHEMA_VERSION) {
    return { status: "needs_migration", version };
  }
  if (version <= MAX_KNOWN_SCHEMA_VERSION) {
    return { status: "ok", version };
  }
  if (version <= MAX_KNOWN_SCHEMA_VERSION + SCHEMA_FORWARD_WINDOW) {
    return { status: "degraded", version };
  }
  return { status: "too_new", version };
}
