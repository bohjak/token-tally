/**
 * Schema migration runner for the ToTally central store.
 *
 * Migrations are forward-only. There is no downgrade path (per PLAN.md).
 * Each migration set is a group of SQL files that together advance the schema
 * to a given version. All files in a set run inside a single transaction so
 * the database is never left in a partially-migrated state.
 *
 * The SQL files in store/schema/ manage schema_version themselves via
 * INSERT OR IGNORE / INSERT OR REPLACE into schema_metadata. The migration
 * runner only needs to check the current version before deciding to run.
 *
 * SQL files are designed to be idempotent (IF NOT EXISTS, INSERT OR IGNORE)
 * as a safety net, but the runner guards them with a version check so each
 * set runs exactly once in normal operation.
 */

import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { join } from "path";

// Path to the SQL schema files, resolved relative to the compiled output.
//
// Source layout:  store/schema/*.sql
// Compiled output: store/dist/src/migrations.js
//
// __dirname at runtime = store/dist/src/
// Schema dir at runtime = store/schema/  →  ../../schema relative to __dirname
const SCHEMA_DIR = join(__dirname, "..", "..", "schema");

// ---------------------------------------------------------------------------
// Migration registry
// ---------------------------------------------------------------------------

// Each entry describes one migration set: the target schema version and the
// ordered list of SQL files to execute atomically.
//
// Adding a new migration: append a new entry with the next version number and
// its SQL files. Never modify existing entries — re-running old SQL on a
// migrated DB is always idempotent (IF NOT EXISTS guards), but changing the
// canonical SQL for a past migration makes diffs confusing.
const MIGRATION_SETS: ReadonlyArray<{
  version: number;
  files: ReadonlyArray<string>;
}> = [
  {
    // Version 1: initial tables + indexes.
    // 001_initial.sql creates all tables and seeds schema_version = '1'.
    // 002_indexes.sql adds all required indexes.
    version: 1,
    files: [
      join(SCHEMA_DIR, "001_initial.sql"),
      join(SCHEMA_DIR, "002_indexes.sql"),
    ],
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Runs all pending migration sets against the database.
 *
 * Safe to call on an already-migrated database — sets that have already been
 * applied are skipped. Each set that runs is wrapped in a single transaction.
 *
 * Throws if a migration file cannot be read or if the SQL fails.
 */
export function runMigrations(db: Database.Database): void {
  const currentVersion = getCurrentSchemaVersion(db);

  for (const migration of MIGRATION_SETS) {
    if (currentVersion >= migration.version) {
      // This set has already been applied; skip it.
      continue;
    }

    applyMigrationSet(db, migration.files as string[]);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getCurrentSchemaVersion(db: Database.Database): number {
  // schema_metadata may not exist yet on a fresh database.
  const tableRow = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_metadata'"
    )
    .get() as { name: string } | undefined;

  if (tableRow == null) {
    return 0;
  }

  const row = db
    .prepare("SELECT value FROM schema_metadata WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;

  return row != null ? parseInt(row.value, 10) : 0;
}

function applyMigrationSet(
  db: Database.Database,
  files: string[]
): void {
  // Run the full set inside one transaction so that a mid-migration failure
  // leaves the database in its previous clean state rather than half-migrated.
  db.transaction(() => {
    for (const file of files) {
      const sql = readFileSync(file, "utf8");
      // db.exec() runs multiple statements separated by semicolons, which is
      // what the SQL migration files use. Unlike db.prepare().run(), exec()
      // does not bind parameters — fine here since the files have no params.
      db.exec(sql);
    }
  })();
}
