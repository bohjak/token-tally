/**
 * Legacy Pi analytics import.
 *
 * Maps the old Pi SQLite schema at `~/.pi/analytics/events.db` (written by the
 * pre-ToTally analytics extension) to the central ToTally schema and bulk-imports
 * the rows in a single transaction.
 *
 * DESIGN NOTES
 *
 * Why not use AnalyticsWriter for the writes?
 *   AnalyticsWriter issues one commit per record call. For a typical legacy DB
 *   with thousands of messages that means thousands of individual commits — slow
 *   for a bulk import. This importer opens the central DB directly and wraps
 *   the entire import in a single transaction for acceptable performance.
 *
 *   It still honours the same idempotency keys (INSERT … ON CONFLICT DO UPDATE)
 *   and CHECK constraints (cost_total_micros = sum of breakdowns) that the
 *   writer enforces. The import uses AnalyticsWriter.open()+close() purely as
 *   a migration helper: it ensures migrations have run and spool files are
 *   drained before we touch the DB.
 *
 * IDEMPOTENCY
 *   The UNIQUE constraints on (harness_id, harness_session_id),
 *   (session_id, harness_turn_id), (harness_id, harness_message_id), and
 *   (harness_id, harness_tool_call_id) guarantee that a second import run
 *   updates existing rows rather than inserting duplicates. The "added" delta
 *   reported in LegacyImportResult is 0 on repeat runs.
 *
 * SAFETY
 *   The legacy DB is opened with { readonly: true }. This function never
 *   modifies or deletes the source file.
 *
 * DATA SCOPE
 *   Tables imported:  sessions, turns, llm_messages (role='assistant'), tool_calls
 *   Tables skipped:
 *     prompts         — user-facing content; excluded by the local-data policy
 *     files_touched   — private file-path data
 *     commits_made    — not yet in the central schema
 *     pr_associations — not yet in the central schema
 *     branch_transitions — not yet in the central schema
 *     resource_usage  — not yet in the central schema
 *     _meta           — internal migration bookkeeping for the legacy extension
 */

import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { mkdirSync } from "fs";
import { defaultDatabasePath } from "../paths";
import { AnalyticsWriter } from "../writer";
import { redactRemoteUrl } from "../util";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Options accepted by importLegacyPi(). */
export type LegacyImportOptions = {
  /**
   * Path to the legacy Pi database.
   * Default: ~/.pi/analytics/events.db
   */
  sourcePath?: string;

  /**
   * Path to the central ToTally database.
   * Default: defaultDatabasePath() (~/.local/share/token-tally/events.db)
   */
  dbPath?: string;
};

/** Per-table import statistics. */
export type TableImportStats = {
  /** Rows found in the legacy database (total processed). */
  legacy: number;
  /**
   * Rows that were newly inserted into the central database.
   * This is 0 on a repeated import run (idempotency guarantee).
   */
  added: number;
};

/** Result returned by importLegacyPi() on success. */
export type LegacyImportResult = {
  /** Absolute path of the legacy source database. */
  sourcePath: string;
  /** Absolute path of the central database that was written. */
  centralPath: string;
  /** Unix ms timestamp when the import completed. */
  completedAt: number;
  tables: {
    sessions: TableImportStats;
    turns: TableImportStats;
    messages: TableImportStats;
    toolCalls: TableImportStats;
  };
};

// ---------------------------------------------------------------------------
// Internal row types — match the legacy Pi schema exactly
// ---------------------------------------------------------------------------

type LegacySession = {
  id: string;
  cwd: string;         // NOT NULL DEFAULT '' in legacy; may be empty string
  repo_remote: string | null;
  repo_owner: string | null;
  repo_name: string | null;
  started_at: number;
  ended_at: number | null;
  pi_version: string;  // NOT NULL DEFAULT 'unknown'
};

type LegacyTurn = {
  id: string;
  session_id: string;
  idx: number;
  started_at: number;
  ended_at: number | null;
  model_id: string | null;
  provider: string | null;
};

type LegacyMessage = {
  id: string;
  turn_id: string;
  session_id: string;
  ts: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_input: number;    // REAL in legacy (USD float)
  cost_output: number;
  cost_cache_read: number;
  cost_cache_write: number;
  cost_total: number;
  model_id: string | null;
  provider: string | null;
};

type LegacyToolCall = {
  id: string;
  turn_id: string;
  session_id: string;
  name: string;
  started_at: number;
  ended_at: number;   // NOT NULL in the legacy schema
  is_error: number;   // SQLite INTEGER boolean: 0 or 1
};

