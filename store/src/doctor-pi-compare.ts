/**
 * Pi session-log comparison for doctor.
 *
 * This diagnostic compares ToTally's central DB against Pi's local JSONL
 * session logs over a bounded message timestamp window. It is intentionally
 * read-only and separate from import: the goal is to explain drift before a
 * repair or backfill is attempted.
 */

import Database from "better-sqlite3";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { defaultDatabasePath } from "./paths";
import { discoverPiSessions } from "./importers/pi-session-log/discovery";
import { parsePiSessionFile } from "./importers/pi-session-log/parser";
import { transformSessionEvents } from "./importers/pi-session-log/transformer";

const SAMPLE_SIZE = 10;

export type SessionLogCompareOptions = {
  dbPath?: string;
  /** Harnesses to compare. Omit or include "all" to run every supported source. */
  harnesses?: string[];
  /** UTC date YYYY-MM-DD or ISO instant. Defaults to 24 hours before --to/now. */
  from?: string;
  /** UTC date YYYY-MM-DD or ISO instant. Defaults to now. */
  to?: string;
  /** Pi sessions root override. */
  piSessionsPath?: string;
};

export type PiSessionLogCompareOptions = {
  dbPath?: string;
  sessionsPath?: string;
  /** UTC date YYYY-MM-DD or ISO instant. Defaults to 24 hours before --to/now. */
  from?: string;
  /** UTC date YYYY-MM-DD or ISO instant. Defaults to now. */
  to?: string;
};

export type SessionLogCompareReport = {
  dbPath: string;
  generatedAt: number;
  fromMs: number;
  toMs: number;
  fromIso: string;
  toIso: string;
  harnessesRequested: string[];
  harnessesCompared: string[];
  unsupportedHarnesses: string[];
  reports: PiSessionLogCompareReport[];
  status: "ok" | "warning" | "error";
};

export type PiSessionLogCompareTotals = {
  messages: number;
  pricedMessages: number;
  unknownMessages: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  billableTokens: number;
  totalTokens: number;
  costMicros: number;
};

export type PiSessionLogCompareReport = {
  dbPath: string;
  sessionsPath: string;
  generatedAt: number;
  fromMs: number;
  toMs: number;
  fromIso: string;
  toIso: string;
  filesDiscovered: number;
  filesWithMessages: number;
  parseErrors: number;
  db: PiSessionLogCompareTotals;
  logs: PiSessionLogCompareTotals;
  delta: PiSessionLogCompareTotals;
  missingInDb: {
    count: number;
    costMicros: number;
    totalTokens: number;
    sample: PiSessionLogCompareSample[];
  };
  extraInDb: {
    count: number;
    costMicros: number;
    totalTokens: number;
    sample: PiSessionLogCompareSample[];
  };
  duplicateIdsInLogs: {
    groups: number;
    extraRows: number;
    sample: Array<{ harnessMessageId: string; count: number }>;
  };
  duplicateIdsInDb: {
    groups: number;
    extraRows: number;
    sample: Array<{ harnessMessageId: string; count: number }>;
  };
  status: "ok" | "warning" | "error";
  error?: string;
};

type PiSessionLogCompareSample = {
  harnessMessageId: string;
  tsIso: string;
  modelId: string | null;
  totalTokens: number;
  costMicros: number;
  sessionFile?: string;
};

type CompareMessage = PiSessionLogCompareSample & {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costSource: string;
  /** llm_messages.id (UUID) for DB-sourced rows. */
  dbId?: string;
  /** Provider responseId for log-sourced rows (null when absent). */
  responseId?: string | null;
  /** Unix ms timestamp. */
  tsMs: number;
};

export function defaultPiSessionsPathForCompare(): string {
  return join(homedir(), ".pi", "agent", "sessions");
}

