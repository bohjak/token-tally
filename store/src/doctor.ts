/**
 * Diagnostic checks for the ToTally central store.
 *
 * `runDoctor` is the programmatic entry point; the CLI wraps it and formats
 * the result for human or JSON output. Checks are ordered from most-critical
 * (DB file reachable, schema version OK) to least-critical (stale sessions,
 * suspicious raw_events rows).
 *
 * Design: checks are functions that return typed finding values rather than
 * throwing. This lets the caller collect all findings and decide how to
 * display them without intermediate failure branches.
 */

import Database from "better-sqlite3";
import { statSync } from "fs";
import { readSchemaCompatibility } from "./connection";

// ---------------------------------------------------------------------------
// Finding types
// ---------------------------------------------------------------------------

/** Severity of a single doctor finding. */
export type FindingSeverity = "ok" | "warning" | "error";

/** A single diagnostic observation. */
export type Finding = {
  /** Short machine-readable code, e.g. "schema_ok", "stale_sessions". */
  code: string;
  severity: FindingSeverity;
  /** Human-readable description suitable for terminal display. */
  message: string;
  /** Optional structured data for JSON consumers. */
  detail?: Record<string, unknown>;
};

/** Aggregated output from runDoctor. */
export type DoctorReport = {
  /** Path to the database that was examined. */
  dbPath: string;
  /** Unix timestamp (ms) when the report was generated. */
  generatedAt: number;
  /** All findings, ordered from most-critical to least-critical. */
  findings: Finding[];
  /**
   * Convenience roll-up: "ok" if all findings are ok/warning, "error" if any
   * finding has severity "error". Use this to decide the CLI exit code.
   */
  status: "ok" | "error";
};

// ---------------------------------------------------------------------------
// Sensitive key patterns flagged in raw_events payloads
// ---------------------------------------------------------------------------

// These keys are checked (case-insensitively) as top-level JSON keys in raw
// event payloads. Writers must never include them; the doctor surfaces any
// that slip through. List is intentionally conservative — false positives for
// unrelated keys named "arguments" are acceptable; missed secrets are not.
const SENSITIVE_KEYS = [
  "prompt",
  "content",
  "messages",
  "arguments",
  "output",
  "env",
  "secret",
  "token",
  "api_key",
  "apikey",
  "password",
];

// How many recent raw_events rows to sample for sensitive key checks.
// Sampling keeps the doctor fast on large raw_events tables.
const RAW_EVENTS_SAMPLE_SIZE = 100;

// Sessions idle for longer than this threshold (24 h) without an ended_at are
// flagged as potentially stale — the harness may have crashed without closing.
const STALE_SESSION_THRESHOLD_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Runs all diagnostic checks against the database at `dbPath` and returns a
 * structured report. Never throws; DB-open errors are surfaced as findings.
 */