/** Counts of existing rows in the central DB (for delta computation). */
type CentralCounts = {
  sessions: number;
  turns: number;
  messages: number;
  toolCalls: number;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Imports data from the legacy Pi analytics database into the central ToTally
 * store. Returns an error value (not a thrown exception) for expected failures
 * so the CLI can format the message cleanly.
 *
 * This function is safe to call multiple times on the same databases. On
 * a repeat run, no new rows are added (delta = 0 everywhere).
 */
export async function importLegacyPi(
  options?: LegacyImportOptions
): Promise<{ ok: true; result: LegacyImportResult } | { ok: false; error: string }> {
  const sourcePath = options?.sourcePath ?? defaultLegacyPath();
  const centralPath = options?.dbPath ?? defaultDatabasePath();

  if (!existsSync(sourcePath)) {
    return {
      ok: false,
      error: `Legacy Pi database not found at ${sourcePath}. No data was imported.`,
    };
  }

  // Open the legacy DB strictly read-only. The { readonly } flag is enforced
  // by better-sqlite3 at the OS level; even a programming error cannot write.
  let legacyDb: Database.Database;
  try {
    legacyDb = new Database(sourcePath, { readonly: true });
    legacyDb.pragma("foreign_keys = ON");
  } catch (err) {
    return {
      ok: false,
      error: `Cannot open legacy database at ${sourcePath}: ${errMsg(err)}`,
    };
  }

  // Validate the legacy DB has the tables we need before doing any work.
  const schemaCheck = checkLegacySchema(legacyDb);
  if (!schemaCheck.ok) {
    legacyDb.close();
    return { ok: false, error: schemaCheck.error };
  }

  // Use AnalyticsWriter.open()+close() as a lightweight migration runner.
  // This creates the central DB if absent, runs any pending schema migrations,
  // and drains closed spool files from previous writer sessions — all before
  // we open the central DB directly below.
  try {
    mkdirSync(dirname(centralPath), { recursive: true });
    const migrationWriter = await AnalyticsWriter.open({
      dbPath: centralPath,
      harnessName: "token-tally-import",
    });
    await migrationWriter.close();
  } catch (err) {
    legacyDb.close();
    return {
      ok: false,
      error: `Cannot prepare central database at ${centralPath}: ${errMsg(err)}`,
    };
  }

  // Count existing rows before the import so we can report the delta later.
  const before = countCentralRows(centralPath);

  // Open the central DB directly for the bulk import. WAL mode and FK
  // enforcement must be re-applied: pragmas are per-connection, not persisted.
  let centralDb: Database.Database;
  try {
    centralDb = new Database(centralPath);
    centralDb.pragma("foreign_keys = ON");
    centralDb.pragma("journal_mode = WAL");
    centralDb.pragma("synchronous = NORMAL");
    centralDb.pragma("busy_timeout = 5000");
  } catch (err) {
    legacyDb.close();
    return {
      ok: false,
      error: `Cannot open central database for writing: ${errMsg(err)}`,
    };
  }

  let importStats: ReturnType<typeof runImportTransaction>;
  try {
    // Single transaction covers harness + all tables. If anything fails, the
    // central DB rolls back completely and the legacy DB is untouched.
    importStats = runImportTransaction(legacyDb, centralDb);
  } catch (err) {
    legacyDb.close();
    centralDb.close();
    return { ok: false, error: `Import transaction failed: ${errMsg(err)}` };
  }

  legacyDb.close();

  // Count rows after the import to compute what was genuinely new.
  const after = countCentralRows(centralPath);

  const result: LegacyImportResult = {
    sourcePath,
    centralPath,
    completedAt: Date.now(),
    tables: {
      sessions: { legacy: importStats.sessionsRead, added: after.sessions - before.sessions },
      turns:    { legacy: importStats.turnsRead,    added: after.turns    - before.turns    },
      messages: { legacy: importStats.messagesRead, added: after.messages - before.messages },
      toolCalls:{ legacy: importStats.toolCallsRead,added: after.toolCalls- before.toolCalls},
    },
  };

  // Record import metadata in schema_metadata so doctor/diagnostics can surface it.
  writeImportMetadata(centralDb, result);
  centralDb.close();

  return { ok: true, result };
}

// ---------------------------------------------------------------------------
// Default path helper
// ---------------------------------------------------------------------------

/** Returns the conventional legacy Pi analytics database path. */
export function defaultLegacyPath(): string {
  return join(homedir(), ".pi", "analytics", "events.db");
}

// ---------------------------------------------------------------------------
// Schema check
// ---------------------------------------------------------------------------

function checkLegacySchema(
  db: Database.Database
): { ok: true } | { ok: false; error: string } {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>;
  const present = new Set(rows.map((r) => r.name));
  const required = ["sessions", "turns", "llm_messages", "tool_calls"] as const;
  const missing = required.filter((t) => !present.has(t));
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Legacy database is missing required tables: ${missing.join(", ")}. Is this a Pi analytics database?`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Row-count helpers
// ---------------------------------------------------------------------------

function countCentralRows(centralPath: string): CentralCounts {
  if (!existsSync(centralPath)) {
    return { sessions: 0, turns: 0, messages: 0, toolCalls: 0 };
  }
  const db = new Database(centralPath, { readonly: true });
  try {
    return {
      sessions:  countRows(db, "sessions"),
      turns:     countRows(db, "turns"),
      messages:  countRows(db, "llm_messages"),
      toolCalls: countRows(db, "tool_calls"),
    };
  } finally {
    db.close();
  }
}

function countRows(db: Database.Database, table: string): number {
  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(table) as { name: string } | undefined;
  if (exists == null) return 0;
  const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number };
  return row.n;
}

// ---------------------------------------------------------------------------
// Core import transaction
// ---------------------------------------------------------------------------

type ImportStats = {
  sessionsRead: number;
  turnsRead: number;
  messagesRead: number;
  toolCallsRead: number;
};

/**
 * Runs the full import inside a single SQLite transaction on centralDb.
 * The transaction wraps harness + sessions + turns + messages + tool_calls.
 * A failure in any step rolls back the entire import cleanly.
 *
 * Returns the count of rows read from the legacy DB for each table.
 */
function runImportTransaction(
  legacyDb: Database.Database,
  centralDb: Database.Database
): ImportStats {
  const HARNESS_ID = "pi";
  const INTEGRATION_VERSION = "legacy-import-0.1.0";

  // Read all legacy rows upfront (outside the transaction — read-only, safe).
  // Ordering by started_at / ts ensures parents arrive before children when
  // the data happens to be in insertion order; the ID maps handle the rest.
  const legacySessions = legacyDb
    .prepare(
      `SELECT id, cwd, repo_remote, repo_owner, repo_name,
              started_at, ended_at, pi_version
       FROM sessions
       ORDER BY started_at`
    )
    .all() as LegacySession[];

  const legacyTurns = legacyDb
    .prepare(
      `SELECT id, session_id, idx, started_at, ended_at, model_id, provider
       FROM turns
       ORDER BY started_at`
    )
    .all() as LegacyTurn[];

  // Import only assistant-role messages: those are the only rows that carry
  // meaningful token counts and costs. User-role messages have all-zero token
  // counts and would add noise without adding value.
  const legacyMessages = legacyDb
    .prepare(
      `SELECT id, turn_id, session_id, ts,
              input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
              cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total,
              model_id, provider
       FROM llm_messages
       WHERE role = 'assistant'
       ORDER BY ts`
    )
    .all() as LegacyMessage[];

  const legacyToolCalls = legacyDb
    .prepare(
      `SELECT id, turn_id, session_id, name, started_at, ended_at, is_error
       FROM tool_calls
       ORDER BY started_at`
    )
    .all() as LegacyToolCall[];

  // Determine the most recent pi_version for the harness row. The legacy DB
  // stores the Pi application version per session. We use the latest session's
  // version as the canonical harness version.
  const latestSession = legacyDb
    .prepare("SELECT pi_version FROM sessions ORDER BY started_at DESC LIMIT 1")
    .get() as { pi_version: string } | undefined;
  const piVersion = latestSession?.pi_version ?? "unknown";

  // ---------------------------------------------------------------------------
  // Prepare all upsert statements before entering the transaction. Preparation
  // is a parsing + planning step; done once here, reused per row inside.
  // ---------------------------------------------------------------------------

  // The import must NOT overwrite an existing live harness version or
  // integration_version that was written by the real Pi writer extension.
  // COALESCE(existing, incoming) keeps the live writer's values when present
  // and only fills in the importer's values when the column is currently null.
  const stmtUpsertHarness = centralDb.prepare(`
    INSERT INTO harnesses
      (name, display_name, version, integration_version, first_seen_at, last_seen_at)
    VALUES
      ($name, $displayName, $version, $integrationVersion, $now, $now)
    ON CONFLICT (name) DO UPDATE SET
      version             = COALESCE(harnesses.version,             excluded.version),
      integration_version = COALESCE(harnesses.integration_version, excluded.integration_version),
      last_seen_at        = excluded.last_seen_at
  `);

  // Partial-update safety: COALESCE preserves non-null stored values so that
  // a repeated import run cannot clobber richer data written by a previous run
  // or by the live Pi writer extension.  NULLIF(started_at, 0) guards against
  // an accidental zero sentinel the same way the writer.ts upsert does.
  const stmtUpsertSession = centralDb.prepare(`
    INSERT INTO sessions
      (id, harness_id, harness_session_id, cwd,
       repo_remote, repo_owner, repo_name, started_at, ended_at)
    VALUES
      ($id, $harnessId, $harnessSessionId, $cwd,
       $repoRemote, $repoOwner, $repoName, $startedAt, $endedAt)
    ON CONFLICT (harness_id, harness_session_id) DO UPDATE SET
      cwd        = COALESCE(excluded.cwd,        sessions.cwd),
      repo_remote= COALESCE(excluded.repo_remote, sessions.repo_remote),
      repo_owner = COALESCE(excluded.repo_owner,  sessions.repo_owner),
      repo_name  = COALESCE(excluded.repo_name,   sessions.repo_name),
      started_at = COALESCE(NULLIF(excluded.started_at, 0), sessions.started_at),
      ended_at   = COALESCE(excluded.ended_at, sessions.ended_at)
    RETURNING id
  `);

  const stmtUpsertTurn = centralDb.prepare(`
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

  const stmtUpsertMessage = centralDb.prepare(`
    INSERT INTO llm_messages (
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
    ON CONFLICT (harness_id, harness_message_id) DO UPDATE SET
      session_id              = excluded.session_id,
      turn_id                 = excluded.turn_id,
      ts                      = excluded.ts,
      provider                = excluded.provider,
      model_id                = excluded.model_id,
      input_tokens            = excluded.input_tokens,
      output_tokens           = excluded.output_tokens,
      cache_read_tokens       = excluded.cache_read_tokens,
      cache_write_tokens      = excluded.cache_write_tokens,
      cost_input_micros       = excluded.cost_input_micros,
      cost_output_micros      = excluded.cost_output_micros,
      cost_cache_read_micros  = excluded.cost_cache_read_micros,
      cost_cache_write_micros = excluded.cost_cache_write_micros,
      cost_total_micros       = excluded.cost_total_micros,
      cost_source             = excluded.cost_source
    RETURNING id
  `);

  const stmtUpsertToolCall = centralDb.prepare(`
    INSERT INTO tool_calls
      (id, session_id, turn_id, harness_id, harness_tool_call_id,
       tool_name, started_at, ended_at, is_error)
    VALUES
      ($id, $sessionId, $turnId, $harnessId, $harnessToolCallId,
       $toolName, $startedAt, $endedAt, $isError)
    ON CONFLICT (harness_id, harness_tool_call_id) DO UPDATE SET
      turn_id  = COALESCE(excluded.turn_id, tool_calls.turn_id),
      ended_at = excluded.ended_at,
      is_error = excluded.is_error
    RETURNING id
  `);

  // ---------------------------------------------------------------------------
  // Run the transaction
  // ---------------------------------------------------------------------------

  // better-sqlite3 transactions are synchronous; the function passed to
  // .transaction() runs atomically.
  const now = Date.now();

  centralDb.transaction(() => {
    // 1. Register the harness so FK constraints on child tables pass.
    stmtUpsertHarness.run({
      name: HARNESS_ID,
      displayName: "Pi",
      version: piVersion,
      integrationVersion: INTEGRATION_VERSION,
      now,
    });

    // Map from legacy ID → central ToTally UUID. Built as we process each
    // table, then consumed by the child tables that reference them.
    const sessionIdMap = new Map<string, string>();
    const turnIdMap = new Map<string, string>();

    // 2. Sessions.
    for (const row of legacySessions) {
      const proposed = randomUUID();
      // Redact any credentials from the remote URL before storing.
      const repoRemote =
        row.repo_remote != null ? redactRemoteUrl(row.repo_remote) : null;
      const returned = stmtUpsertSession.get({
        id: proposed,
        harnessId: HARNESS_ID,
        harnessSessionId: row.id,
        // Empty string from the legacy DEFAULT '' is not meaningful; use null.
        cwd: row.cwd !== "" ? row.cwd : null,
        repoRemote,
        repoOwner:  row.repo_owner  ?? null,
        repoName:   row.repo_name   ?? null,
        startedAt:  row.started_at,
        endedAt:    row.ended_at ?? null,
      }) as { id: string } | undefined;
      // RETURNING id gives us the canonical UUID (new or existing on conflict).
      sessionIdMap.set(row.id, returned?.id ?? proposed);
    }

    // 3. Turns.
    for (const row of legacyTurns) {
      const centralSessionId = sessionIdMap.get(row.session_id);
      if (centralSessionId == null) {
        // Orphaned turn (session was not imported); skip rather than violate FK.
        continue;
      }
      const proposed = randomUUID();
      const returned = stmtUpsertTurn.get({
        id: proposed,
        sessionId:    centralSessionId,
        harnessId:    HARNESS_ID,
        harnessTurnId: row.id,
        turnIndex:    row.idx,
        startedAt:    row.started_at,
        endedAt:      row.ended_at ?? null,
        provider:     row.provider  ?? null,
        modelId:      row.model_id  ?? null,
      }) as { id: string } | undefined;
      turnIdMap.set(row.id, returned?.id ?? proposed);
    }

    // 4. LLM messages.
    for (const row of legacyMessages) {
      const centralSessionId = sessionIdMap.get(row.session_id);
      if (centralSessionId == null) continue; // orphaned; skip

      const centralTurnId = turnIdMap.get(row.turn_id) ?? null;

      // Convert REAL USD floats to integer micro-dollars.
      // Math.round eliminates floating-point drift in the stored REAL values
      // (e.g. 0.001500000001 → 1500). We derive cost_total_micros as the
      // exact integer sum so the DB CHECK constraint is always satisfied.
      const costInputMicros       = Math.round((row.cost_input      ?? 0) * 1_000_000);
      const costOutputMicros      = Math.round((row.cost_output     ?? 0) * 1_000_000);
      const costCacheReadMicros   = Math.round((row.cost_cache_read ?? 0) * 1_000_000);
      const costCacheWriteMicros  = Math.round((row.cost_cache_write?? 0) * 1_000_000);
      const costTotalMicros       = costInputMicros + costOutputMicros + costCacheReadMicros + costCacheWriteMicros;

      // Cost provenance: the legacy Pi extension computed costs from token
      // counts using its own pricing table (a "writer" in ToTally terms).
      // If cost_total was 0 in the source, we cannot determine whether
      // pricing was unknown or the message genuinely cost nothing, so we
      // use "unknown" to avoid silently including zeros in headline totals.
      const costSource = (row.cost_total ?? 0) > 0 ? "writer" : "unknown";

      stmtUpsertMessage.get({
        id:                   randomUUID(),
        sessionId:            centralSessionId,
        turnId:               centralTurnId,
        harnessId:            HARNESS_ID,
        harnessMessageId:     row.id,
        ts:                   row.ts,
        provider:             row.provider ?? null,
        modelId:              row.model_id ?? null,
        inputTokens:          row.input_tokens,
        outputTokens:         row.output_tokens,
        cacheReadTokens:      row.cache_read_tokens,
        cacheWriteTokens:     row.cache_write_tokens,
        costInputMicros,
        costOutputMicros,
        costCacheReadMicros,
        costCacheWriteMicros,
        costTotalMicros,
        costSource,
      });
    }

    // 5. Tool calls.
    for (const row of legacyToolCalls) {
      const centralSessionId = sessionIdMap.get(row.session_id);
      if (centralSessionId == null) continue; // orphaned; skip

      const centralTurnId = turnIdMap.get(row.turn_id) ?? null;

      stmtUpsertToolCall.get({
        id:                  randomUUID(),
        sessionId:           centralSessionId,
        turnId:              centralTurnId,
        harnessId:           HARNESS_ID,
        harnessToolCallId:   row.id,
        toolName:            row.name,
        startedAt:           row.started_at,
        endedAt:             row.ended_at,
        isError:             row.is_error,
      });
    }
  })(); // immediately invoke to run the transaction

  return {
    sessionsRead:  legacySessions.length,
    turnsRead:     legacyTurns.length,
    messagesRead:  legacyMessages.length,
    toolCallsRead: legacyToolCalls.length,
  };
}

// ---------------------------------------------------------------------------
// Import metadata
// ---------------------------------------------------------------------------

/**
 * Writes a JSON record of the import result into schema_metadata so that
 * `token-tally doctor` and the tray app can surface import history without
 * querying the full harness tables.
 *
 * Key: "import_legacy_pi"
 * Value: JSON-serialized LegacyImportResult
 *
 * On repeat imports this row is overwritten (ON CONFLICT DO UPDATE) so the
 * metadata always reflects the most recent run.
 */
function writeImportMetadata(
  centralDb: Database.Database,
  result: LegacyImportResult
): void {
  centralDb
    .prepare(
      `INSERT INTO schema_metadata (key, value)
       VALUES ('import_legacy_pi', $value)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`
    )
    .run({ value: JSON.stringify(result) });
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
