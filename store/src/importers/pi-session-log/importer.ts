/**
 * Pi session log importer — orchestration layer.
 *
 * DESIGN NOTES (per plan rev 2 §8)
 *
 * Write strategy:
 *   Follows the legacy-pi pattern: AnalyticsWriter.open()/close() only as a
 *   migration helper, then direct transactional SQLite writes. This prevents
 *   withDbOrSpool from silently spooling writes on contention.
 *
 * Transaction scope:
 *   One transaction per session (not one mega-transaction) to keep lock
 *   windows short while the live writer and drain daemon are running.
 *
 * Dedup — three classes (§6):
 *   (a) Fork/resume replays: first-occurrence-wins on responseId and
 *       toolCallId, enforced by a Set maintained across all files.
 *   (b) Spool-recovered rows: caught by boundary dedup (token quadruple).
 *   (c) Live-writer boundary overlap: per-session token-quadruple + model +
 *       cost matching against existing DB rows; one-consumption semantics.
 *
 * Counting:
 *   Uses better-sqlite3 `stmt.run().changes` (1 if inserted, 0 if skipped
 *   by INSERT OR IGNORE) rather than separate before/after queries — avoids
 *   extra reads while still being exact.
 *
 * Dry-run:
 *   Parses and transforms all sessions, loads existing DB rows for boundary
 *   dedup (if DB exists), but does not write any rows.
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { randomUUID } from "crypto";

import { defaultDatabasePath } from "../../paths";
import { AnalyticsWriter } from "../../writer";
import { parsePiSessionFile } from "./parser";
import { transformSessionEvents } from "./transformer";
import { discoverPiSessions } from "./discovery";
import { resolveGitMetadata } from "./git";
import type {
  DiscoveredFile,
  PiSessionImportOptions,
  PiSessionImportResult,
  SessionImportCounts,
  SessionImportResult,
  TransformedMessage,
  TransformedSession,
  TransformedTurn,
} from "./types";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const HARNESS_ID = "pi";
const IMPORT_INTEGRATION_VERSION = "pi-session-log-import-0.1.0";

/**
 * Default path for Pi session logs.
 */
export function defaultPiSessionsPath(): string {
  return join(homedir(), ".pi", "agent", "sessions");
}

/**
 * Imports Pi session logs into the central ToTally store.
 * Returns an error value (not a thrown exception) for expected failures.
 */