export function runDoctor(dbPath: string): DoctorReport {
  const generatedAt = Date.now();
  const findings: Finding[] = [];

  // 1. DB file reachability — if this fails nothing else can run.
  const fileCheck = checkDbFile(dbPath);
  findings.push(fileCheck);
  if (fileCheck.severity === "error") {
    return { dbPath, generatedAt, findings, status: "error" };
  }

  // Try to open the DB. If we cannot, surface that and stop.
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
    db.pragma("foreign_keys = ON");
  } catch (err) {
    findings.push({
      code: "db_open_failed",
      severity: "error",
      message: `Cannot open database: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { dbPath, generatedAt, findings, status: "error" };
  }

  try {
    // 2. Schema version.
    findings.push(checkSchemaVersion(db));

    // 3. Required tables present.
    findings.push(...checkRequiredTables(db));

    // 4. Foreign-key integrity (quick PRAGMA check).
    findings.push(checkForeignKeys(db));

    // 5. Stale sessions.
    findings.push(...checkStaleSessions(db, generatedAt));

    // 6. Raw events suspicious key scan.
    findings.push(...checkRawEventsSensitiveKeys(db));
  } finally {
    db.close();
  }

  const status = findings.some((f) => f.severity === "error") ? "error" : "ok";
  return { dbPath, generatedAt, findings, status };
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

function checkDbFile(dbPath: string): Finding {
  try {
    const stats = statSync(dbPath);
    if (!stats.isFile()) {
      return {
        code: "db_not_a_file",
        severity: "error",
        message: `Path exists but is not a regular file: ${dbPath}`,
      };
    }
    return {
      code: "db_file_ok",
      severity: "ok",
      message: `Database file exists (${(stats.size / 1024).toFixed(1)} KiB)`,
      detail: { path: dbPath, sizeBytes: stats.size },
    };
  } catch {
    return {
      code: "db_file_missing",
      severity: "error",
      message: `Database file not found: ${dbPath}. Run 'token-tally migrate' to create it.`,
      detail: { path: dbPath },
    };
  }
}

function checkSchemaVersion(db: Database.Database): Finding {
  const compat = readSchemaCompatibility(db);
  switch (compat.status) {
    case "ok":
      return {
        code: "schema_ok",
        severity: "ok",
        message: `Schema version ${compat.version} — current and supported.`,
        detail: { version: compat.version },
      };
    case "needs_migration":
      return {
        code: "schema_needs_migration",
        severity: "error",
        message:
          `Schema version ${compat.version} is below the minimum supported ` +
          `(${compat.minSupported}). Run 'token-tally migrate' to update.`,
        detail: { version: compat.version, minSupported: compat.minSupported },
      };
    case "degraded":
      return {
        code: "schema_degraded",
        severity: "warning",
        message:
          `Schema version ${compat.version} is ahead of this binary's max known ` +
          `(${compat.maxKnown}) but within the forward window. Update the ` +
          `token-tally package for full support.`,
        detail: { version: compat.version, maxKnown: compat.maxKnown },
      };
    case "too_new":
      return {
        code: "schema_too_new",
        severity: "error",
        message:
          `Schema version ${compat.version} is too far ahead of this binary ` +
          `(max known: ${compat.maxKnown}, forward window: ±${compat.forwardWindow}). ` +
          `Update the token-tally package.`,
        detail: {
          version: compat.version,
          maxKnown: compat.maxKnown,
          forwardWindow: compat.forwardWindow,
        },
      };
  }
}

const REQUIRED_TABLES = [
  "schema_metadata",
  "harnesses",
  "sessions",
  "turns",
  "llm_messages",
  "subscriptions",
  "tool_calls",
] as const;

function checkRequiredTables(db: Database.Database): Finding[] {
  // Read the actual table names once to avoid repeated queries.
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>;
  const present = new Set(rows.map((r) => r.name));

  return REQUIRED_TABLES.map((table) => {
    if (present.has(table)) {
      return {
        code: `table_${table}_ok`,
        severity: "ok" as FindingSeverity,
        message: `Table '${table}' exists.`,
      };
    }
    return {
      code: `table_${table}_missing`,
      severity: "error" as FindingSeverity,
      message: `Required table '${table}' is missing. Run 'token-tally migrate'.`,
      detail: { table },
    };
  });
}