const SUPPORTED_HARNESSES = ["pi"];
const DEFAULT_COMPARE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function compareSessionLogs(options: SessionLogCompareOptions = {}): SessionLogCompareReport {
  const generatedAt = Date.now();
  const dbPath = options.dbPath ?? defaultDatabasePath();
  const range = resolveCompareRange(options.from, options.to, generatedAt);
  const requested = normalizeHarnesses(options.harnesses);
  const reports: PiSessionLogCompareReport[] = [];
  const unsupportedHarnesses = requested.filter((harness) => !SUPPORTED_HARNESSES.includes(harness));

  if (requested.includes("pi")) {
    reports.push(comparePiSessionLogs({
      dbPath,
      sessionsPath: options.piSessionsPath,
      from: range.fromIso,
      to: range.toIso,
    }));
  }

  const hasError = range.error != null || reports.some((report) => report.status === "error");
  const hasWarning = unsupportedHarnesses.length > 0 || reports.some((report) => report.status === "warning");

  return {
    dbPath,
    generatedAt,
    fromMs: range.fromMs,
    toMs: range.toMs,
    fromIso: range.fromIso,
    toIso: range.toIso,
    harnessesRequested: requested,
    harnessesCompared: reports.map(() => "pi"),
    unsupportedHarnesses,
    reports: range.error == null ? reports : [makeErrorReport(dbPath, defaultPiSessionsPathForCompare(), generatedAt, range.error)],
    status: hasError ? "error" : hasWarning ? "warning" : "ok",
  };
}

