/**
 * CLI handler for `token-tally import legacy-pi`.
 *
 * Parses arguments and delegates to importLegacyPi() from the store library.
 * This file is intentionally thin: all business logic lives in the importer.
 *
 * Usage:
 *   token-tally import legacy-pi [--source <path>] [--db <path>]
 *
 * The --db flag is parsed globally by cli/index.ts and passed in as dbPathOverride.
 */

import { defaultLegacyPath, importLegacyPi } from "../src/importers/legacy-pi";
import type { LegacyImportResult } from "../src/importers/legacy-pi";

// ---------------------------------------------------------------------------
// CLI command
// ---------------------------------------------------------------------------

/**
 * Handles `token-tally import legacy-pi [--source <path>]`.
 *
 * Returns a process exit code: 0 on success, 1 on error.
 *
 * Exit-code policy for a missing source database:
 *   - Default source not found  → exit 0 with an informational message.
 *     Absence of the legacy DB is the normal state for users who have not
 *     previously run Pi; treating it as an error would break scripts that
 *     conditionally import.
 *   - Explicit --source not found → exit 1.
 *     The user named a file that should exist; its absence is an error.
 */
export async function cmdImportLegacyPi(
  args: string[],
  dbPathOverride: string | undefined
): Promise<number> {
  let sourcePath: string | undefined;
  const userSuppliedSource = parseSourceFlag(args);
  sourcePath = userSuppliedSource ?? undefined;

  const result = await importLegacyPi({
    sourcePath,
    dbPath: dbPathOverride,
  });

  if (!result.ok) {
    const isAbsenceError = result.error.includes("not found");

    if (!userSuppliedSource && isAbsenceError) {
      // Default path was absent — not an error for callers without Pi.
      process.stdout.write(
        `token-tally import legacy-pi: ${result.error}\n` +
          `  Default path: ${defaultLegacyPath()}\n` +
          `  Use --source <path> to specify a different file.\n`
      );
      return 0;
    }

    process.stderr.write(`token-tally import legacy-pi: ${result.error}\n`);
    return 1;
  }

  printImportSummary(result.result);
  return 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parses the --source flag from args.
 * Returns the value if found, null if the flag was not present.
 */
function parseSourceFlag(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--source") {
      const value = args[i + 1];
      if (value == null || value.startsWith("-")) {
        process.stderr.write(
          "token-tally import legacy-pi: --source requires a path argument.\n"
        );
        // Can't exit here (not in main); return empty string to cause a
        // downstream "not found" error, which is close enough.
        return "";
      }
      return value;
    }
  }
  return null;
}

function printImportSummary(r: LegacyImportResult): void {
  const maxAdded = Math.max(
    r.tables.sessions.added,
    r.tables.turns.added,
    r.tables.messages.added,
    r.tables.toolCalls.added
  );

  const suffix =
    maxAdded === 0
      ? " (all rows already present — import is idempotent)"
      : "";

  process.stdout.write(
    `token-tally import legacy-pi: import complete${suffix}.\n` +
      `  Source:     ${r.sourcePath}\n` +
      `  Central:    ${r.centralPath}\n` +
      `  Sessions:   ${r.tables.sessions.added} added  (${r.tables.sessions.legacy} in legacy)\n` +
      `  Turns:      ${r.tables.turns.added} added  (${r.tables.turns.legacy} in legacy)\n` +
      `  Messages:   ${r.tables.messages.added} added  (${r.tables.messages.legacy} in legacy)\n` +
      `  Tool calls: ${r.tables.toolCalls.added} added  (${r.tables.toolCalls.legacy} in legacy)\n`
  );
}
