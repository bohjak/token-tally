/**
 * token-tally CLI — entry point for all subcommands.
 *
 * Subcommands:
 *   migrate  — create or advance the central database schema.
 *   record   — write a single event as JSON (for non-TypeScript harnesses).
 *   ingest   — drain closed NDJSON spool files into the DB.
 *   doctor   — run diagnostic checks and report health.
 *
 * Global flags (parsed before the subcommand):
 *   --db <path>  override the default database path
 *   --help / -h  print usage and exit
 *
 * Design notes:
 *   - All subcommand implementations are functions; no top-level side effects.
 *   - Expected errors (bad JSON, missing file, schema mismatch) are returned
 *     as non-zero exit codes with a diagnostic message on stderr. Unexpected
 *     errors propagate as uncaught exceptions so Node prints a stack trace.
 *   - This file is compiled to dist/cli/index.js. The thin bin/token-tally.js
 *     wrapper simply requires that file, keeping the shebang in JS.
 */

import { mkdirSync } from "fs";
import { dirname } from "path";
import { cmdImportLegacyPi } from "./import-legacy-pi";
import { formatDoctorReport, runDoctor } from "../src/doctor";
import { ingestDir, ingestFile } from "../src/ingest";
import { defaultDatabasePath, defaultSpoolDir } from "../src/paths";
import type {
  HarnessPayload,
  LlmMessagePayload,
  RawEventPayload,
  SessionPayload,
  SubscriptionPayload,
  ToolCallPayload,
  TurnPayload,
} from "../src/types";
import { AnalyticsWriter } from "../src/writer";

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/**
 * Main CLI dispatcher. Call this from the bin wrapper.
 * Returns the desired process exit code (0 = success, non-zero = failure).
 */
export async function main(argv: string[]): Promise<number> {
  // Strip node and script path if present (happens when called from bin).
  const args = argv.slice(0);

  // Extract global --db flag before handing off to subcommands.
  const { remaining, dbPath } = extractGlobalFlags(args);

  const [subcommand, ...rest] = remaining;

  if (subcommand == null || subcommand === "--help" || subcommand === "-h") {
    printUsage();
    return 0;
  }

  switch (subcommand) {
    case "migrate":
      return cmdMigrate(rest, dbPath);

    case "record":
      return cmdRecord(rest, dbPath);

    case "ingest":
      return cmdIngest(rest, dbPath);

    case "doctor":
      return cmdDoctor(rest, dbPath);

    case "import":
      return cmdImport(rest, dbPath);

    default:
      process.stderr.write(
        `token-tally: unknown subcommand '${subcommand}'. Run 'token-tally --help' for usage.\n`
      );
      return 1;
  }
}

// ---------------------------------------------------------------------------
// Global flag parsing
// ---------------------------------------------------------------------------

type GlobalFlags = {
  /** Value of --db <path>, or undefined when the default should be used. */
  dbPath: string | undefined;
  /** Remaining args after global flags are consumed. */
  remaining: string[];
};

function extractGlobalFlags(args: string[]): GlobalFlags {
  let dbPath: string | undefined;
  const remaining: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--db") {
      const next = args[i + 1];
      if (next == null || next.startsWith("-")) {
        process.stderr.write("token-tally: --db requires a path argument.\n");
        process.exit(1);
      }
      dbPath = next;
      i++; // consume the path value
    } else {
      remaining.push(arg);
    }
  }

  return { dbPath, remaining };
}

// ---------------------------------------------------------------------------
// migrate
// ---------------------------------------------------------------------------

