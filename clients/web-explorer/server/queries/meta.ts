import type Database from "better-sqlite3";

export type HarnessRow = {
  name: string;
  display_name: string;
  last_seen_at: number;
};

export function listHarnesses(db: Database.Database): HarnessRow[] {
  return db
    .prepare("SELECT name, display_name, last_seen_at FROM harnesses ORDER BY last_seen_at DESC")
    .all() as HarnessRow[];
}

export function getSchemaVersion(db: Database.Database): string {
  const row = db
    .prepare("SELECT value FROM schema_metadata WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;
  return row?.value ?? "unknown";
}