export async function importPiSessionLogs(
  options?: PiSessionImportOptions,
): Promise<{ ok: true; result: PiSessionImportResult } | { ok: false; error: string }> {
  const sessionsPath = options?.sessionsPath ?? defaultPiSessionsPath();
  const centralPath = options?.dbPath ?? defaultDatabasePath();
  const dryRun = options?.dryRun ?? false;
  const dateError = validateUtcDateOption("--from", options?.from)
    ?? validateUtcDateOption("--to", options?.to);
  if (dateError != null) return { ok: false, error: dateError };

  const untilMs = options?.until != null ? Date.parse(options.until) : null;
  if (options?.until != null && (untilMs == null || isNaN(untilMs ?? NaN))) {
    return { ok: false, error: `Invalid --until value: ${options.until}` };
  }

  // Discover session files.
  const discovered = discoverPiSessions(sessionsPath, {
    from: options?.from,
    to: options?.to,
  });

  if (discovered.length === 0) {
    return {
      ok: true,
      result: makeEmptyResult(dryRun, centralPath),
    };
  }

  // Ensure the DB exists and migrations are current.
  // AnalyticsWriter.open()/close() is used purely as a migration helper.
  if (!dryRun) {
    try {
      mkdirSync(dirname(centralPath), { recursive: true });
      const migWriter = await AnalyticsWriter.open({
        dbPath: centralPath,
        harnessName: "token-tally-import",
      });
      await migWriter.close();
    } catch (err) {
      return {
        ok: false,
        error: `Cannot prepare central database at ${centralPath}: ${errMsg(err)}`,
      };
    }
  }

  // Open central DB for reads (boundary dedup queries) and writes.
  // Dry-run opens read-only so previewing cannot mutate the DB or create WAL sidecars.
  let centralDb: Database.Database | null = null;
  if (existsSync(centralPath)) {
    try {
      centralDb = new Database(centralPath, dryRun ? { readonly: true } : undefined);
      centralDb.pragma("foreign_keys = ON");
      if (!dryRun) {
        centralDb.pragma("journal_mode = WAL");
        centralDb.pragma("synchronous = NORMAL");
        centralDb.pragma("busy_timeout = 5000");
      }
    } catch (err) {
      return {
        ok: false,
        error: `Cannot open central database: ${errMsg(err)}`,
      };
    }
  } else if (!dryRun) {
    return {
      ok: false,
      error: `Central database not found at ${centralPath} even after migration step.`,
    };
  }

  try {
    // Register harness once before session loop.
    if (!dryRun && centralDb != null) {
      upsertHarness(centralDb);
    }

    // Cross-file first-occurrence-wins dedup sets.
    const seenResponseIds = new Set<string>();
    const seenToolCallIds = new Set<string>();

    // If a lower date bound is set, excluded pre-window sessions may be the
    // first occurrence of replayed responseIds. Seed the replay sets from those
    // files so in-window forks/resumes do not double-count pre-window API calls.
    if (options?.from != null) {
      const preWindow = discoverPiSessions(sessionsPath, { to: options.from });
      seedSeenIdsFromSessions(preWindow, seenResponseIds, seenToolCallIds);
    }

    const sessionResults: SessionImportResult[] = [];

    for (const disc of discovered) {
      const sessionResult = await importOneSession(
        disc,
        centralDb,
        dryRun,
        untilMs,
        seenResponseIds,
        seenToolCallIds,
      );
      sessionResults.push(sessionResult);
    }

    return {
      ok: true,
      result: buildResult(dryRun, centralPath, sessionResults),
    };
  } finally {
    centralDb?.close();
  }
}

// ---------------------------------------------------------------------------
// Pre-window replay seed
// ---------------------------------------------------------------------------