function checkForeignKeys(db: Database.Database): Finding {
  // PRAGMA foreign_key_check returns one row per violation. An empty result
  // means the database is internally consistent.
  //
  // We check each table in REQUIRED_TABLES that has FKs. Running the pragma
  // without an argument checks all tables; that's fine for a doctor check
  // since we open read-only and never modify the DB.
  try {
    const violations = db
      .prepare("PRAGMA foreign_key_check")
      .all() as Array<{ table: string; rowid: number; parent: string; fkid: number }>;

    if (violations.length === 0) {
      return {
        code: "foreign_keys_ok",
        severity: "ok",
        message: "Foreign-key integrity check passed.",
      };
    }

    const summary = violations
      .slice(0, 5)
      .map((v) => `${v.table}(rowid=${v.rowid}) → ${v.parent}`)
      .join(", ");
    const extra = violations.length > 5 ? ` … and ${violations.length - 5} more` : "";

    return {
      code: "foreign_key_violations",
      severity: "error",
      message: `Foreign-key violations found (${violations.length}): ${summary}${extra}`,
      detail: { count: violations.length, sample: violations.slice(0, 5) },
    };
  } catch (err) {
    // PRAGMA may fail if required tables are missing; treat as warning since
    // a separate check already flags missing tables as errors.
    return {
      code: "foreign_key_check_skipped",
      severity: "warning",
      message: `FK integrity check could not run: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function checkStaleSessions(db: Database.Database, nowMs: number): Finding[] {
  // Check that the sessions table exists before querying it.
  const tableExists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'"
    )
    .get() as { name: string } | undefined;

  if (tableExists == null) {
    // Missing-table finding is already emitted by checkRequiredTables; skip.
    return [];
  }

  const thresholdMs = nowMs - STALE_SESSION_THRESHOLD_MS;
  const stale = db
    .prepare(
      `SELECT id, harness_id, started_at
       FROM sessions
       WHERE ended_at IS NULL AND started_at < ?
       LIMIT 10`
    )
    .all(thresholdMs) as Array<{ id: string; harness_id: string; started_at: number }>;

  if (stale.length === 0) {
    return [
      {
        code: "stale_sessions_ok",
        severity: "ok",
        message: "No stale open sessions detected.",
      },
    ];
  }

  const sample = stale
    .map((s) => `${s.harness_id}/${s.id.slice(0, 8)}…`)
    .join(", ");

  return [
    {
      code: "stale_sessions",
      severity: "warning",
      message:
        `${stale.length} session(s) have been open for over 24 h without ` +
        `closing (harness may have crashed): ${sample}`,
      detail: {
        count: stale.length,
        thresholdMs: STALE_SESSION_THRESHOLD_MS,
        sample: stale.slice(0, 5),
      },
    },
  ];
}

function checkRawEventsSensitiveKeys(db: Database.Database): Finding[] {
  // raw_events is optional — skip if absent.
  const tableExists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='raw_events'"
    )
    .get() as { name: string } | undefined;

  if (tableExists == null) {
    return [];
  }

  const rows = db
    .prepare(
      `SELECT id, harness_id, kind, payload_json
       FROM raw_events
       ORDER BY id DESC
       LIMIT ${RAW_EVENTS_SAMPLE_SIZE}`
    )
    .all() as Array<{ id: number; harness_id: string; kind: string; payload_json: string }>;

  const flagged: Array<{ id: number; harness_id: string; kind: string; keys: string[] }> = [];

  for (const row of rows) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    } catch {
      // Malformed JSON is a separate concern; skip sensitive-key check.
      continue;
    }

    const suspiciousKeys = Object.keys(payload).filter((k) =>
      SENSITIVE_KEYS.includes(k.toLowerCase())
    );

    if (suspiciousKeys.length > 0) {
      flagged.push({
        id: row.id,
        harness_id: row.harness_id,
        kind: row.kind,
        keys: suspiciousKeys,
      });
    }
  }

  if (flagged.length === 0) {
    return [
      {
        code: "raw_events_ok",
        severity: "ok",
        message: `Sampled ${rows.length} raw_events row(s) — no sensitive keys detected.`,
        detail: { sampled: rows.length },
      },
    ];
  }

  const summary = flagged
    .slice(0, 3)
    .map((f) => `row ${f.id} (${f.harness_id}/${f.kind}): ${f.keys.join(", ")}`)
    .join("; ");

  return [
    {
      code: "raw_events_sensitive_keys",
      severity: "error",
      message:
        `${flagged.length} raw_events row(s) contain suspicious keys that ` +
        `may hold sensitive data: ${summary}`,
      detail: { count: flagged.length, sample: flagged.slice(0, 5) },
    },
  ];
}

// ---------------------------------------------------------------------------
// Formatting helpers (used by the CLI)
// ---------------------------------------------------------------------------

/** ANSI escape sequences for terminal colour. No-ops when stdout is not a TTY. */
const isTTY = process.stdout.isTTY === true;
const RESET = isTTY ? "\x1b[0m" : "";
const RED = isTTY ? "\x1b[31m" : "";
const YELLOW = isTTY ? "\x1b[33m" : "";
const GREEN = isTTY ? "\x1b[32m" : "";

/**
 * Formats a DoctorReport as a human-readable string for terminal output.
 * Each finding is prefixed with a coloured symbol: ✓ ok, ⚠ warning, ✗ error.
 */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];

  const dateStr = new Date(report.generatedAt).toISOString();
  lines.push(`ToTally doctor — ${report.dbPath} (${dateStr})`);
  lines.push("");

  for (const finding of report.findings) {
    let prefix: string;
    if (finding.severity === "ok") {
      prefix = `${GREEN}✓${RESET}`;
    } else if (finding.severity === "warning") {
      prefix = `${YELLOW}⚠${RESET}`;
    } else {
      prefix = `${RED}✗${RESET}`;
    }
    lines.push(`  ${prefix}  ${finding.message}`);
  }

  lines.push("");
  if (report.status === "ok") {
    lines.push(`${GREEN}All checks passed.${RESET}`);
  } else {
    const errorCount = report.findings.filter((f) => f.severity === "error").length;
    lines.push(`${RED}${errorCount} error(s) found. See above for details.${RESET}`);
  }

  return lines.join("\n");
}
