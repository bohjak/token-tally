/**
 * token-tally CLI — entry point for all subcommands.
 *
 * Uses yargs for argument parsing and command dispatch. The per-command
 * implementation functions are unchanged from the original hand-rolled
 * dispatcher; yargs replaces only the parsing and routing layer.
 *
 * Global option:
 *   --db <path>  Override the default database path (available to all commands).
 *
 * This file compiles to dist/cli/index.js (CommonJS). The thin bin wrapper
 * (bin/token-tally.js) calls `main()` and sets process.exitCode from the
 * returned value.
 */

import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { pathToFileURL } from "url";
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
import yargs from "yargs";

// ---------------------------------------------------------------------------
// Explore options
// ---------------------------------------------------------------------------

/**
 * Options passed from the explore CLI handler to launcher.launch().
 * Exported so the launcher module (clients/web-explorer/server/launcher.ts)
 * can import this type from the store package.
 */
export type ExploreOptions = {
  db?: string;
  port?: number;
  noOpen?: boolean;
  printUrl?: boolean;
  stop?: boolean;
  /** Idle timeout in milliseconds. null = disabled via --no-idle-timeout. */
  idleTimeoutMs: number | null;
  foreground?: boolean;
};

// ---------------------------------------------------------------------------
// Duration parsing
// ---------------------------------------------------------------------------

/**
 * Parse a human-readable duration string into milliseconds.
 *
 * Accepted formats:
 *   "30s"  →    30 000 ms
 *   "5m"   →   300 000 ms
 *   "1h"   → 3 600 000 ms
 *   "0"    →         0 ms  (caller treats 0 as null / no timeout)
 *   "120"  →   120 000 ms  (bare integer = seconds)
 */