function seedSeenIdsFromSessions(
  sessions: DiscoveredFile[],
  seenResponseIds: Set<string>,
  seenToolCallIds: Set<string>,
): void {
  for (const session of sessions) {
    const parsed = parsePiSessionFile(session.filePath);
    const transformed = transformSessionEvents(session.filePath, parsed.events);
    for (const turn of transformed.turns) {
      for (const msg of turn.messages) {
        if (msg.responseId != null) seenResponseIds.add(msg.responseId);
        for (const tc of msg.toolCalls) {
          seenToolCallIds.add(tc.harnessToolCallId);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Per-session import
// ---------------------------------------------------------------------------

async function importOneSession(
  disc: DiscoveredFile,
  centralDb: Database.Database | null,
  dryRun: boolean,
  untilMs: number | null,
  seenResponseIds: Set<string>,
  seenToolCallIds: Set<string>,
): Promise<SessionImportResult> {
  const { filePath, isSubagent, sessionStartIso } = disc;

  // Parse and transform.
  const parsed = parsePiSessionFile(filePath);
  const transformed = transformSessionEvents(filePath, parsed.events);

  // Check if this session already exists in the DB.
  const existingSession = centralDb != null
    ? lookupExistingSession(centralDb, filePath)
    : null;
  const existedInDb = existingSession != null;

  // Load existing messages and tool calls for boundary dedup.
  const availableDbMessages: DbMessage[] = existedInDb && centralDb != null
    ? loadExistingMessages(centralDb, existingSession.id)
    : [];
  const existingToolCallIds: Set<string> = existedInDb && centralDb != null
    ? loadExistingToolCallIds(centralDb, existingSession.id)
    : new Set();

  // Resolve git metadata for this session's cwd.
  const gitMeta = transformed.cwd != null ? resolveGitMetadata(transformed.cwd) : null;

  const counts: SessionImportCounts = {
    totalParsedAssistantUsage: 0,
    messagesImported: 0,
    messagesReplaySkipped: 0,
    messagesZeroCostSkipped: 0,
    messagesBoundarySkipped: 0,
    messagesIdCanonicalized: 0,
    messagesCutoffSkipped: 0,
    toolCallsImported: 0,
    toolCallsSkipped: 0,
    malformed: parsed.errors.length,
  };

  let importedCostMicros = 0;
  let replaySkippedCostMicros = 0;
  let boundarySkippedCostMicros = 0;
  let cutoffSkippedCostMicros = 0;

  // Classify each message in the transformed session.
  // We collect "to-import" messages per turn, applying all skip rules.
  type MsgDecision = {
    msg: TransformedMessage;
    turn: TransformedTurn;
    disposition: "import" | "zero_cost_skip" | "replay_skip" | "boundary_skip" | "cutoff_skip";
    /** The consumed DB row for boundary_skip decisions (canonicalization target). */
    boundaryDbRow?: DbMessage;
  };
  const decisions: MsgDecision[] = [];

  for (const turn of transformed.turns) {
    for (const msg of turn.messages) {
      counts.totalParsedAssistantUsage++;

      if (msg.isZeroCostSkip) {
        counts.messagesZeroCostSkipped++;
        decisions.push({ msg, turn, disposition: "zero_cost_skip" });
        continue;
      }

      // Cutoff check: skip messages whose inner timestamp >= untilMs.
      if (untilMs != null && msg.tsMs >= untilMs) {
        counts.messagesCutoffSkipped++;
        cutoffSkippedCostMicros += msg.costTotalMicros;
        if (msg.responseId != null) seenResponseIds.add(msg.responseId);
        decisions.push({ msg, turn, disposition: "cutoff_skip" });
        continue;
      }

      // Cross-file replay dedup: first-occurrence-wins on responseId.
      if (msg.responseId != null && seenResponseIds.has(msg.responseId)) {
        counts.messagesReplaySkipped++;
        replaySkippedCostMicros += msg.costTotalMicros;
        decisions.push({ msg, turn, disposition: "replay_skip" });
        continue;
      }

      // Per-session boundary dedup: token quadruple + model + cost matching.
      const boundaryMatchIdx = availableDbMessages.findIndex((dbRow) =>
        matchesDbRow(dbRow, msg),
      );
      if (boundaryMatchIdx >= 0) {
        counts.messagesBoundarySkipped++;
        boundarySkippedCostMicros += msg.costTotalMicros;
        if (msg.responseId != null) seenResponseIds.add(msg.responseId);
        // Consume this DB row (one-consumption semantics).
        const [boundaryDbRow] = availableDbMessages.splice(boundaryMatchIdx, 1);
        decisions.push({ msg, turn, disposition: "boundary_skip", boundaryDbRow });
        continue;
      }

      // Will be imported.
      decisions.push({ msg, turn, disposition: "import" });

      // Register responseId in the cross-file dedup set. Tool-call IDs are
      // registered only when their containing imported message is processed
      // below; doing it here would make dry-run/current-message checks treat
      // the current tool call as a replay of itself.
      if (msg.responseId != null) seenResponseIds.add(msg.responseId);
    }
  }

  // Execute writes inside a per-session transaction.
  if (!dryRun && centralDb != null) {
    const writeResult = writeSessionTransaction(
      centralDb,
      transformed,
      gitMeta,
      decisions,
      existingSession,
      existingToolCallIds,
      seenToolCallIds,
      counts,
    );

    importedCostMicros += writeResult.insertedCostMicros;

    // Verify session was written (for dry-run, sessionUuid would be null).
    if (writeResult.sessionUuid == null) {
      // Session write failed; the transaction helper reported the error.
    }
  } else {
    // Dry-run: count everything in-memory, updating the shared tool-call set
    // in the same order the writer would. This mirrors first-occurrence-wins
    // without treating the current message's tool calls as already seen.
    for (const d of decisions) {
      if (d.disposition === "import") {
        counts.messagesImported++;
        importedCostMicros += d.msg.costTotalMicros;
        // Count tool calls for non-skipped messages.
        for (const tc of d.msg.toolCalls) {
          if (!existingToolCallIds.has(tc.harnessToolCallId) && !seenToolCallIds.has(tc.harnessToolCallId)) {
            counts.toolCallsImported++;
            seenToolCallIds.add(tc.harnessToolCallId);
          } else {
            counts.toolCallsSkipped++;
          }
        }
      } else {
        // Count would-be ID canonicalizations for boundary matches.
        if (
          d.disposition === "boundary_skip" &&
          d.boundaryDbRow != null &&
          d.msg.responseId != null &&
          isSynthesizedPiMessageId(d.boundaryDbRow.harness_message_id, filePath)
        ) {
          counts.messagesIdCanonicalized++;
        }
        // Tool calls in skipped messages are also skipped.
        counts.toolCallsSkipped += d.msg.toolCalls.length;
      }
    }
  }

  return {
    filePath,
    isSubagent,
    sessionStartIso,
    piUuid: transformed.piUuid,
    cwd: transformed.cwd,
    existedInDb,
    counts,
    importedCostMicros,
    replaySkippedCostMicros,
    boundarySkippedCostMicros,
    cutoffSkippedCostMicros,
  };
}

// ---------------------------------------------------------------------------
// Transaction writer
// ---------------------------------------------------------------------------

type MsgDecision = {
  msg: TransformedMessage;
  turn: TransformedTurn;
  disposition: "import" | "zero_cost_skip" | "replay_skip" | "boundary_skip" | "cutoff_skip";
  /** The consumed DB row for boundary_skip decisions (canonicalization target). */
  boundaryDbRow?: DbMessage;
};

function writeSessionTransaction(
  db: Database.Database,
  transformed: TransformedSession,
  gitMeta: ReturnType<typeof resolveGitMetadata> | null,
  decisions: MsgDecision[],
  existingSession: ExistingSession | null,
  existingToolCallIds: Set<string>,
  seenToolCallIds: Set<string>,
  counts: SessionImportCounts,
): { sessionUuid: string | null; insertedCostMicros: number } {
  // Prepare statements (done outside the transaction for efficiency).
  const stmtUpsertSession = db.prepare(`
    INSERT INTO sessions
      (id, harness_id, harness_session_id, session_file, cwd,
       repo_owner, repo_name, repo_remote, started_at, ended_at)
    VALUES
      ($id, $harnessId, $harnessSessionId, $sessionFile, $cwd,
       $repoOwner, $repoName, $repoRemote, $startedAt, $endedAt)
    ON CONFLICT (harness_id, harness_session_id) DO UPDATE SET
      session_file = COALESCE(excluded.session_file, sessions.session_file),
      cwd          = COALESCE(excluded.cwd,          sessions.cwd),
      repo_owner   = COALESCE(excluded.repo_owner,   sessions.repo_owner),
      repo_name    = COALESCE(excluded.repo_name,    sessions.repo_name),
      repo_remote  = COALESCE(excluded.repo_remote,  sessions.repo_remote),
      started_at   = COALESCE(NULLIF(excluded.started_at, 0), sessions.started_at),
      ended_at     = COALESCE(excluded.ended_at, sessions.ended_at)
    RETURNING id
  `);

  const stmtUpsertTurn = db.prepare(`
    INSERT INTO turns
      (id, session_id, harness_id, harness_turn_id, turn_index,
       started_at, ended_at, provider, model_id)
    VALUES
      ($id, $sessionId, $harnessId, $harnessTurnId, $turnIndex,
       $startedAt, $endedAt, $provider, $modelId)
    ON CONFLICT (session_id, harness_turn_id) DO UPDATE SET
      turn_index = COALESCE(excluded.turn_index, turns.turn_index),
      started_at = COALESCE(NULLIF(excluded.started_at, 0), turns.started_at),
      ended_at   = COALESCE(excluded.ended_at, turns.ended_at),
      provider   = COALESCE(excluded.provider,  turns.provider),
      model_id   = COALESCE(excluded.model_id,  turns.model_id)
    RETURNING id
  `);

  // INSERT OR IGNORE: never re-point session_id/turn_id of live writer rows.
  const stmtInsertMessage = db.prepare(`
    INSERT OR IGNORE INTO llm_messages (
      id, session_id, turn_id, harness_id, harness_message_id,
      ts, provider, model_id,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      cost_input_micros, cost_output_micros,
      cost_cache_read_micros, cost_cache_write_micros,
      cost_total_micros, cost_currency, cost_source
    ) VALUES (
      $id, $sessionId, $turnId, $harnessId, $harnessMessageId,
      $ts, $provider, $modelId,
      $inputTokens, $outputTokens, $cacheReadTokens, $cacheWriteTokens,
      $costInputMicros, $costOutputMicros,
      $costCacheReadMicros, $costCacheWriteMicros,
      $costTotalMicros, 'USD', $costSource
    )
  `);

  // Canonicalize a boundary-matched live-writer row to the provider responseId.
  // Guarded by NOT EXISTS so the UNIQUE (harness_id, harness_message_id)
  // constraint can never fire when a provider-ID row already exists.
  const stmtCanonicalizeMessageId = db.prepare(`
    UPDATE llm_messages
    SET harness_message_id = $newId
    WHERE id = $rowId
      AND NOT EXISTS (
        SELECT 1 FROM llm_messages
        WHERE harness_id = $harnessId AND harness_message_id = $newId
      )
  `);

  // INSERT OR IGNORE: never clobber live writer tool call rows.
  const stmtInsertToolCall = db.prepare(`
    INSERT OR IGNORE INTO tool_calls
      (id, session_id, turn_id, harness_id, harness_tool_call_id,
       tool_name, started_at, ended_at, is_error)
    VALUES
      ($id, $sessionId, $turnId, $harnessId, $harnessToolCallId,
       $toolName, $startedAt, $endedAt, $isError)
  `);

  let sessionUuid: string | null = existingSession?.id ?? null;
  let insertedCostMicros = 0;

  // Build a map from harnessTurnId → { existing?: turnId }
  // so we can look up the turn UUID for tool calls.
  const turnUuidMap = new Map<string, string>();

  try {
    db.transaction(() => {
      // Upsert session.
      const proposedSessionId = sessionUuid ?? randomUUID();
      const sessionRow = stmtUpsertSession.get({
        id: proposedSessionId,
        harnessId: HARNESS_ID,
        harnessSessionId: transformed.filePath,
        sessionFile: transformed.filePath,
        cwd: transformed.cwd ?? null,
        repoOwner: gitMeta?.repoOwner ?? null,
        repoName: gitMeta?.repoName ?? null,
        repoRemote: gitMeta?.repoRemote ?? null,
        startedAt: transformed.sessionStartMs,
        endedAt: null,
      }) as { id: string } | undefined;
      sessionUuid = sessionRow?.id ?? proposedSessionId;

      // Upsert all turns (even those with no imported messages, for index integrity).
      for (const turn of transformed.turns) {
        const proposedTurnId = randomUUID();
        const turnRow = stmtUpsertTurn.get({
          id: proposedTurnId,
          sessionId: sessionUuid,
          harnessId: HARNESS_ID,
          harnessTurnId: turn.harnessTurnId,
          turnIndex: turn.turnIndex,
          startedAt: turn.startedAtMs,
          endedAt: turn.endedAtMs ?? null,
          provider: turn.provider ?? null,
          modelId: turn.modelId ?? null,
        }) as { id: string } | undefined;
        turnUuidMap.set(turn.harnessTurnId, turnRow?.id ?? proposedTurnId);
      }

      // Write messages and their tool calls.
      for (const d of decisions) {
        if (d.disposition !== "import") {
          // Boundary matches: upgrade synthesized live-writer IDs to the
          // canonical provider responseId so both representations of the same
          // model call share one identity.
          if (
            d.disposition === "boundary_skip" &&
            d.boundaryDbRow != null &&
            d.msg.responseId != null &&
            isSynthesizedPiMessageId(d.boundaryDbRow.harness_message_id, transformed.filePath)
          ) {
            const updated = stmtCanonicalizeMessageId.run({
              rowId: d.boundaryDbRow.id,
              newId: d.msg.responseId,
              harnessId: HARNESS_ID,
            });
            if (updated.changes > 0) counts.messagesIdCanonicalized++;
          }

          // Tool calls in skipped messages are also skipped.
          counts.toolCallsSkipped += d.msg.toolCalls.length;
          continue;
        }

        const turnUuid = turnUuidMap.get(d.turn.harnessTurnId) ?? null;

        const msgResult = stmtInsertMessage.run({
          id: randomUUID(),
          sessionId: sessionUuid,
          turnId: turnUuid,
          harnessId: HARNESS_ID,
          harnessMessageId: d.msg.harnessMessageId,
          ts: d.msg.tsMs,
          provider: d.msg.provider ?? null,
          modelId: d.msg.modelId ?? null,
          inputTokens: d.msg.inputTokens,
          outputTokens: d.msg.outputTokens,
          cacheReadTokens: d.msg.cacheReadTokens,
          cacheWriteTokens: d.msg.cacheWriteTokens,
          costInputMicros: d.msg.costInputMicros,
          costOutputMicros: d.msg.costOutputMicros,
          costCacheReadMicros: d.msg.costCacheReadMicros,
          costCacheWriteMicros: d.msg.costCacheWriteMicros,
          costTotalMicros: d.msg.costTotalMicros,
          costSource: d.msg.costSource,
        });

        if (msgResult.changes > 0) {
          counts.messagesImported++;
          insertedCostMicros += d.msg.costTotalMicros;
        } else {
          // INSERT OR IGNORE fired: a row with this harnessMessageId already
          // exists. Treat it as a boundary-style skip and do not write or count
          // tool calls from this message, preserving live-writer attribution.
          counts.messagesBoundarySkipped++;
          counts.toolCallsSkipped += d.msg.toolCalls.length;
          continue;
        }

        // Tool calls for this message.
        for (const tc of d.msg.toolCalls) {
          // Skip if already seen in an earlier imported message/file (cross-file
          // replay dedup for tool calls) or if this session already has the row.
          if (seenToolCallIds.has(tc.harnessToolCallId) || existingToolCallIds.has(tc.harnessToolCallId)) {
            counts.toolCallsSkipped++;
            continue;
          }

          const tcResult = stmtInsertToolCall.run({
            id: randomUUID(),
            sessionId: sessionUuid,
            turnId: turnUuid,
            harnessId: HARNESS_ID,
            harnessToolCallId: tc.harnessToolCallId,
            toolName: tc.toolName,
            startedAt: tc.startedAtMs,
            endedAt: tc.endedAtMs ?? null,
            isError: tc.isError ? 1 : 0,
          });

          if (tcResult.changes > 0) {
            counts.toolCallsImported++;
            seenToolCallIds.add(tc.harnessToolCallId);
          } else {
            counts.toolCallsSkipped++;
          }
        }
      }
    })();
  } catch (err) {
    // Log the error but don't re-throw — per-session transactions can fail
    // independently without aborting the whole import run.
    process.stderr.write(
      `token-tally import pi-sessions: transaction failed for ${transformed.filePath}: ${errMsg(err)}\n`,
    );
    return { sessionUuid: null, insertedCostMicros: 0 };
  }

  return { sessionUuid, insertedCostMicros };
}

// ---------------------------------------------------------------------------
// Harness upsert
// ---------------------------------------------------------------------------

function upsertHarness(db: Database.Database): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO harnesses
      (name, display_name, version, integration_version, first_seen_at, last_seen_at)
    VALUES
      ($name, $displayName, $version, $integrationVersion, $now, $now)
    ON CONFLICT (name) DO UPDATE SET
      version             = COALESCE(harnesses.version,             excluded.version),
      integration_version = COALESCE(harnesses.integration_version, excluded.integration_version),
      last_seen_at        = excluded.last_seen_at
  `).run({
    name: HARNESS_ID,
    displayName: "Pi",
    version: null,
    integrationVersion: IMPORT_INTEGRATION_VERSION,
    now,
  });
}

// ---------------------------------------------------------------------------
// DB query helpers
// ---------------------------------------------------------------------------

interface ExistingSession {
  id: string;
}

function lookupExistingSession(
  db: Database.Database,
  filePath: string,
): ExistingSession | null {
  const row = db
    .prepare(
      "SELECT id FROM sessions WHERE harness_id = ? AND harness_session_id = ?",
    )
    .get(HARNESS_ID, filePath) as { id: string } | undefined;
  return row ?? null;
}

interface DbMessage {
  id: string;
  harness_message_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  model_id: string | null;
  cost_input_micros: number;
  cost_output_micros: number;
  cost_cache_read_micros: number;
  cost_cache_write_micros: number;
  cost_total_micros: number;
}

function loadExistingMessages(
  db: Database.Database,
  sessionId: string,
): DbMessage[] {
  return db
    .prepare(
      `SELECT id, harness_message_id,
              input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
              model_id,
              cost_input_micros, cost_output_micros,
              cost_cache_read_micros, cost_cache_write_micros,
              cost_total_micros
       FROM llm_messages
       WHERE session_id = ?
       ORDER BY ts ASC`,
    )
    .all(sessionId) as DbMessage[];
}

function loadExistingToolCallIds(
  db: Database.Database,
  sessionId: string,
): Set<string> {
  const rows = db
    .prepare(
      "SELECT harness_tool_call_id FROM tool_calls WHERE session_id = ? AND harness_id = ?",
    )
    .all(sessionId, HARNESS_ID) as Array<{ harness_tool_call_id: string }>;
  return new Set(rows.map((r) => r.harness_tool_call_id));
}

/**
 * True when `harnessMessageId` is a synthesized (non-provider) ID for the
 * given session file: either the live writer's `<file>:tN:mM` form or the
 * importer's `<file>:noid:<eventId>` form. Provider IDs (msg_... / resp_...)
 * never start with the session file path, so they are never renamed.
 */
function isSynthesizedPiMessageId(
  harnessMessageId: string,
  sessionFile: string,
): boolean {
  return harnessMessageId.startsWith(`${sessionFile}:`);
}

// ---------------------------------------------------------------------------
// Boundary dedup matching
// ---------------------------------------------------------------------------

/**
 * Returns true when `logMsg` matches a DB row by:
 *   1. Token quadruple (required)
 *   2. modelId when both sides have one (optional discriminator)
 *   3. Cost component micros when both sides have nonzero cost (extra discriminator)
 *
 * Timestamp equality is intentionally NOT used: the live writer stamps rows at
 * hook completion time while the log records inner message start time.
 */
function matchesDbRow(dbRow: DbMessage, logMsg: TransformedMessage): boolean {
  // 1. Token quadruple must match.
  if (dbRow.input_tokens !== logMsg.inputTokens) return false;
  if (dbRow.output_tokens !== logMsg.outputTokens) return false;
  if (dbRow.cache_read_tokens !== logMsg.cacheReadTokens) return false;
  if (dbRow.cache_write_tokens !== logMsg.cacheWriteTokens) return false;

  // 2. ModelId: skip check if either side is null/undefined.
  if (
    dbRow.model_id != null &&
    logMsg.modelId != null &&
    dbRow.model_id !== logMsg.modelId
  ) {
    return false;
  }

  // 3. Cost components: extra discriminator only when both have nonzero cost.
  if (dbRow.cost_total_micros > 0 && logMsg.costTotalMicros > 0) {
    if (dbRow.cost_input_micros !== logMsg.costInputMicros) return false;
    if (dbRow.cost_output_micros !== logMsg.costOutputMicros) return false;
    if (dbRow.cost_cache_read_micros !== logMsg.costCacheReadMicros) return false;
    if (dbRow.cost_cache_write_micros !== logMsg.costCacheWriteMicros) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Result builders
// ---------------------------------------------------------------------------

function makeEmptyResult(dryRun: boolean, dbPath: string): PiSessionImportResult {
  return {
    dryRun,
    dbPath,
    sessions: [],
    totals: {
      imported: 0,
      replaysSkipped: 0,
      zeroCostSkipped: 0,
      boundarySkipped: 0,
      idCanonicalized: 0,
      cutoffSkipped: 0,
      totalParsedAssistantUsage: 0,
      importedCostMicros: 0,
      replaySkippedCostMicros: 0,
      boundarySkippedCostMicros: 0,
      cutoffSkippedCostMicros: 0,
      subagentImportedCostMicros: 0,
      malformed: 0,
    },
  };
}

function buildResult(
  dryRun: boolean,
  dbPath: string,
  sessions: SessionImportResult[],
): PiSessionImportResult {
  const totals = {
    imported: 0,
    replaysSkipped: 0,
    zeroCostSkipped: 0,
    boundarySkipped: 0,
    idCanonicalized: 0,
    cutoffSkipped: 0,
    totalParsedAssistantUsage: 0,
    importedCostMicros: 0,
    replaySkippedCostMicros: 0,
    boundarySkippedCostMicros: 0,
    cutoffSkippedCostMicros: 0,
    subagentImportedCostMicros: 0,
    malformed: 0,
  };

  for (const s of sessions) {
    totals.imported += s.counts.messagesImported;
    totals.replaysSkipped += s.counts.messagesReplaySkipped;
    totals.zeroCostSkipped += s.counts.messagesZeroCostSkipped;
    totals.boundarySkipped += s.counts.messagesBoundarySkipped;
    totals.idCanonicalized += s.counts.messagesIdCanonicalized;
    totals.cutoffSkipped += s.counts.messagesCutoffSkipped;
    totals.totalParsedAssistantUsage += s.counts.totalParsedAssistantUsage;
    totals.importedCostMicros += s.importedCostMicros;
    totals.replaySkippedCostMicros += s.replaySkippedCostMicros;
    totals.boundarySkippedCostMicros += s.boundarySkippedCostMicros;
    totals.cutoffSkippedCostMicros += s.cutoffSkippedCostMicros;
    totals.malformed += s.counts.malformed;

    if (s.isSubagent) {
      totals.subagentImportedCostMicros += s.importedCostMicros;
    }
  }

  return { dryRun, dbPath, sessions, totals };
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function validateUtcDateOption(name: string, value: string | undefined): string | null {
  if (value == null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `Invalid ${name} value: ${value}. Expected YYYY-MM-DD (UTC).`;
  }
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (isNaN(ms)) {
    return `Invalid ${name} value: ${value}. Expected a valid UTC date.`;
  }
  return null;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
