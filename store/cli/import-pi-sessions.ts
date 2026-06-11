/**
 * CLI handler for `token-tally import pi-sessions`.
 *
 * Parses arguments and delegates to importPiSessionLogs() from the store library.
 * All business logic lives in the importer.
 *
 * Usage:
 *   token-tally import pi-sessions [--path <dir>] [--from YYYY-MM-DD]
 *     [--to YYYY-MM-DD] [--until <iso-ts>] [--dry-run] [--db <path>]
 *
 * --from / --to are UTC day bounds (--to is exclusive).
 * --until is an ISO-8601 instant; messages with ts >= until are skipped.
 * --dry-run parses and reports without writing to the database.
 * --db is the global flag handled by cli/index.ts.
 */

import {
  defaultPiSessionsPath,
  importPiSessionLogs,
} from "../src/importers/pi-session-log/importer";
import type {
  PiSessionImportResult,
  SessionImportResult,
} from "../src/importers/pi-session-log/types";

// ---------------------------------------------------------------------------
// Public CLI handler
// ---------------------------------------------------------------------------

export interface PiSessionsCliArgs {
  path?: string;
  from?: string;
  to?: string;
  until?: string;
  dryRun?: boolean;
  db?: string;
}

/**
 * Handles `token-tally import pi-sessions [options]`.
 * Returns a process exit code (0 = success, 1 = error).
 */
export async function cmdImportPiSessions(
  args: PiSessionsCliArgs,
): Promise<number> {
  const result = await importPiSessionLogs({
    sessionsPath: args.path,
    from: args.from,
    to: args.to,
    until: args.until,
    dryRun: args.dryRun ?? false,
    dbPath: args.db,
  });

  if (!result.ok) {
    process.stderr.write(`token-tally import pi-sessions: ${result.error}\n`);
    return 1;
  }

  printImportReport(result.result);
  return 0;
}

// ---------------------------------------------------------------------------
// Report printer
// ---------------------------------------------------------------------------

function printImportReport(r: PiSessionImportResult): void {
  const mode = r.dryRun ? " [DRY RUN — no changes written]" : "";
  process.stdout.write(`\ntoken-tally import pi-sessions${mode}\n`);
  process.stdout.write(`  DB: ${r.dbPath}\n`);
  process.stdout.write(`  Sessions discovered: ${r.sessions.length}\n\n`);

  for (const s of r.sessions) {
    printSessionSummary(s);
  }

  const t = r.totals;
  const totalUsd = (t.importedCostMicros / 1_000_000).toFixed(6);
  const replayUsd = (t.replaySkippedCostMicros / 1_000_000).toFixed(6);
  const boundaryUsd = (t.boundarySkippedCostMicros / 1_000_000).toFixed(6);
  const cutoffUsd = (t.cutoffSkippedCostMicros / 1_000_000).toFixed(6);
  const subagentUsd = (t.subagentImportedCostMicros / 1_000_000).toFixed(6);

  process.stdout.write("─".repeat(60) + "\n");
  process.stdout.write(`Run totals:\n`);
  process.stdout.write(
    `  imported:          ${t.imported} messages  ($${totalUsd})\n`,
  );
  process.stdout.write(
    `  replays_skipped:   ${t.replaysSkipped} messages  ($${replayUsd})\n`,
  );
  process.stdout.write(
    `  zero_cost_skipped: ${t.zeroCostSkipped} messages\n`,
  );
  process.stdout.write(
    `  boundary_skipped:  ${t.boundarySkipped} messages  ($${boundaryUsd})\n`,
  );
  process.stdout.write(
    `  cutoff_skipped:    ${t.cutoffSkipped} messages  ($${cutoffUsd})\n`,
  );
  process.stdout.write(
    `  total_parsed:      ${t.totalParsedAssistantUsage} assistant messages with usage\n`,
  );
  process.stdout.write(
    `  subagent cost:     $${subagentUsd} (of imported)\n`,
  );
  if (t.malformed > 0) {
    process.stdout.write(`  malformed lines:   ${t.malformed}\n`);
  }

  // Accounting identity check (for transparency).
  const identityCheck =
    t.imported +
    t.replaysSkipped +
    t.zeroCostSkipped +
    t.boundarySkipped +
    t.cutoffSkipped;
  if (identityCheck !== t.totalParsedAssistantUsage) {
    process.stderr.write(
      `\nWARNING: accounting identity mismatch: ` +
        `${identityCheck} != ${t.totalParsedAssistantUsage}\n`,
    );
  }
}

function printSessionSummary(s: SessionImportResult): void {
  const exists = s.existedInDb ? " [EXISTS in DB]" : " [new]";
  const subagent = s.isSubagent ? " [subagent]" : "";
  const importedUsd = (s.importedCostMicros / 1_000_000).toFixed(6);
  process.stdout.write(
    `  ${s.filePath}${subagent}${exists}\n` +
      `    start: ${s.sessionStartIso}  cwd: ${s.cwd ?? "(unknown)"}\n` +
      `    imported: ${s.counts.messagesImported} msgs ($${importedUsd})` +
      `  replay_skip: ${s.counts.messagesReplaySkipped}` +
      `  zero_cost: ${s.counts.messagesZeroCostSkipped}` +
      `  boundary: ${s.counts.messagesBoundarySkipped}` +
      `  cutoff: ${s.counts.messagesCutoffSkipped}` +
      `  tools: ${s.counts.toolCallsImported}\n`,
  );
}

// Export the default path helper so it's accessible from tests.
export { defaultPiSessionsPath };