export function parseDurationMs(s: string): number {
  const t = s.trim();
  const n = (raw: string) => parseInt(raw, 10);
  if (/^\d+s$/i.test(t)) return n(t.slice(0, -1)) * 1_000;
  if (/^\d+m$/i.test(t)) return n(t.slice(0, -1)) * 60_000;
  if (/^\d+h$/i.test(t)) return n(t.slice(0, -1)) * 3_600_000;
  if (/^\d+$/.test(t)) return n(t) * 1_000;
  throw new Error(
    `token-tally explore: invalid duration "${s}". Use a value like "30s", "5m", or "1h".`,
  );
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/**
 * Main CLI dispatcher. Call this from the bin wrapper.
 * Returns the desired process exit code (0 = success, non-zero = failure).
 */
export async function main(argv: string[]): Promise<number> {
  // Exit code captured from command handlers. yargs command handlers are
  // void-returning, so we propagate codes through this mutable variable.
  let exitCode = 0;

  // When called with no arguments, show the help screen and exit 0 — matching
  // the original dispatcher's behavior. Forwarding --help lets yargs generate
  // its formatted help text rather than requiring a bespoke printUsage().
  const effectiveArgv = argv.length === 0 ? ["--help"] : argv;

  await yargs(effectiveArgv)
    .scriptName("token-tally")
    .usage("Usage: $0 [--db <path>] <command> [options]")

    // Global --db is available to all subcommands. yargs merges it into each
    // command's `args` object automatically because `global: true`.
    .option("db", {
      type: "string",
      describe: "Override the default database path",
      global: true,
    })

    // ── migrate ──────────────────────────────────────────────────────────
    .command(
      "migrate",
      "Create or advance the central database schema (safe to run repeatedly).",
      (y) => y,
      async (args) => {
        exitCode = await cmdMigrate(args.db);
      },
    )

    // ── record ───────────────────────────────────────────────────────────
    .command(
      "record",
      "Write a single analytics event from a JSON payload. Prints the assigned ID on stdout.",
      (y) =>
        y
          .option("type", {
            type: "string",
            demandOption: true,
            describe:
              "Event type: harness | session | turn | llm-message | " +
              "subscription | tool-call | raw-event",
          })
          .option("json", {
            type: "string",
            demandOption: true,
            describe: "JSON-encoded payload for the event",
          }),
      async (args) => {
        exitCode = await cmdRecord(args.type, args.json, args.db);
      },
    )

    // ── ingest ───────────────────────────────────────────────────────────
    .command(
      "ingest [path]",
      "Drain closed NDJSON spool files into the central database.",
      (y) =>
        y.positional("path", {
          type: "string",
          describe:
            "File or directory to ingest. Omit to drain the default spool directory.",
        }),
      async (args) => {
        exitCode = await cmdIngest(args.path, args.db);
      },
    )

    // ── doctor ───────────────────────────────────────────────────────────
    .command(
      "doctor",
      "Run diagnostic checks and report database health.",
      (y) =>
        y.option("json", {
          type: "boolean",
          describe:
            "Output machine-readable JSON. Exits non-zero when errors are found.",
        }),
      async (args) => {
        exitCode = await cmdDoctor(args.json === true, args.db);
      },
    )

    // ── import ───────────────────────────────────────────────────────────
    .command(
      "import <importer>",
      "Import data from another analytics source (never run automatically by the installer).",
      (y) =>
        y
          .positional("importer", {
            type: "string",
            choices: ["legacy-pi"] as const,
            demandOption: true,
            describe: "Importer name",
          })
          .option("source", {
            type: "string",
            describe:
              "Path to the source database. Default: ~/.pi/analytics/events.db",
          })
          .epilog(
            "Importers:\n" +
              "  legacy-pi  Import from the legacy Pi analytics database.\n" +
              "             Idempotent: repeat runs produce no duplicate rows.\n" +
              "             The source database is never modified or deleted.",
          ),
      async (args) => {
        if (args.importer === "legacy-pi") {
          // cmdImportLegacyPi still expects a raw args array; reconstruct one
          // from the yargs-parsed values.
          const importArgs = args.source ? ["--source", args.source] : [];
          exitCode = await cmdImportLegacyPi(importArgs, args.db);
        } else {
          // yargs' choices validation prevents reaching this branch at runtime,
          // but TypeScript doesn't know that.
          process.stderr.write(
            `token-tally import: unknown importer '${String(args.importer)}'.\n` +
              "  Available importers: legacy-pi\n",
          );
          exitCode = 1;
        }
      },
    )

    // ── explore ──────────────────────────────────────────────────────────
    .command(
      "explore",
      "Open the web-based analytics explorer (starts or reuses a local server).",
      (y) =>
        y
          // Disable yargs' automatic --no-X boolean negation within this
          // subcommand. --no-open and --no-idle-timeout are explicit boolean
          // flags here, not implicit negations of --open / --idle-timeout.
          .parserConfiguration({ "boolean-negation": false })
          .option("port", {
            type: "number",
            default: 3741,
            describe: "Preferred localhost port for the explorer server",
          })
          .option("no-open", {
            type: "boolean",
            describe:
              "Start or reuse the server without opening a browser tab",
          })
          .option("print-url", {
            type: "boolean",
            describe: "Print the explorer URL to stdout",
          })
          .option("stop", {
            type: "boolean",
            describe: "Stop the running explorer server, if any",
          })
          .option("idle-timeout", {
            type: "string",
            describe:
              "Auto-exit after idle period (e.g. 30s, 5m, 1h). Default: 5m",
          })
          .option("no-idle-timeout", {
            type: "boolean",
            describe:
              "Keep the server running until an explicit stop or signal",
          })
          .option("foreground", {
            type: "boolean",
            describe:
              "Run the server in the foreground (useful for debugging / dev)",
          })
          .conflicts("idle-timeout", "no-idle-timeout"),
      async (args) => {
        exitCode = await cmdExplore({
          db: args.db,
          port: args.port,
          noOpen: args["no-open"] as boolean | undefined,
          printUrl: args["print-url"] as boolean | undefined,
          stop: args.stop as boolean | undefined,
          idleTimeoutRaw: args["idle-timeout"] as string | undefined,
          noIdleTimeout: args["no-idle-timeout"] as boolean | undefined,
          foreground: args.foreground as boolean | undefined,
        });
      },
    )

    .strict()
    .help()
    .alias("h", "help")
    // Prevent yargs from calling process.exit() directly — we return the exit
    // code ourselves so the bin wrapper can set process.exitCode cleanly.
    .exitProcess(false)
    .fail((msg, err) => {
      if (msg) {
        process.stderr.write(`token-tally: ${msg}\n`);
        process.stderr.write(`Run 'token-tally --help' for usage.\n`);
      } else if (err) {
        process.stderr.write(
          `token-tally: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      exitCode = 1;
    })
    .parseAsync();

  return exitCode;
}

// ---------------------------------------------------------------------------
// explore
// ---------------------------------------------------------------------------

async function cmdExplore(args: {
  db?: string;
  port?: number;
  noOpen?: boolean;
  printUrl?: boolean;
  stop?: boolean;
  idleTimeoutRaw?: string;
  noIdleTimeout?: boolean;
  foreground?: boolean;
}): Promise<number> {
  // Resolve idle timeout: --no-idle-timeout wins; "0" duration also maps to
  // null (no timeout) since an instantly-expiring server isn't useful.
  let idleTimeoutMs: number | null;
  if (args.noIdleTimeout) {
    idleTimeoutMs = null;
  } else {
    const raw = args.idleTimeoutRaw ?? "5m";
    let ms: number;
    try {
      ms = parseDurationMs(raw);
    } catch (err) {
      process.stderr.write(
        `${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }
    idleTimeoutMs = ms === 0 ? null : ms;
  }

  const options: ExploreOptions = {
    db: args.db,
    port: args.port,
    noOpen: args.noOpen,
    printUrl: args.printUrl,
    stop: args.stop,
    idleTimeoutMs,
    foreground: args.foreground,
  };

  // The store CLI is CommonJS; the web-explorer launcher is ESM (NodeNext).
  // TypeScript in CommonJS mode transpiles import() to require(), which cannot
  // load ESM modules. We use `new Function` to produce a native import() call
  // that Node.js executes as real ESM dynamic import at runtime.
  //
  // The launcher lives at:
  //   <repo>/clients/web-explorer/dist/server/launcher.js
  // Relative to this compiled file at:
  //   <repo>/store/dist/cli/index.js
  const launcherAbsPath = join(
    __dirname,
    "../../../clients/web-explorer/dist/server/launcher.js",
  );
  // pathToFileURL ensures the path works cross-platform (especially Windows).
  const launcherUrl = pathToFileURL(launcherAbsPath).href;

  try {
    // eslint-disable-next-line no-new-func
    const nativeImport = new Function("s", "return import(s)") as (
      s: string,
    ) => Promise<{ launch: (opts: ExploreOptions) => Promise<number> }>;
    const launcher = await nativeImport(launcherUrl);
    return await launcher.launch(options);
  } catch (err) {
    const code =
      err instanceof Error
        ? (err as NodeJS.ErrnoException).code
        : undefined;

    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
      process.stderr.write(
        "token-tally: Web explorer is not installed.\n" +
          "  Run `make install` with an explorer-capable client selected\n" +
          "  (macOS tray or Pi usage command).\n",
      );
      return 1;
    }

    process.stderr.write(
      `token-tally explore: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

// ---------------------------------------------------------------------------
// migrate
// ---------------------------------------------------------------------------

async function cmdMigrate(
  dbPathOverride: string | undefined,
): Promise<number> {
  const dbPath = dbPathOverride ?? defaultDatabasePath();

  // Ensure the parent directory exists so better-sqlite3 can create the file.
  mkdirSync(dirname(dbPath), { recursive: true });

  try {
    // AnalyticsWriter.open() runs migrations automatically on a fresh or
    // outdated database. We open it then immediately close it — the side
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
      `token-tally migrate: failed — ${err instanceof Error ? err.message : String(err)}\n`,
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
  recordType: string,
  jsonPayload: string,
  dbPathOverride: string | undefined,
): Promise<number> {
  if (!(VALID_RECORD_TYPES as ReadonlyArray<string>).includes(recordType)) {
    process.stderr.write(
      `token-tally record: unknown type '${recordType}'.\n` +
        `  Valid types: ${VALID_RECORD_TYPES.join(", ")}\n`,
    );
    return 1;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(jsonPayload);
  } catch (err) {
    process.stderr.write(
      `token-tally record: invalid JSON — ${err instanceof Error ? err.message : String(err)}\n`,
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
      `token-tally record: cannot open database — ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  try {
    const result = await dispatchRecord(
      writer,
      recordType as RecordType,
      payload,
    );
    await writer.close();
    // Print the resulting ID so callers can chain operations.
    if (result != null) {
      process.stdout.write(JSON.stringify(result) + "\n");
    }
    return 0;
  } catch (err) {
    await writer.close().catch(() => undefined);
    process.stderr.write(
      `token-tally record: write failed — ${err instanceof Error ? err.message : String(err)}\n`,
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
  payload: unknown,
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
  targetPath: string | undefined,
  dbPathOverride: string | undefined,
): Promise<number> {
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
      `token-tally ingest: ingested ${result.ingested} file(s) from ${targetPath}\n`,
    );
    return 0;
  }

  // Drain the default spool directory.
  const spoolDir = defaultSpoolDir();
  const result = await ingestDir(spoolDir, options);

  if (result.skipped > 0) {
    process.stdout.write(
      `token-tally ingest: skipped ${result.skipped} active spool file(s) (still open by a live writer).\n`,
    );
  }
  if (result.errors.length > 0) {
    for (const e of result.errors) {
      process.stderr.write(`token-tally ingest: ${e.file}: ${e.message}\n`);
    }
    // Partial success is still reported even when errors exist.
  }

  process.stdout.write(
    `token-tally ingest: ingested ${result.ingested} file(s) from ${spoolDir}\n`,
  );

  return result.errors.length > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

async function cmdDoctor(
  jsonMode: boolean,
  dbPathOverride: string | undefined,
): Promise<number> {
  const dbPath = dbPathOverride ?? defaultDatabasePath();
  const report = runDoctor(dbPath);

  if (jsonMode) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(formatDoctorReport(report) + "\n");
  }

  return report.status === "ok" ? 0 : 1;
}
