/**
 * Schema compatibility helpers shared between all TS reader clients.
 *
 * Inlined (not imported from @token-tally/store) so readers stay free of
 * the store's native better-sqlite3 dependency path. These three integers
 * must stay in sync with store/src/connection.ts; the W3.1 release-check
 * script enforces that invariant automatically.
 */

import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Schema version constants — mirrors store/src/connection.ts
// ---------------------------------------------------------------------------

/** Oldest schema version this reader build understands. */
export const MIN_SUPPORTED_SCHEMA_VERSION = 1;

/** Newest schema version this reader build was written against. */
export const MAX_KNOWN_SCHEMA_VERSION = 1;

/**
 * Number of schema versions beyond MAX_KNOWN that readers tolerate in
 * degraded mode before refusing to open entirely.
 */
export const SCHEMA_FORWARD_WINDOW = 2;

// ---------------------------------------------------------------------------
// Compatibility check
// ---------------------------------------------------------------------------

export type SchemaCheckResult =
  | { status: "needs_migration"; version: number }
  | { status: "ok"; version: number }
  | { status: "degraded"; version: number }
  | { status: "too_new"; version: number };

/**
 * Reads `schema_metadata.schema_version` and maps it to one of four states:
 *   - `needs_migration` — table absent or version < MIN_SUPPORTED
 *   - `ok`             — MIN_SUPPORTED ≤ version ≤ MAX_KNOWN
 *   - `degraded`       — MAX_KNOWN < version ≤ MAX_KNOWN + WINDOW (reader runs with reduced capability)
 *   - `too_new`        — version > MAX_KNOWN + WINDOW (refuse to open)
 */
export function checkSchemaCompatibility(db: Database.Database): SchemaCheckResult {
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