export function comparePiSessionLogs(
  options: PiSessionLogCompareOptions = {},
): PiSessionLogCompareReport {
  const generatedAt = Date.now();
  const dbPath = options.dbPath ?? defaultDatabasePath();
  const sessionsPath = options.sessionsPath ?? defaultPiSessionsPathForCompare();
  const range = resolveCompareRange(options.from, options.to, generatedAt);

  if (range.error != null) {
    return makeErrorReport(dbPath, sessionsPath, generatedAt, range.error);
  }

  const { fromMs, toMs } = range;

  if (!existsSync(dbPath)) {
    return makeErrorReport(dbPath, sessionsPath, generatedAt, `Database file not found: ${dbPath}`);
  }

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (err) {
    return makeErrorReport(
      dbPath,
      sessionsPath,
      generatedAt,
      `Cannot open database: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    const dbMessages = loadDbMessages(db, fromMs, toMs);
    const logResult = loadLogMessages(sessionsPath, fromMs, toMs);

    const missingInDb = diffMessages(logResult.messages, dbMessages);
    const extraInDb = diffMessages(dbMessages, logResult.messages);
    const dbDuplicateIds = duplicateIdSummary(dbMessages);
    const logDuplicateIds = duplicateIdSummary(logResult.messages);

    const status = missingInDb.length === 0 && extraInDb.length === 0 &&
      dbDuplicateIds.extraRows === 0 && logDuplicateIds.extraRows === 0 &&
      logResult.parseErrors === 0
      ? "ok"
      : "warning";

    return {
      dbPath,
      sessionsPath,
      generatedAt,
      fromMs,
      toMs,
      fromIso: new Date(fromMs).toISOString(),
      toIso: new Date(toMs).toISOString(),
      filesDiscovered: logResult.filesDiscovered,
      filesWithMessages: logResult.filesWithMessages,
      parseErrors: logResult.parseErrors,
      db: totalsFor(dbMessages),
      logs: totalsFor(logResult.messages),
      delta: subtractTotals(totalsFor(dbMessages), totalsFor(logResult.messages)),
      missingInDb: summarizeDiff(missingInDb),
      extraInDb: summarizeDiff(extraInDb),
      duplicateIdsInLogs: logDuplicateIds,
      duplicateIdsInDb: dbDuplicateIds,
      status,
    };
  } finally {
    db.close();
  }
}

function normalizeHarnesses(harnesses: string[] | undefined): string[] {
  if (harnesses == null || harnesses.length === 0) return [...SUPPORTED_HARNESSES];
  const normalized = harnesses
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value !== "");

  if (normalized.length === 0 || normalized.includes("all")) return [...SUPPORTED_HARNESSES];
  return Array.from(new Set(normalized));
}

function resolveCompareRange(
  from: string | undefined,
  to: string | undefined,
  nowMs: number,
): { fromMs: number; toMs: number; fromIso: string; toIso: string; error?: string } {
  const toMs = to == null ? nowMs : parseBoundMs(to);
  if (toMs == null) {
    return { fromMs: 0, toMs: 0, fromIso: "", toIso: "", error: `Invalid --to value: ${to}` };
  }

  const fromMs = from == null ? toMs - DEFAULT_COMPARE_WINDOW_MS : parseBoundMs(from);
  if (fromMs == null) {
    return { fromMs: 0, toMs: 0, fromIso: "", toIso: "", error: `Invalid --from value: ${from}` };
  }

  if (toMs <= fromMs) {
    return { fromMs, toMs, fromIso: new Date(fromMs).toISOString(), toIso: new Date(toMs).toISOString(), error: "--to must be later than --from" };
  }

  return {
    fromMs,
    toMs,
    fromIso: new Date(fromMs).toISOString(),
    toIso: new Date(toMs).toISOString(),
  };
}

function parseBoundMs(value: string): number | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const ms = Date.parse(`${value}T00:00:00Z`);
    return isNaN(ms) ? null : ms;
  }

  const ms = Date.parse(value);
  if (isNaN(ms)) return null;
  return ms;
}

function loadDbMessages(
  db: Database.Database,
  fromMs: number,
  toMs: number,
): CompareMessage[] {
  const rows = db
    .prepare(
      `SELECT
         m.id AS dbId,
         m.harness_message_id AS harnessMessageId,
         m.ts,
         m.model_id AS modelId,
         m.input_tokens AS inputTokens,
         m.output_tokens AS outputTokens,
         m.cache_read_tokens AS cacheReadTokens,
         m.cache_write_tokens AS cacheWriteTokens,
         m.cost_total_micros AS costMicros,
         m.cost_source AS costSource,
         s.session_file AS sessionFile
       FROM llm_messages m
       JOIN sessions s ON s.id = m.session_id
       WHERE m.harness_id = 'pi'
         AND m.ts >= ?
         AND m.ts < ?
       ORDER BY m.ts`
    )
    .all(fromMs, toMs) as Array<{
      dbId: string;
      harnessMessageId: string;
      ts: number;
      modelId: string | null;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      costMicros: number;
      costSource: string;
      sessionFile: string | null;
    }>;

  return rows.map((row) => makeMessage({
    dbId: row.dbId,
    harnessMessageId: row.harnessMessageId,
    tsMs: row.ts,
    modelId: row.modelId,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    costMicros: row.costMicros,
    costSource: row.costSource,
    sessionFile: row.sessionFile ?? undefined,
  }));
}

function loadLogMessages(
  sessionsPath: string,
  fromMs: number,
  toMs: number,
): {
  messages: CompareMessage[];
  filesDiscovered: number;
  filesWithMessages: number;
  parseErrors: number;
} {
  // Do not date-filter discovery by session start: long-running sessions can
  // start before the requested window and still contain in-window messages.
  const discovered = discoverPiSessions(sessionsPath);
  const messages: CompareMessage[] = [];
  let filesWithMessages = 0;
  let parseErrors = 0;

  for (const file of discovered) {
    const parsed = parsePiSessionFile(file.filePath);
    parseErrors += parsed.errors.length;
    const session = transformSessionEvents(file.filePath, parsed.events);
    let fileMessageCount = 0;

    for (const turn of session.turns) {
      for (const msg of turn.messages) {
        if (msg.isZeroCostSkip) continue;
        if (msg.tsMs < fromMs || msg.tsMs >= toMs) continue;

        messages.push(makeMessage({
          responseId: msg.responseId,
          harnessMessageId: msg.harnessMessageId,
          tsMs: msg.tsMs,
          modelId: msg.modelId,
          inputTokens: msg.inputTokens,
          outputTokens: msg.outputTokens,
          cacheReadTokens: msg.cacheReadTokens,
          cacheWriteTokens: msg.cacheWriteTokens,
          costMicros: msg.costTotalMicros,
          costSource: msg.costSource,
          sessionFile: file.filePath,
        }));
        fileMessageCount++;
      }
    }

    if (fileMessageCount > 0) filesWithMessages++;
  }

  return {
    messages,
    filesDiscovered: discovered.length,
    filesWithMessages,
    parseErrors,
  };
}

function makeMessage(input: {
  dbId?: string;
  responseId?: string | null;
  harnessMessageId: string;
  tsMs: number;
  modelId: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costMicros: number;
  costSource: string;
  sessionFile?: string;
}): CompareMessage {
  const totalTokens = input.inputTokens + input.outputTokens +
    input.cacheReadTokens + input.cacheWriteTokens;

  return {
    dbId: input.dbId,
    responseId: input.responseId,
    harnessMessageId: input.harnessMessageId,
    tsIso: new Date(input.tsMs).toISOString(),
    tsMs: input.tsMs,
    modelId: input.modelId,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cacheReadTokens: input.cacheReadTokens,
    cacheWriteTokens: input.cacheWriteTokens,
    totalTokens,
    costMicros: input.costMicros,
    costSource: input.costSource,
    sessionFile: input.sessionFile,
  };
}

function totalsFor(messages: CompareMessage[]): PiSessionLogCompareTotals {
  return messages.reduce<PiSessionLogCompareTotals>((totals, msg) => {
    totals.messages++;
    if (msg.costSource === "unknown") totals.unknownMessages++;
    else totals.pricedMessages++;
    totals.inputTokens += msg.inputTokens;
    totals.outputTokens += msg.outputTokens;
    totals.cacheReadTokens += msg.cacheReadTokens;
    totals.cacheWriteTokens += msg.cacheWriteTokens;
    totals.billableTokens += msg.inputTokens + msg.outputTokens;
    totals.totalTokens += msg.totalTokens;
    totals.costMicros += msg.costMicros;
    return totals;
  }, emptyTotals());
}

function emptyTotals(): PiSessionLogCompareTotals {
  return {
    messages: 0,
    pricedMessages: 0,
    unknownMessages: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    billableTokens: 0,
    totalTokens: 0,
    costMicros: 0,
  };
}

function subtractTotals(
  dbTotals: PiSessionLogCompareTotals,
  logTotals: PiSessionLogCompareTotals,
): PiSessionLogCompareTotals {
  return {
    messages: dbTotals.messages - logTotals.messages,
    pricedMessages: dbTotals.pricedMessages - logTotals.pricedMessages,
    unknownMessages: dbTotals.unknownMessages - logTotals.unknownMessages,
    inputTokens: dbTotals.inputTokens - logTotals.inputTokens,
    outputTokens: dbTotals.outputTokens - logTotals.outputTokens,
    cacheReadTokens: dbTotals.cacheReadTokens - logTotals.cacheReadTokens,
    cacheWriteTokens: dbTotals.cacheWriteTokens - logTotals.cacheWriteTokens,
    billableTokens: dbTotals.billableTokens - logTotals.billableTokens,
    totalTokens: dbTotals.totalTokens - logTotals.totalTokens,
    costMicros: dbTotals.costMicros - logTotals.costMicros,
  };
}

function diffMessages(
  expected: CompareMessage[],
  actual: CompareMessage[],
): CompareMessage[] {
  const actualCounts = countByMessageId(actual);
  const missing: CompareMessage[] = [];

  for (const msg of expected) {
    const remaining = actualCounts.get(msg.harnessMessageId) ?? 0;
    if (remaining > 0) {
      actualCounts.set(msg.harnessMessageId, remaining - 1);
      continue;
    }
    missing.push(msg);
  }

  return missing;
}

function countByMessageId(messages: CompareMessage[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const msg of messages) {
    counts.set(msg.harnessMessageId, (counts.get(msg.harnessMessageId) ?? 0) + 1);
  }
  return counts;
}

function summarizeDiff(messages: CompareMessage[]): {
  count: number;
  costMicros: number;
  totalTokens: number;
  sample: PiSessionLogCompareSample[];
} {
  return {
    count: messages.length,
    costMicros: messages.reduce((sum, msg) => sum + msg.costMicros, 0),
    totalTokens: messages.reduce((sum, msg) => sum + msg.totalTokens, 0),
    sample: messages.slice(0, SAMPLE_SIZE).map(toSample),
  };
}

function duplicateIdSummary(messages: CompareMessage[]): {
  groups: number;
  extraRows: number;
  sample: Array<{ harnessMessageId: string; count: number }>;
} {
  const counts = countByMessageId(messages);
  const duplicates = Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([harnessMessageId, count]) => ({ harnessMessageId, count }))
    .sort((a, b) => b.count - a.count);

  return {
    groups: duplicates.length,
    extraRows: duplicates.reduce((sum, duplicate) => sum + duplicate.count - 1, 0),
    sample: duplicates.slice(0, SAMPLE_SIZE),
  };
}

function toSample(msg: CompareMessage): PiSessionLogCompareSample {
  return {
    harnessMessageId: msg.harnessMessageId,
    tsIso: msg.tsIso,
    modelId: msg.modelId,
    totalTokens: msg.totalTokens,
    costMicros: msg.costMicros,
    sessionFile: msg.sessionFile,
  };
}

function makeErrorReport(
  dbPath: string,
  sessionsPath: string,
  generatedAt: number,
  error: string,
): PiSessionLogCompareReport {
  const totals = emptyTotals();
  return {
    dbPath,
    sessionsPath,
    generatedAt,
    fromMs: 0,
    toMs: 0,
    fromIso: "",
    toIso: "",
    filesDiscovered: 0,
    filesWithMessages: 0,
    parseErrors: 0,
    db: totals,
    logs: totals,
    delta: totals,
    missingInDb: { count: 0, costMicros: 0, totalTokens: 0, sample: [] },
    extraInDb: { count: 0, costMicros: 0, totalTokens: 0, sample: [] },
    duplicateIdsInLogs: { groups: 0, extraRows: 0, sample: [] },
    duplicateIdsInDb: { groups: 0, extraRows: 0, sample: [] },
    status: "error",
    error,
  };
}

export function formatSessionLogCompareReport(report: SessionLogCompareReport): string {
  const lines: string[] = [];
  lines.push(`ToTally doctor session-compare — ${report.dbPath}`);
  lines.push(`Window: ${report.fromIso} → ${report.toIso}`);
  lines.push(`Harnesses: requested=${report.harnessesRequested.join(", ")} compared=${report.harnessesCompared.join(", ") || "none"}`);
  if (report.unsupportedHarnesses.length > 0) {
    lines.push(`Unsupported harnesses: ${report.unsupportedHarnesses.join(", ")}`);
  }

  for (const harnessReport of report.reports) {
    lines.push("");
    lines.push(formatPiSessionLogCompareReport(harnessReport));
  }

  return lines.join("\n");
}

export function formatPiSessionLogCompareReport(report: PiSessionLogCompareReport): string {
  const lines: string[] = [];
  lines.push(`ToTally doctor pi-log-compare — ${report.dbPath}`);

  if (report.error != null) {
    lines.push(`✗ ${report.error}`);
    return lines.join("\n");
  }

  lines.push(`Window: ${report.fromIso} → ${report.toIso}`);
  lines.push(`Pi logs: ${report.sessionsPath}`);
  lines.push(`Files: ${report.filesWithMessages}/${report.filesDiscovered} with in-window messages; parse errors: ${report.parseErrors}`);
  lines.push("");
  lines.push(`            messages  total_tokens  billable_tokens  cost`);
  lines.push(`DB:      ${pad(report.db.messages)}  ${pad(report.db.totalTokens)}  ${pad(report.db.billableTokens)}  ${formatUsd(report.db.costMicros)}`);
  lines.push(`Logs:    ${pad(report.logs.messages)}  ${pad(report.logs.totalTokens)}  ${pad(report.logs.billableTokens)}  ${formatUsd(report.logs.costMicros)}`);
  lines.push(`Delta:   ${pad(report.delta.messages)}  ${pad(report.delta.totalTokens)}  ${pad(report.delta.billableTokens)}  ${formatUsd(report.delta.costMicros)}`);
  lines.push("");
  lines.push(`Missing in DB: ${report.missingInDb.count} message(s), ${report.missingInDb.totalTokens} token(s), ${formatUsd(report.missingInDb.costMicros)}`);
  lines.push(`Extra in DB:   ${report.extraInDb.count} message(s), ${report.extraInDb.totalTokens} token(s), ${formatUsd(report.extraInDb.costMicros)}`);
  lines.push(`Duplicate IDs in logs: ${report.duplicateIdsInLogs.extraRows} extra row(s) across ${report.duplicateIdsInLogs.groups} group(s)`);
  lines.push(`Duplicate IDs in DB:   ${report.duplicateIdsInDb.extraRows} extra row(s) across ${report.duplicateIdsInDb.groups} group(s)`);

  if (report.missingInDb.sample.length > 0) {
    lines.push("");
    lines.push("Missing in DB sample:");
    for (const sample of report.missingInDb.sample) {
      lines.push(`  ${sample.tsIso} ${sample.modelId ?? "(unknown)"} ${sample.harnessMessageId}`);
    }
  }

  if (report.extraInDb.sample.length > 0) {
    lines.push("");
    lines.push("Extra in DB sample:");
    for (const sample of report.extraInDb.sample) {
      lines.push(`  ${sample.tsIso} ${sample.modelId ?? "(unknown)"} ${sample.harnessMessageId}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Canonical ID repair
//
// Older live-writer versions recorded Pi assistant messages under synthesized
// IDs (`<session_file>:tN:mM`) even when the session log later carried the
// canonical provider responseId (msg_... / resp_...). This repair matches
// those synthesized DB rows to provider-ID log rows by payload and updates
// harness_message_id in place, so the same model call has one identity.
// ---------------------------------------------------------------------------

const CANONICAL_ID_MATCH_WINDOW_MS = 10 * 60 * 1000;
const REPAIR_SAMPLE_SIZE = 20;

export type PiCanonicalIdRepairOptions = PiSessionLogCompareOptions & {
  /** Apply the updates. Default false (dry-run). */
  apply?: boolean;
};

export type PiCanonicalIdRepairAction = {
  sessionFile: string | null;
  /** llm_messages.id (UUID) of the row being canonicalized. */
  dbMessageId: string;
  fromHarnessMessageId: string;
  toHarnessMessageId: string;
  tsIso: string;
  modelId: string | null;
  totalTokens: number;
  costMicros: number;
  /** |db ts - log ts| in milliseconds. */
  tsOffsetMs: number;
};

export type PiCanonicalIdRepairReport = {
  dbPath: string;
  sessionsPath: string;
  generatedAt: number;
  fromMs: number;
  toMs: number;
  fromIso: string;
  toIso: string;
  applied: boolean;
  /** Synthesized DB rows matched to a provider-ID log row. */
  matched: number;
  /** Rows actually updated (0 in dry-run). */
  updated: number;
  /** Guarded updates skipped because the provider ID already exists in the DB. */
  conflicts: number;
  /** Provider-ID log rows in the window with no payload match in the DB. */
  unmatchedMissingInDb: number;
  /** Synthesized DB rows in the window with no payload match in the logs. */
  unmatchedExtraInDb: number;
  matchedCostMicros: number;
  matchedTotalTokens: number;
  sample: PiCanonicalIdRepairAction[];
  status: "ok" | "warning" | "error";
  error?: string;
};

export function repairPiCanonicalIds(
  options: PiCanonicalIdRepairOptions = {},
): PiCanonicalIdRepairReport {
  const generatedAt = Date.now();
  const dbPath = options.dbPath ?? defaultDatabasePath();
  const sessionsPath = options.sessionsPath ?? defaultPiSessionsPathForCompare();
  const apply = options.apply === true;
  const range = resolveCompareRange(options.from, options.to, generatedAt);

  const fail = (error: string): PiCanonicalIdRepairReport => ({
    dbPath,
    sessionsPath,
    generatedAt,
    fromMs: range.fromMs,
    toMs: range.toMs,
    fromIso: range.fromIso,
    toIso: range.toIso,
    applied: false,
    matched: 0,
    updated: 0,
    conflicts: 0,
    unmatchedMissingInDb: 0,
    unmatchedExtraInDb: 0,
    matchedCostMicros: 0,
    matchedTotalTokens: 0,
    sample: [],
    status: "error",
    error,
  });

  if (range.error != null) return fail(range.error);
  if (!existsSync(dbPath)) return fail(`Database file not found: ${dbPath}`);

  let db: Database.Database;
  try {
    db = new Database(dbPath, apply ? undefined : { readonly: true });
    if (apply) {
      db.pragma("foreign_keys = ON");
      db.pragma("busy_timeout = 5000");
    }
  } catch (err) {
    return fail(`Cannot open database: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const dbMessages = loadDbMessages(db, range.fromMs, range.toMs);
    const logResult = loadLogMessages(sessionsPath, range.fromMs, range.toMs);

    const dbIdSet = new Set(dbMessages.map((m) => m.harnessMessageId));
    const logIdSet = new Set(logResult.messages.map((m) => m.harnessMessageId));

    // Provider-ID log rows absent from the DB.
    const missingProviderRows = logResult.messages.filter(
      (m) => m.responseId != null && !dbIdSet.has(m.harnessMessageId),
    );

    // Synthesized DB rows absent from the logs. Only IDs prefixed by their own
    // session file path are candidates — provider IDs are never renamed.
    const synthesizedDbRows = dbMessages.filter(
      (m) =>
        !logIdSet.has(m.harnessMessageId) &&
        m.sessionFile != null &&
        m.harnessMessageId.startsWith(`${m.sessionFile}:`),
    );

    // Bucket synthesized DB rows by payload identity.
    const buckets = new Map<string, CompareMessage[]>();
    for (const row of synthesizedDbRows) {
      const key = payloadKey(row);
      const bucket = buckets.get(key);
      if (bucket != null) bucket.push(row);
      else buckets.set(key, [row]);
    }

    // Greedy nearest-timestamp matching with one-consumption semantics.
    const actions: PiCanonicalIdRepairAction[] = [];
    let unmatchedMissing = 0;

    for (const logMsg of missingProviderRows) {
      const bucket = buckets.get(payloadKey(logMsg));
      let bestIdx = -1;
      let bestOffset = Number.POSITIVE_INFINITY;
      if (bucket != null) {
        for (let i = 0; i < bucket.length; i++) {
          const offset = Math.abs(bucket[i].tsMs - logMsg.tsMs);
          if (offset <= CANONICAL_ID_MATCH_WINDOW_MS && offset < bestOffset) {
            bestOffset = offset;
            bestIdx = i;
          }
        }
      }

      if (bucket == null || bestIdx === -1) {
        unmatchedMissing++;
        continue;
      }

      const dbRow = bucket.splice(bestIdx, 1)[0];
      actions.push({
        sessionFile: dbRow.sessionFile ?? null,
        dbMessageId: dbRow.dbId ?? "",
        fromHarnessMessageId: dbRow.harnessMessageId,
        toHarnessMessageId: logMsg.harnessMessageId,
        tsIso: dbRow.tsIso,
        modelId: dbRow.modelId,
        totalTokens: dbRow.totalTokens,
        costMicros: dbRow.costMicros,
        tsOffsetMs: bestOffset,
      });
    }

    const unmatchedExtra = Array.from(buckets.values())
      .reduce((sum, bucket) => sum + bucket.length, 0);

    // Apply guarded updates inside one transaction.
    let updated = 0;
    let conflicts = 0;
    if (apply && actions.length > 0) {
      const stmt = db.prepare(`
        UPDATE llm_messages
        SET harness_message_id = $newId
        WHERE id = $rowId
          AND NOT EXISTS (
            SELECT 1 FROM llm_messages
            WHERE harness_id = 'pi' AND harness_message_id = $newId
          )
      `);
      db.transaction(() => {
        for (const action of actions) {
          const result = stmt.run({
            rowId: action.dbMessageId,
            newId: action.toHarnessMessageId,
          });
          if (result.changes > 0) updated++;
          else conflicts++;
        }
      })();
    }

    return {
      dbPath,
      sessionsPath,
      generatedAt,
      fromMs: range.fromMs,
      toMs: range.toMs,
      fromIso: range.fromIso,
      toIso: range.toIso,
      applied: apply,
      matched: actions.length,
      updated,
      conflicts,
      unmatchedMissingInDb: unmatchedMissing,
      unmatchedExtraInDb: unmatchedExtra,
      matchedCostMicros: actions.reduce((sum, a) => sum + a.costMicros, 0),
      matchedTotalTokens: actions.reduce((sum, a) => sum + a.totalTokens, 0),
      sample: actions.slice(0, REPAIR_SAMPLE_SIZE),
      status: conflicts > 0 || logResult.parseErrors > 0 ? "warning" : "ok",
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

function payloadKey(msg: CompareMessage): string {
  return [
    msg.sessionFile ?? "",
    msg.modelId ?? "",
    msg.inputTokens,
    msg.outputTokens,
    msg.cacheReadTokens,
    msg.cacheWriteTokens,
    msg.costMicros,
  ].join("|");
}

export function formatPiCanonicalIdRepairReport(report: PiCanonicalIdRepairReport): string {
  const lines: string[] = [];
  const mode = report.applied ? "" : " [DRY RUN — no changes written]";
  lines.push(`ToTally doctor pi-canonical-id-repair — ${report.dbPath}${mode}`);

  if (report.error != null) {
    lines.push(`✗ ${report.error}`);
    return lines.join("\n");
  }

  lines.push(`Window: ${report.fromIso} → ${report.toIso}`);
  lines.push(`Pi logs: ${report.sessionsPath}`);
  lines.push("");
  lines.push(`Matched synthesized rows: ${report.matched} message(s), ${report.matchedTotalTokens} token(s), ${formatUsd(report.matchedCostMicros)}`);
  lines.push(report.applied
    ? `Updated: ${report.updated} row(s); conflicts skipped: ${report.conflicts}`
    : `Would update: ${report.matched} row(s) — re-run with --yes to apply`);
  lines.push(`Unmatched provider-ID log rows (likely not yet imported): ${report.unmatchedMissingInDb}`);
  lines.push(`Unmatched synthesized DB rows: ${report.unmatchedExtraInDb}`);

  if (report.sample.length > 0) {
    lines.push("");
    lines.push("Sample:");
    for (const action of report.sample) {
      lines.push(`  ${action.tsIso} ${action.modelId ?? "(unknown)"} ${action.fromHarnessMessageId} → ${action.toHarnessMessageId} (Δ${Math.round(action.tsOffsetMs / 1000)}s)`);
    }
  }

  return lines.join("\n");
}

function pad(value: number): string {
  return String(value).padStart(10, " ");
}

function formatUsd(micros: number): string {
  const sign = micros < 0 ? "-" : "";
  return `${sign}$${(Math.abs(micros) / 1_000_000).toFixed(6)}`;
}
