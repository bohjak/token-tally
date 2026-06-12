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

import { spawn } from "child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { pathToFileURL } from "url";
import { cmdImportLegacyPi } from "./import-legacy-pi";
import { cmdImportPiSessions } from "./import-pi-sessions";
import { formatDoctorRepairReport, formatDoctorReport, repairDoctorFindings, runDoctor } from "../src/doctor";
import { ingestDir, ingestFile } from "../src/ingest";
import type { IngestOptions } from "../src/ingest";
import { defaultConfigDir, defaultDatabasePath, defaultSpoolDir, defaultStateDir } from "../src/paths";
import { promoteStaleActiveFiles } from "../src/spool";
import type { PromoteResult } from "../src/spool";
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
// Daemon state (written to ~/.local/state/token-tally/daemon.json)
// ---------------------------------------------------------------------------

/**
 * Observability snapshot persisted by the running daemon.
 * Read by `token-tally daemon --status` and available for external tooling.
 */
type DaemonState = {
  /** Schema version for forward compatibility. */
  version: 1;
  daemon: {
    /** ISO timestamp when this daemon process started. */
    startedAt: string;
    /** OS process ID. */
    pid: number;
    /** Milliseconds since daemon started. */
    uptimeMs: number;
    /** Total drain passes completed since start. */
    passCount: number;
    /** ISO timestamp of the most recent pass, or null before the first pass. */
    lastPassAt: string | null;
    /** Wall-clock duration of the most recent pass in milliseconds, or null. */
    lastPassDurationMs: number | null;
  };
  spool: {
    /** Closed spool file count as of the most recent state write. */
    depth: number;
    /** Closed file count before the most recent pass began. */
    depthBeforeLastPass: number;
    /** Closed file count after the most recent pass finished. */
    depthAfterLastPass: number;
    /** Active files promoted to .closed in the most recent pass. */
    promotedLastPass: number;
  };
  drain: {
    /** Total spool files successfully drained and deleted since daemon start. */
    totalDrained: number;
    /** Total drain errors (ingest failures) since daemon start. */
    totalErrors: number;
    /** Total files skipped by drain bounds (maxFiles/maxMs) since daemon start. */
    totalSkippedByBound: number;
    /** Total active files promoted to .closed since daemon start. */
    totalPromoted: number;
  };
  errors: {
    /** Most recent error message, or null. */
    lastError: string | null;
    /** ISO timestamp of the most recent error, or null. */
    lastErrorAt: string | null;
    /**
     * DB connection status as of the most recent pass.
     * 'ok' = drain succeeded with no errors.
     * 'error' = drain reported at least one ingest error.
     * 'unknown' = no pass has run yet.
     */
    dbStatus: 'ok' | 'error' | 'unknown';
  };
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
        y
          .positional("path", {
            type: "string",
            describe:
              "File or directory to ingest. Omit to drain the default spool directory.",
          })
          .option("max-files", {
            type: "number",
            describe:
              "Maximum number of spool files to drain in one pass. " +
              "Remaining files are left for the next run or the daemon.",
          })
          .option("max-time", {
            type: "string",
            describe:
              "Maximum wall-clock time budget for the drain pass " +
              "(e.g. 30s, 5m, 1h). Remaining files are left for the next run or the daemon.",
          }),
      async (args) => {
        exitCode = await cmdIngest(
          args.path,
          args.db,
          args["max-files"],
          args["max-time"],
        );
      },
    )

    // ── doctor ───────────────────────────────────────────────────────────
    .command(
      "doctor",
      "Run diagnostic checks and report database health.",
      (y) =>
        y
          .option("json", {
            type: "boolean",
            describe:
              "Output machine-readable JSON. Exits non-zero when errors are found.",
          })
          .option("repair", {
            type: "boolean",
            describe:
              "Preview safe repairs for duplicate records and stale sessions. Dry-run unless --yes is also passed.",
          })
          .option("yes", {
            type: "boolean",
            describe: "Apply --repair changes. Without this flag, repair is a dry-run.",
          }),
      async (args) => {
        exitCode = await cmdDoctor(args.json === true, args.db, args.repair === true, args.yes === true);
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
            choices: ["legacy-pi", "pi-sessions"] as const,
            demandOption: true,
            describe: "Importer name",
          })
          .option("source", {
            type: "string",
            describe:
              "[legacy-pi] Path to the source database. Default: ~/.pi/analytics/events.db",
          })
          .option("path", {
            type: "string",
            describe:
              "[pi-sessions] Sessions root directory. Default: ~/.pi/agent/sessions",
          })
          .option("from", {
            type: "string",
            describe:
              "[pi-sessions] Import sessions starting on/after this UTC date (YYYY-MM-DD, inclusive).",
          })
          .option("to", {
            type: "string",
            describe:
              "[pi-sessions] Import sessions starting before this UTC date (YYYY-MM-DD, exclusive).",
          })
          .option("until", {
            type: "string",
            describe:
              "[pi-sessions] Skip individual messages with timestamp >= this ISO-8601 instant (boundary cutoff).",
          })
          .option("dry-run", {
            type: "boolean",
            describe:
              "[pi-sessions] Parse and report without writing to the database.",
          })
          .epilog(
            "Importers:\n" +
              "  legacy-pi    Import from the legacy Pi analytics database.\n" +
              "               Idempotent: repeat runs produce no duplicate rows.\n" +
              "               The source database is never modified or deleted.\n\n" +
              "  pi-sessions  Import from Pi session log files (~/.pi/agent/sessions/).\n" +
              "               --from / --to are UTC day bounds; --to is exclusive.\n" +
              "               Use --until <ISO-ts> as a boundary cutoff (e.g. writer re-enable instant).\n" +
              "               Use --dry-run to preview without writing.",
          ),
      async (args) => {
        if (args.importer === "legacy-pi") {
          // cmdImportLegacyPi still expects a raw args array; reconstruct one
          // from the yargs-parsed values.
          const importArgs = args.source ? ["--source", args.source] : [];
          exitCode = await cmdImportLegacyPi(importArgs, args.db);
        } else if (args.importer === "pi-sessions") {
          exitCode = await cmdImportPiSessions({
            path: args.path as string | undefined,
            from: args.from as string | undefined,
            to: args.to as string | undefined,
            until: args.until as string | undefined,
            dryRun: (args["dry-run"] as boolean | undefined) ?? false,
            db: args.db,
          });
        } else {
          // yargs' choices validation prevents reaching this branch at runtime,
          // but TypeScript doesn't know that.
          process.stderr.write(
            `token-tally import: unknown importer '${String(args.importer)}'.\n` +
              "  Available importers: legacy-pi, pi-sessions\n",
          );
          exitCode = 1;
        }
      },
    )

    // ── daemon ───────────────────────────────────────────────────────────
    .command(
      "daemon",
      [
        "Run the drain daemon (promotes stale spool files and persists events to the database).",
        "",
        "The daemon runs in the foreground in a loop, calling ingest at the configured",
        "interval. Use Ctrl-C or SIGTERM to stop it. Daemon state is written to",
        "~/.local/state/token-tally/daemon.json for observability.",
        "",
        "The installer registers the daemon with launchd (macOS) or systemd (Linux)",
        "so it starts at login and restarts on crash.",
        "",
        "For one-shot manual draining: token-tally ingest [--max-files N] [--max-time 5m]",
      ].join("\n"),
      (y) =>
        y
          .option("interval", {
            type: "string",
            default: "30s",
            describe:
              "How often to run a drain pass (e.g. 30s, 1m, 5m). " +
              "The daemon sleeps this long between passes.",
          })
          .option("max-files", {
            type: "number",
            describe:
              "Maximum number of closed spool files to drain per pass. " +
              "Remaining files are left for subsequent passes.",
          })
          .option("max-time", {
            type: "string",
            describe:
              "Maximum wall-clock time budget per drain pass (e.g. 30s, 5m). " +
              "The check happens before each file; an in-progress file always completes.",
          })
          .option("min-age", {
            type: "string",
            default: "5m",
            describe:
              "Minimum file mtime age before a dead-PID active spool file may be " +
              "promoted to .closed (e.g. 5m, 1h). Guards against PID reuse.",
          })
          .option("status", {
            type: "boolean",
            describe:
              "Print current daemon state from the state file and exit " +
              "(does not start or interact with a running daemon).",
          }),
      async (args) => {
        exitCode = await cmdDaemon({
          dbPath: args.db,
          intervalRaw: args.interval as string,
          maxFiles: args["max-files"] as number | undefined,
          maxTimeRaw: args["max-time"] as string | undefined,
          minAgeRaw: args["min-age"] as string,
          showStatus: args.status === true,
        });
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

type InstallManifest = {
  repoPath?: unknown;
  nodePath?: unknown;
  components?: {
    store?: {
      nodePath?: unknown;
    };
    webExplorer?: {
      distServerPath?: unknown;
    };
  };
};

function readInstallManifest(): InstallManifest | null {
  const manifestPath = join(defaultConfigDir(), "install.json");
  if (!existsSync(manifestPath)) return null;

  try {
    return JSON.parse(readFileSync(manifestPath, "utf-8")) as InstallManifest;
  } catch {
    return null;
  }
}

function resolveExplorerLauncherPath(): string | null {
  // Development / source checkout path. This is correct when running through
  // store/bin/token-tally.js or workspace scripts.
  const sourceLauncherPath = join(
    __dirname,
    "../../../clients/web-explorer/dist/server/launcher.js",
  );
  if (existsSync(sourceLauncherPath)) return sourceLauncherPath;

  // Installed SEA path. The web explorer is still built in the source checkout
  // because its server imports package dependencies from the workspace. Use the
  // install manifest to find that checkout when __dirname points inside the SEA
  // executable rather than store/dist/cli.
  const manifest = readInstallManifest();
  const distServerPath = manifest?.components?.webExplorer?.distServerPath;
  if (typeof distServerPath === "string") {
    const manifestLauncherPath = join(dirname(distServerPath), "launcher.js");
    if (existsSync(manifestLauncherPath)) return manifestLauncherPath;
  }

  const repoPath = manifest?.repoPath;
  if (typeof repoPath === "string") {
    const manifestLauncherPath = join(
      repoPath,
      "clients/web-explorer/dist/server/launcher.js",
    );
    if (existsSync(manifestLauncherPath)) return manifestLauncherPath;
  }

  return null;
}

function resolveSourceCliPath(): string | null {
  const manifest = readInstallManifest();
  const repoPath = manifest?.repoPath;
  if (typeof repoPath !== "string") return null;

  const sourceCliPath = join(repoPath, "store/bin/token-tally.js");
  if (existsSync(sourceCliPath)) return sourceCliPath;

  return null;
}

function buildExploreArgv(args: {
  db?: string;
  port?: number;
  noOpen?: boolean;
  printUrl?: boolean;
  stop?: boolean;
  idleTimeoutRaw?: string;
  noIdleTimeout?: boolean;
  foreground?: boolean;
}): string[] {
  const argv = ["explore"];
  if (args.db !== undefined) argv.push("--db", args.db);
  if (args.port !== undefined) argv.push("--port", String(args.port));
  if (args.noOpen === true) argv.push("--no-open");
  if (args.printUrl === true) argv.push("--print-url");
  if (args.stop === true) argv.push("--stop");
  if (args.idleTimeoutRaw !== undefined) argv.push("--idle-timeout", args.idleTimeoutRaw);
  if (args.noIdleTimeout === true) argv.push("--no-idle-timeout");
  if (args.foreground === true) argv.push("--foreground");
  return argv;
}

function resolveNodePath(): string {
  const override = process.env["TOKEN_TALLY_NODE"];
  if (override !== undefined && override !== "") return override;

  const manifest = readInstallManifest();
  const storeNodePath = manifest?.components?.store?.nodePath;
  if (typeof storeNodePath === "string" && storeNodePath !== "") return storeNodePath;

  const nodePath = manifest?.nodePath;
  if (typeof nodePath === "string" && nodePath !== "") return nodePath;

  return "node";
}

async function runSourceExploreCli(sourceCliPath: string, argv: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(resolveNodePath(), [sourceCliPath, ...argv], {
      stdio: "inherit",
    });
    child.on("error", (err) => {
      process.stderr.write(
        `token-tally explore: could not launch source CLI — ${err.message}\n`,
      );
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      if (code !== null) {
        resolve(code);
        return;
      }
      process.stderr.write(`token-tally explore: source CLI exited via ${signal}\n`);
      resolve(1);
    });
  });
}

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

  const sourceCliPath = resolveSourceCliPath();
  if (sourceCliPath !== null && basename(process.execPath) === "token-tally") {
    return await runSourceExploreCli(sourceCliPath, buildExploreArgv(args));
  }

  const launcherAbsPath = resolveExplorerLauncherPath();
  if (launcherAbsPath === null) {
    process.stderr.write(
      "token-tally: Web explorer is not installed.\n" +
        "  Run `make install` with an explorer-capable client selected\n" +
        "  (macOS tray or Pi usage command).\n",
    );
    return 1;
  }

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
  // NOTE: AnalyticsWriter.open() is called without drain options here, so no
  // full-directory spool scan is performed on `record`. The drain daemon (T6)
  // is responsible for draining accumulated spool files out-of-process.
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
    // No drain options — hot-path one-shot writes must not scan the spool dir.
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
  maxFiles: number | undefined,
  maxTimeRaw: string | undefined,
): Promise<number> {
  const dbPath = dbPathOverride ?? defaultDatabasePath();

  // Parse the wall-clock budget, if provided.
  let maxMs: number | undefined;
  if (maxTimeRaw != null) {
    try {
      maxMs = parseDurationMs(maxTimeRaw);
    } catch (err) {
      process.stderr.write(
        `token-tally ingest: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }
  }

  const options: IngestOptions = {
    dbPath,
    harnessName: "token-tally-cli",
    maxFiles,
    maxMs,
  };

  if (targetPath != null) {
    // Route to directory or single-file ingest depending on what targetPath is.
    let isDirectory = false;
    try {
      isDirectory = statSync(targetPath).isDirectory();
    } catch {
      // Non-existent path — let ingestFile produce the "File not found" error.
    }

    if (isDirectory) {
      return cmdIngestDir(targetPath, options);
    }

    // Single-file ingest: drains exactly the specified file. Does NOT scan
    // the default spool directory as a side effect.
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

  // No path given — drain the default spool directory.
  return cmdIngestDir(defaultSpoolDir(), options);
}

/**
 * Drains a directory of closed spool files and prints a human-readable
 * summary. Shared between the no-path and directory-path ingest flows.
 */
async function cmdIngestDir(
  dir: string,
  options: IngestOptions,
): Promise<number> {
  const result = await ingestDir(dir, options);

  if (result.skipped > 0) {
    process.stdout.write(
      `token-tally ingest: skipped ${result.skipped} active spool file(s) (still open by a live writer).\n`,
    );
  }
  if (result.skippedByBound > 0) {
    process.stdout.write(
      `token-tally ingest: hit limit — ${result.skippedByBound} file(s) not yet attempted; re-run or wait for the daemon.\n`,
    );
  }
  if (result.errors.length > 0) {
    for (const e of result.errors) {
      process.stderr.write(`token-tally ingest: ${e.file}: ${e.message}\n`);
    }
    // Partial success is still reported even when errors exist.
  }

  process.stdout.write(
    `token-tally ingest: ingested ${result.ingested} file(s) from ${dir}\n`,
  );

  return result.errors.length > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

async function cmdDoctor(
  jsonMode: boolean,
  dbPathOverride: string | undefined,
  repairMode: boolean,
  applyRepair: boolean,
): Promise<number> {
  const dbPath = dbPathOverride ?? defaultDatabasePath();

  if (repairMode) {
    const report = repairDoctorFindings(dbPath, applyRepair);
    if (jsonMode) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } else {
      process.stdout.write(formatDoctorRepairReport(report) + "\n");
    }
    return report.status === "ok" ? 0 : 1;
  }

  const report = runDoctor(dbPath);

  if (jsonMode) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(formatDoctorReport(report) + "\n");
  }

  return report.status === "ok" ? 0 : 1;
}

// ---------------------------------------------------------------------------
// daemon
// ---------------------------------------------------------------------------

/**
 * Sleeps for `ms` milliseconds, but checks the `isStopped` callback every
 * 200 ms so the daemon can exit promptly on SIGTERM/SIGINT without waiting
 * for the full interval to elapse.
 */
function sleepInterruptible(
  ms: number,
  isStopped: () => boolean,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let elapsed = 0;
    const TICK_MS = 200;
    const tick = () => {
      if (isStopped() || elapsed >= ms) {
        resolve();
        return;
      }
      elapsed += TICK_MS;
      setTimeout(tick, Math.min(TICK_MS, ms - elapsed + TICK_MS));
    };
    setTimeout(tick, Math.min(TICK_MS, ms));
  });
}

async function cmdDaemon(args: {
  dbPath?: string;
  intervalRaw: string;
  maxFiles?: number;
  maxTimeRaw?: string;
  minAgeRaw: string;
  showStatus: boolean;
}): Promise<number> {
  const stateDir = defaultStateDir();
  const stateFile = join(stateDir, "daemon.json");

  // ── --status mode: read and print state file then exit ─────────────────
  if (args.showStatus) {
    if (!existsSync(stateFile)) {
      process.stdout.write(
        "token-tally daemon: no state file found — daemon does not appear to be running.\n" +
          `  Expected: ${stateFile}\n`,
      );
      return 1;
    }
    try {
      const raw = readFileSync(stateFile, "utf8");
      process.stdout.write(raw + "\n");
      return 0;
    } catch (err) {
      process.stderr.write(
        `token-tally daemon: cannot read state file: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }
  }

  // ── Parse CLI options ───────────────────────────────────────────────────
  let intervalMs: number;
  try {
    intervalMs = parseDurationMs(args.intervalRaw);
    if (intervalMs <= 0) throw new Error("--interval must be > 0");
  } catch (err) {
    process.stderr.write(
      `token-tally daemon: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  let maxMs: number | undefined;
  if (args.maxTimeRaw != null) {
    try {
      maxMs = parseDurationMs(args.maxTimeRaw);
    } catch (err) {
      process.stderr.write(
        `token-tally daemon: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }
  }

  let minAgeMs: number;
  try {
    minAgeMs = parseDurationMs(args.minAgeRaw);
  } catch (err) {
    process.stderr.write(
      `token-tally daemon: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  const spoolDir = defaultSpoolDir();
  const dbPath = args.dbPath ?? defaultDatabasePath();
  const startedAt = new Date();
  mkdirSync(stateDir, { recursive: true });

  // ── Observability state (written to daemon.json after every pass) ───────
  let passCount = 0;
  let totalDrained = 0;
  let totalErrors = 0;
  let totalSkippedByBound = 0;
  let totalPromoted = 0;
  let lastPassAt: string | null = null;
  let lastPassDurationMs: number | null = null;
  let depthBeforeLastPass = 0;
  let depthAfterLastPass = 0;
  let promotedLastPass = 0;
  let lastError: string | null = null;
  let lastErrorAt: string | null = null;
  let dbStatus: "ok" | "error" | "unknown" = "unknown";

  const countClosedFiles = (): number => {
    try {
      if (!existsSync(spoolDir)) return 0;
      return readdirSync(spoolDir).filter((f) => f.endsWith(".ndjson.closed")).length;
    } catch {
      return 0;
    }
  };

  const writeState = (): void => {
    const state: DaemonState = {
      version: 1,
      daemon: {
        startedAt: startedAt.toISOString(),
        pid: process.pid,
        uptimeMs: Date.now() - startedAt.getTime(),
        passCount,
        lastPassAt,
        lastPassDurationMs,
      },
      spool: {
        depth: countClosedFiles(),
        depthBeforeLastPass,
        depthAfterLastPass,
        promotedLastPass,
      },
      drain: {
        totalDrained,
        totalErrors,
        totalSkippedByBound,
        totalPromoted,
      },
      errors: {
        lastError,
        lastErrorAt,
        dbStatus,
      },
    };
    try {
      writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n", "utf8");
    } catch {
      // Non-fatal: observability failure must never kill the drain loop.
    }
  };

  // ── Signal handling ─────────────────────────────────────────────────────
  let stopped = false;
  const onStop = (): void => {
    stopped = true;
  };
  process.on("SIGTERM", onStop);
  process.on("SIGINT", onStop);

  // ── Startup banner ──────────────────────────────────────────────────────
  process.stdout.write(
    `token-tally daemon: started (pid=${process.pid}, interval=${args.intervalRaw})\n` +
      `token-tally daemon: spool dir: ${spoolDir}\n` +
      `token-tally daemon: state file: ${stateFile}\n` +
      `token-tally daemon: Press Ctrl-C or send SIGTERM to stop.\n`,
  );

  writeState();

  // ── Main drain loop ─────────────────────────────────────────────────────
  while (!stopped) {
    const passStart = Date.now();

    // Step 1: Promote dead-PID stale active files → .closed
    //
    // This runs first so the drain step below can pick up any newly-closed
    // files in the same pass.
    let promoteResult: PromoteResult = { promoted: [], skipped: [] };
    try {
      promoteResult = promoteStaleActiveFiles(spoolDir, { minAgeMs });
      if (promoteResult.promoted.length > 0) {
        process.stdout.write(
          `token-tally daemon: promoted ${promoteResult.promoted.length} stale active file(s) to .closed\n`,
        );
      }
      // Log skipped-with-details only when there was at least one skip reason
      // worth surfacing (i.e. not just "pid still alive").
      const interestingSkips = promoteResult.skipped.filter(
        (s) => !s.reason.startsWith("PID") || s.reason.includes("too recent"),
      );
      for (const s of interestingSkips) {
        process.stdout.write(
          `token-tally daemon: skipped active file '${s.file}': ${s.reason}\n`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`token-tally daemon: promote step failed: ${msg}\n`);
      lastError = `promote: ${msg}`;
      lastErrorAt = new Date().toISOString();
    }
    promotedLastPass = promoteResult.promoted.length;
    totalPromoted += promotedLastPass;

    // Step 2: Drain closed spool files (bounded by maxFiles / maxMs)
    depthBeforeLastPass = countClosedFiles();
    try {
      const drainResult = await ingestDir(spoolDir, {
        dbPath,
        maxFiles: args.maxFiles,
        maxMs,
      });

      totalDrained += drainResult.ingested;
      totalErrors += drainResult.errors.length;
      totalSkippedByBound += drainResult.skippedByBound;

      if (drainResult.errors.length > 0) {
        dbStatus = "error";
        for (const e of drainResult.errors) {
          const msg = `drain error on ${e.file}: ${e.message}`;
          process.stderr.write(`token-tally daemon: ${msg}\n`);
          lastError = msg;
          lastErrorAt = new Date().toISOString();
        }
      } else {
        dbStatus = "ok";
      }

      if (drainResult.ingested > 0) {
        process.stdout.write(
          `token-tally daemon: drained ${drainResult.ingested} file(s)\n`,
        );
      }
      if (drainResult.skippedByBound > 0) {
        process.stdout.write(
          `token-tally daemon: ${drainResult.skippedByBound} file(s) hit bound — will retry\n`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`token-tally daemon: drain pass failed: ${msg}\n`);
      lastError = `drain: ${msg}`;
      lastErrorAt = new Date().toISOString();
      dbStatus = "error";
    }
    depthAfterLastPass = countClosedFiles();

    passCount++;
    lastPassAt = new Date().toISOString();
    lastPassDurationMs = Date.now() - passStart;
    writeState();

    // Sleep until the next pass, waking early on SIGTERM/SIGINT.
    await sleepInterruptible(intervalMs, () => stopped);
  }

  // ── Clean shutdown ──────────────────────────────────────────────────────
  process.stdout.write(
    `token-tally daemon: stopped after ${passCount} pass(es), ` +
      `${totalDrained} file(s) drained, ${totalErrors} error(s)\n`,
  );

  // Remove the state file so --status reports "not running" after clean exit.
  try {
    if (existsSync(stateFile)) unlinkSync(stateFile);
  } catch {
    // Non-fatal.
  }

  return 0;
}