async function cmdMigrate(
  _args: string[],
  dbPathOverride: string | undefined
): Promise<number> {
  const dbPath = dbPathOverride ?? defaultDatabasePath();

  // Ensure the parent directory exists so better-sqlite3 can create the file.
  mkdirSync(dirname(dbPath), { recursive: true });

  try {
    // AnalyticsWriter.open() runs migrations automatically on a fresh or
    // outdated database. We open it, then immediately close it — the side
    // effect is the migration.
    const writer = await AnalyticsWriter.open({
      dbPath,
      harnessName: "token-tally-cli",
    });
    await writer.close();
    process.stdout.write(`token-tally migrate: database ready at ${dbPath}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(
      `token-tally migrate: failed — ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 1;
  }
}

// ---------------------------------------------------------------------------
// record
// ---------------------------------------------------------------------------

// Supported event type strings for the --type flag.
const VALID_RECORD_TYPES = [
  "harness",
  "session",
  "turn",
  "llm-message",
  "subscription",
  "tool-call",
  "raw-event",
] as const;
type RecordType = (typeof VALID_RECORD_TYPES)[number];

async function cmdRecord(
  args: string[],
  dbPathOverride: string | undefined
): Promise<number> {
  // Parse --type and --json flags.
  let recordType: RecordType | undefined;
  let jsonPayload: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--type") {
      recordType = args[i + 1] as RecordType;
      i++;
    } else if (arg === "--json") {
      jsonPayload = args[i + 1];
      i++;
    }
  }

  if (recordType == null) {
    process.stderr.write(
      "token-tally record: --type is required.\n" +
        `  Valid types: ${VALID_RECORD_TYPES.join(", ")}\n`
    );
    return 1;
  }

  if (!(VALID_RECORD_TYPES as ReadonlyArray<string>).includes(recordType)) {
    process.stderr.write(
      `token-tally record: unknown type '${recordType}'.\n` +
        `  Valid types: ${VALID_RECORD_TYPES.join(", ")}\n`
    );
    return 1;
  }

  if (jsonPayload == null) {
    process.stderr.write("token-tally record: --json is required.\n");
    return 1;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(jsonPayload);
  } catch (err) {
    process.stderr.write(
      `token-tally record: invalid JSON — ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 1;
  }

  const dbPath = dbPathOverride ?? defaultDatabasePath();

  let writer: AnalyticsWriter;
  try {
    writer = await AnalyticsWriter.open({
      dbPath,
      harnessName: "token-tally-cli",
    });
  } catch (err) {
    process.stderr.write(
      `token-tally record: cannot open database — ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 1;
  }

  try {
    const result = await dispatchRecord(writer, recordType, payload);
    await writer.close();
    // Print the resulting ID so callers can chain operations.
    if (result != null) {
      process.stdout.write(JSON.stringify(result) + "\n");
    }
    return 0;
  } catch (err) {
    await writer.close().catch(() => undefined);
    process.stderr.write(
      `token-tally record: write failed — ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 1;
  }
}

/**
 * Routes the parsed payload to the appropriate AnalyticsWriter method.
 *
 * The payload is validated only for the fields the writer strictly requires;
 * the writer and DB schema enforce deeper invariants. This keeps the CLI thin
 * and avoids duplicating validation logic.
 */
async function dispatchRecord(
  writer: AnalyticsWriter,
  recordType: RecordType,
  payload: unknown
): Promise<{ id: string } | undefined> {
  // Payload is typed as `unknown` from JSON.parse. We cast inside each case
  // and rely on the DB constraints to catch structural errors rather than
  // adding a full runtime validator here.
  switch (recordType) {
    case "harness":
      return writer.recordHarness(payload as HarnessPayload);
    case "session":
      return writer.recordSession(payload as SessionPayload);
    case "turn":
      return writer.recordTurn(payload as TurnPayload);
    case "llm-message":
      return writer.recordLlmMessage(payload as LlmMessagePayload);
    case "subscription":
      return writer.recordSubscription(payload as SubscriptionPayload);
    case "tool-call":
      return writer.recordToolCall(payload as ToolCallPayload);
    case "raw-event":
      await writer.recordRawEvent(payload as RawEventPayload);
      return undefined; // raw_events has no UUID return
  }
}

// ---------------------------------------------------------------------------
// ingest
// ---------------------------------------------------------------------------

async function cmdIngest(
  args: string[],
  dbPathOverride: string | undefined
): Promise<number> {
  // Optional positional arg: a specific file or directory to ingest.
  // When omitted, the default spool directory is drained.
  const [targetPath] = args.filter((a) => !a.startsWith("-"));

  const dbPath = dbPathOverride ?? defaultDatabasePath();
  const options = { dbPath };

  if (targetPath != null) {
    // Ingest a single file (active or closed).
    const result = await ingestFile(targetPath, options);
    if (result.errors.length > 0) {
      for (const e of result.errors) {
        process.stderr.write(`token-tally ingest: ${e.file}: ${e.message}\n`);
      }
      return 1;
    }
    process.stdout.write(
      `token-tally ingest: ingested ${result.ingested} file(s) from ${targetPath}\n`
    );
    return 0;
  }

  // Drain the default spool directory.
  const spoolDir = defaultSpoolDir();
  const result = await ingestDir(spoolDir, options);

  if (result.skipped > 0) {
    process.stdout.write(
      `token-tally ingest: skipped ${result.skipped} active spool file(s) (still open by a live writer).\n`
    );
  }
  if (result.errors.length > 0) {
    for (const e of result.errors) {
      process.stderr.write(`token-tally ingest: ${e.file}: ${e.message}\n`);
    }
    // Partial success is still reported even when errors exist.
  }

  process.stdout.write(
    `token-tally ingest: ingested ${result.ingested} file(s) from ${spoolDir}\n`
  );

  return result.errors.length > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

async function cmdDoctor(
  args: string[],
  dbPathOverride: string | undefined
): Promise<number> {
  const jsonMode = args.includes("--json");
  const dbPath = dbPathOverride ?? defaultDatabasePath();

  const report = runDoctor(dbPath);

  if (jsonMode) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(formatDoctorReport(report) + "\n");
  }

  // Exit non-zero when --json is used in automation and errors exist.
  // In human mode, errors are displayed but the exit code is always non-zero
  // when there are real errors — this is consistent regardless of --json.
  return report.status === "ok" ? 0 : 1;
}

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

async function cmdImport(
  args: string[],
  dbPathOverride: string | undefined
): Promise<number> {
  const [importer, ...rest] = args;

  if (importer === "legacy-pi") {
    return cmdImportLegacyPi(rest, dbPathOverride);
  }

  if (importer == null) {
    process.stderr.write(
      "token-tally import: an importer name is required.\n" +
        "  Available importers: legacy-pi\n"
    );
    return 1;
  }

  process.stderr.write(
    `token-tally import: unknown importer '${importer}'.\n` +
      "  Available importers: legacy-pi\n"
  );
  return 1;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage(): void {
  process.stdout.write(`
token-tally — ToTally analytics CLI

Usage:
  token-tally [--db <path>] <subcommand> [options]

Global flags:
  --db <path>   Override the default database path
                Default: ~/.local/share/token-tally/events.db

Subcommands:
  migrate
    Create or advance the central database schema. Safe to run repeatedly.

  record --type <type> --json <payload>
    Write a single analytics event from a JSON payload.
    Types: harness, session, turn, llm-message, subscription, tool-call, raw-event
    Prints the assigned ID on stdout.

  ingest [<path>]
    Drain closed NDJSON spool files into the central database.
    If <path> is omitted, drains the default spool directory.
    Active spool files (*.ndjson) are skipped; only *.ndjson.closed files
    are processed. Exits non-zero if any file fails.

  doctor [--json]
    Run diagnostic checks: schema version, required tables, FK integrity,
    stale sessions, and suspicious keys in raw_events.
    --json  Output machine-readable JSON (exit non-zero on errors).

  import <importer> [options]
    Import data from another analytics source into the central store.
    This command is always explicit and is never run by the installer automatically.

    Importers:
      legacy-pi [--source <path>]
        Import from the legacy Pi analytics database.
        Default source: ~/.pi/analytics/events.db
        The import is idempotent: repeat runs produce no duplicate rows.
        The source database is never modified or deleted.

Examples:
  token-tally migrate
  token-tally migrate --db /tmp/test.db

  token-tally record --type harness --json '{"name":"pi","displayName":"Pi"}'
  token-tally record --type llm-message --json '{"harnessId":"pi",...}'

  token-tally ingest
  token-tally ingest /path/to/pi-1234-1700000000.ndjson.closed

  token-tally doctor
  token-tally doctor --json
  token-tally doctor --json --db /tmp/test.db
`.trimStart());
}
