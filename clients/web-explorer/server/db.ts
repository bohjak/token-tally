/**
 * Read-only database connection for the web explorer.
 *
 * Opens read-write (WAL sidecar files require it) then immediately applies
 * PRAGMA query_only = 1 so no writes are possible for this connection.
 */

import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function defaultDatabasePath(): string {
  const xdgDataHome = process.env["XDG_DATA_HOME"];
  const base =
    xdgDataHome != null && xdgDataHome !== ""
      ? xdgDataHome
      : join(homedir(), ".local", "share");
  return join(base, "token-tally", "events.db");
}

export type ReadOnlyDb = {
  db: Database.Database;
  close: () => void;
};

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
