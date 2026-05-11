/**
 * AnalyticsWriter — the public write API for the ToTally central store.
 *
 * USAGE
 *   import { AnalyticsWriter } from "@token-tally/store";
 *
 *   const writer = await AnalyticsWriter.open({ harnessName: "pi" });
 *   await writer.recordHarness({ name: "pi", displayName: "Pi", ... });
 *   await writer.recordSession({ ... });
 *   await writer.recordLlmMessage({ ... });
 *   await writer.close();
 *
 * OPEN BEHAVIOR
 *   - Tries to open the SQLite DB and run pending migrations.
 *   - On success, drains any closed spool files from previous sessions.
 *   - If the DB is busy, unreachable, or in `degraded` schema state, falls
 *     back to spool-only mode; the harness keeps running without data loss.
 *   - Throws only when the DB schema version is too new to tolerate
 *     (past the forward window): this requires a binary update.
 *
 * WRITE BEHAVIOR
 *   - All record methods use idempotent INSERT … ON CONFLICT DO UPDATE, so
 *     replaying the same event is always safe.
 *   - If a write to the DB fails with SQLITE_BUSY after retries, the event
 *     is appended to the spool file instead (same durability guarantee).
 *
 * CLOSE BEHAVIOR
 *   - rotate() promotes the active spool file to .closed.
 *   - drain() replays all .closed files into the DB (if available).
 *   - The DB connection is then closed.
 */

import { randomUUID } from "crypto";
import Database from "better-sqlite3";
import {
  MAX_KNOWN_SCHEMA_VERSION,
  MIN_SUPPORTED_SCHEMA_VERSION,
  SCHEMA_FORWARD_WINDOW,
  openWriterConnection,
  readSchemaCompatibility,
  withBusyRetry,
} from "./connection";
import { runMigrations } from "./migrations";
import { defaultDatabasePath, defaultSpoolDir } from "./paths";
import { SpoolWriter, drainClosedSpoolFiles } from "./spool";
import type { SpoolRecord } from "./spool";
import type {
  HarnessPayload,
  LlmMessagePayload,
  RawEventPayload,
  RecordResult,
  SessionPayload,
  SubscriptionPayload,
  ToolCallPayload,
  TurnPayload,
  WriterOptions,
} from "./types";

// ---------------------------------------------------------------------------
// Prepared statement bundle
// ---------------------------------------------------------------------------

// All statements are prepared once at open time and reused for every write.
// This avoids re-parsing SQL on each call and surfaces SQL errors immediately
// at open time rather than at the first write.
type PreparedStatements = {
  upsertHarness: Database.Statement;
  upsertSession: Database.Statement;
  upsertTurn: Database.Statement;
  upsertLlmMessage: Database.Statement;
  upsertSubscription: Database.Statement;
  upsertToolCall: Database.Statement;
  insertRawEvent: Database.Statement;
};

function prepareStatements(db: Database.Database): PreparedStatements {
  return {
    // harnesses: PK is name; first_seen_at is set only on first insert.
    upsertHarness: db.prepare(`
      INSERT INTO harnesses
        (name, display_name, version, integration_version, first_seen_at, last_seen_at)
      VALUES
        ($name, $displayName, $version, $integrationVersion, $now, $now)
      ON CONFLICT (name) DO UPDATE SET
        display_name        = excluded.display_name,
        version             = excluded.version,
        integration_version = excluded.integration_version,
        last_seen_at        = excluded.last_seen_at
    `),

    // sessions: idempotency key (harness_id, harness_session_id).
    // ended_at preserves the existing value if the new value is NULL (session
    // start events arrive before close events, so replaying start is safe).
    upsertSession: db.prepare(`
      INSERT INTO sessions
        (id, harness_id, harness_session_id, session_file, cwd,
         repo_owner, repo_name, repo_remote, started_at, ended_at)
      VALUES
        ($id, $harnessId, $harnessSessionId, $sessionFile, $cwd,
         $repoOwner, $repoName, $repoRemote, $startedAt, $endedAt)
      ON CONFLICT (harness_id, harness_session_id) DO UPDATE SET
        session_file = excluded.session_file,
        cwd          = excluded.cwd,
        repo_owner   = excluded.repo_owner,
        repo_name    = excluded.repo_name,
        repo_remote  = excluded.repo_remote,
        started_at   = excluded.started_at,
        ended_at     = COALESCE(excluded.ended_at, sessions.ended_at)
      RETURNING id
    `),

    // turns: idempotency key (session_id, harness_turn_id).
    upsertTurn: db.prepare(`
      INSERT INTO turns
        (id, session_id, harness_id, harness_turn_id, turn_index,
         started_at, ended_at, provider, model_id)
      VALUES
        ($id, $sessionId, $harnessId, $harnessTurnId, $turnIndex,
         $startedAt, $endedAt, $provider, $modelId)
      ON CONFLICT (session_id, harness_turn_id) DO UPDATE SET
        turn_index = COALESCE(excluded.turn_index, turns.turn_index),
        started_at = excluded.started_at,
        ended_at   = COALESCE(excluded.ended_at, turns.ended_at),
        provider   = COALESCE(excluded.provider, turns.provider),
        model_id   = COALESCE(excluded.model_id, turns.model_id)
      RETURNING id
    `),

    // llm_messages: idempotency key (harness_id, harness_message_id).
    // cost_total_micros is computed by the writer and enforced by a DB CHECK.
    upsertLlmMessage: db.prepare(`
      INSERT INTO llm_messages (
        id, session_id, turn_id, harness_id, harness_message_id,
        ts, provider, model_id,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        cost_input_micros, cost_output_micros,
        cost_cache_read_micros, cost_cache_write_micros,
        cost_total_micros, cost_currency, cost_source, subscription_id
      )
      VALUES (
        $id, $sessionId, $turnId, $harnessId, $harnessMessageId,
        $ts, $provider, $modelId,
        $inputTokens, $outputTokens, $cacheReadTokens, $cacheWriteTokens,
        $costInputMicros, $costOutputMicros,
        $costCacheReadMicros, $costCacheWriteMicros,
        $costTotalMicros, $costCurrency, $costSource, $subscriptionId
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
        cost_currency           = excluded.cost_currency,
        cost_source             = excluded.cost_source,
        subscription_id         = excluded.subscription_id
      RETURNING id
    `),

    // subscriptions: idempotency key (harness_id, plan_name, period_start).
    // period_end and quota_used are updated as the billing period progresses.
    upsertSubscription: db.prepare(`
      INSERT INTO subscriptions
        (id, harness_id, plan_name, period_start, period_end,
         fixed_cost, currency, quota_limit, quota_used, quota_unit)
      VALUES
        ($id, $harnessId, $planName, $periodStart, $periodEnd,
         $fixedCost, $currency, $quotaLimit, $quotaUsed, $quotaUnit)
      ON CONFLICT (harness_id, plan_name, period_start) DO UPDATE SET
        period_end  = excluded.period_end,
        fixed_cost  = excluded.fixed_cost,
        quota_limit = excluded.quota_limit,
        quota_used  = excluded.quota_used,
        quota_unit  = excluded.quota_unit
      RETURNING id
    `),

    // tool_calls: idempotency key (harness_id, harness_tool_call_id).
    upsertToolCall: db.prepare(`
      INSERT INTO tool_calls
        (id, session_id, turn_id, harness_id, harness_tool_call_id,
         tool_name, started_at, ended_at, is_error)
      VALUES
        ($id, $sessionId, $turnId, $harnessId, $harnessToolCallId,
         $toolName, $startedAt, $endedAt, $isError)
      ON CONFLICT (harness_id, harness_tool_call_id) DO UPDATE SET
        turn_id  = COALESCE(excluded.turn_id, tool_calls.turn_id),
        ended_at = COALESCE(excluded.ended_at, tool_calls.ended_at),
        is_error = excluded.is_error
      RETURNING id
    `),

    // raw_events: no idempotency key; AUTOINCREMENT id; insert-only.
    insertRawEvent: db.prepare(`
      INSERT INTO raw_events (harness_id, ts, kind, payload_json)
      VALUES ($harnessId, $ts, $kind, $payloadJson)
    `),
  };
}

// ---------------------------------------------------------------------------
// Internal open outcome type
// ---------------------------------------------------------------------------

// Discriminated union for the result of trying to open the DB at writer start.
type OpenDbOutcome =
  | { kind: "ok"; db: Database.Database; stmts: PreparedStatements }
  | { kind: "too_new"; version: number }
  | { kind: "unavailable"; reason: string };

function tryOpenDb(dbPath: string): OpenDbOutcome {
  try {
    const { db, compatibility } = withBusyRetry(() =>
      openWriterConnection(dbPath)
    );

    if (compatibility.status === "too_new") {
      // Past the forward window — cannot even read the schema safely.
      db.close();
      return { kind: "too_new", version: compatibility.version };
    }

    if (compatibility.status === "degraded") {
      // Schema is ahead of this binary's MAX_KNOWN but within the forward
      // window. Writers must not write to avoid corrupting invariants they
      // don't understand. Fall back to spool so the harness keeps running.
      db.close();
      return {
        kind: "unavailable",
        reason: `schema v${compatibility.version} is in degraded range (max known: ${MAX_KNOWN_SCHEMA_VERSION}); update the package`,
      };
    }

    if (compatibility.status === "needs_migration") {
      runMigrations(db);
      // Re-check after migrations to confirm the runner brought us to ok.
      const after = readSchemaCompatibility(db);
      if (after.status !== "ok") {
        db.close();
        return {
          kind: "unavailable",
          reason: `after migration, schema has unexpected status: ${after.status}`,
        };
      }
    }

    // Schema is ok — prepare statements and return.
    const stmts = prepareStatements(db);
    return { kind: "ok", db, stmts };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { kind: "unavailable", reason };
  }
}

// ---------------------------------------------------------------------------
// DB state union (avoids null-checking db and stmts separately)
// ---------------------------------------------------------------------------

type WriterDbState =
  | { writable: true; db: Database.Database; stmts: PreparedStatements }
  | { writable: false };

// ---------------------------------------------------------------------------
// Internal write helpers (called directly for both live writes and spool drain)
// ---------------------------------------------------------------------------

function writeHarness(
  stmts: PreparedStatements,
  payload: HarnessPayload
): string {
  const now = Date.now();
  stmts.upsertHarness.run({
    name: payload.name,
    displayName: payload.displayName,
    version: payload.version ?? null,
    integrationVersion: payload.integrationVersion ?? null,
    now,
  });
  // harnesses.name IS the primary key; no separate UUID is generated.
  return payload.name;
}

function writeSession(
  stmts: PreparedStatements,
  payload: SessionPayload
): string {
  const id = randomUUID();
  const row = stmts.upsertSession.get({
    id,
    harnessId: payload.harnessId,
    harnessSessionId: payload.harnessSessionId,
    sessionFile: payload.sessionFile ?? null,
    cwd: payload.cwd ?? null,
    repoOwner: payload.repoOwner ?? null,
    repoName: payload.repoName ?? null,
    repoRemote: payload.repoRemote ?? null,
    startedAt: payload.startedAt,
    endedAt: payload.endedAt ?? null,
  }) as { id: string } | undefined;

  // RETURNING always yields the canonical id (new or existing).
  return row?.id ?? id;
}

function writeTurn(stmts: PreparedStatements, payload: TurnPayload): string {
  const id = randomUUID();
  const row = stmts.upsertTurn.get({
    id,
    sessionId: payload.sessionId,
    harnessId: payload.harnessId,
    harnessTurnId: payload.harnessTurnId,
    turnIndex: payload.turnIndex ?? null,
    startedAt: payload.startedAt,
    endedAt: payload.endedAt ?? null,
    provider: payload.provider ?? null,
    modelId: payload.modelId ?? null,
  }) as { id: string } | undefined;

  return row?.id ?? id;
}

function writeLlmMessage(
  stmts: PreparedStatements,
  payload: LlmMessagePayload
): string {
  const id = randomUUID();

  // Compute the four breakdown columns (defaulting omitted fields to 0).
  const costInputMicros = payload.costInputMicros ?? 0;
  const costOutputMicros = payload.costOutputMicros ?? 0;
  const costCacheReadMicros = payload.costCacheReadMicros ?? 0;
  const costCacheWriteMicros = payload.costCacheWriteMicros ?? 0;
  // cost_total_micros is the writer-maintained cached sum. The DB CHECK
  // enforces exact equality with the four breakdown columns.
  const costTotalMicros =
    costInputMicros +
    costOutputMicros +
    costCacheReadMicros +
    costCacheWriteMicros;

  const row = stmts.upsertLlmMessage.get({
    id,
    sessionId: payload.sessionId,
    turnId: payload.turnId ?? null,
    harnessId: payload.harnessId,
    harnessMessageId: payload.harnessMessageId,
    ts: payload.ts,
    provider: payload.provider ?? null,
    modelId: payload.modelId ?? null,
    inputTokens: payload.inputTokens ?? 0,
    outputTokens: payload.outputTokens ?? 0,
    cacheReadTokens: payload.cacheReadTokens ?? 0,
    cacheWriteTokens: payload.cacheWriteTokens ?? 0,
    costInputMicros,
    costOutputMicros,
    costCacheReadMicros,
    costCacheWriteMicros,
    costTotalMicros,
    costCurrency: payload.costCurrency ?? "USD",
    costSource: payload.costSource ?? "unknown",
    subscriptionId: payload.subscriptionId ?? null,
  }) as { id: string } | undefined;

  return row?.id ?? id;
}

function writeSubscription(
  stmts: PreparedStatements,
  payload: SubscriptionPayload
): string {
  const id = randomUUID();
  const row = stmts.upsertSubscription.get({
    id,
    harnessId: payload.harnessId,
    planName: payload.planName,
    periodStart: payload.periodStart,
    periodEnd: payload.periodEnd,
    fixedCost: payload.fixedCost,
    currency: payload.currency ?? "USD",
    quotaLimit: payload.quotaLimit ?? null,
    quotaUsed: payload.quotaUsed ?? null,
    quotaUnit: payload.quotaUnit ?? null,
  }) as { id: string } | undefined;

  return row?.id ?? id;
}

function writeToolCall(
  stmts: PreparedStatements,
  payload: ToolCallPayload
): string {
  const id = randomUUID();
  const row = stmts.upsertToolCall.get({
    id,
    sessionId: payload.sessionId,
    turnId: payload.turnId ?? null,
    harnessId: payload.harnessId,
    harnessToolCallId: payload.harnessToolCallId,
    toolName: payload.toolName,
    startedAt: payload.startedAt,
    endedAt: payload.endedAt ?? null,
    // SQLite INTEGER boolean: 0 = success, 1 = error.
    isError: payload.isError === true ? 1 : 0,
  }) as { id: string } | undefined;

  return row?.id ?? id;
}

function writeRawEvent(
  stmts: PreparedStatements,
  payload: RawEventPayload
): void {
  stmts.insertRawEvent.run({
    harnessId: payload.harnessId,
    ts: payload.ts,
    kind: payload.kind,
    payloadJson: payload.payloadJson,
  });
}

// Placeholder IDs returned by spool-mode record calls are deterministic. During
// drain, parent rows receive their real UUIDs; these maps translate any child
// payloads that referenced spool placeholders back to the canonical DB IDs.
type SpoolDrainIdMaps = {
  sessions: Map<string, string>;
  turns: Map<string, string>;
  subscriptions: Map<string, string>;
};

function spoolSessionKey(payload: SessionPayload): string {
  return `spool:${payload.harnessId}:${payload.harnessSessionId}`;
}

function spoolTurnKey(payload: TurnPayload): string {
  return `spool:${payload.sessionId}:${payload.harnessTurnId}`;
}

function spoolSubscriptionKey(payload: SubscriptionPayload): string {
  return `spool:${payload.harnessId}:${payload.planName}:${payload.periodStart}`;
}

function mapOptionalId(id: string | undefined, map: Map<string, string>): string | undefined {
  if (id == null) {
    return undefined;
  }

  return map.get(id) ?? id;
}

// Routes a spool record to the appropriate internal write function.
// Used during spool drain, where writes happen inside a transaction.
function dispatchSpoolRecord(
  stmts: PreparedStatements,
  maps: SpoolDrainIdMaps,
  record: SpoolRecord
): void {
  switch (record.type) {
    case "harness":
      writeHarness(stmts, record.payload);
      break;
    case "session": {
      const realId = writeSession(stmts, record.payload);
      maps.sessions.set(spoolSessionKey(record.payload), realId);
      break;
    }
    case "turn": {
      const payload: TurnPayload = {
        ...record.payload,
        sessionId: maps.sessions.get(record.payload.sessionId) ?? record.payload.sessionId,
      };
      const realId = writeTurn(stmts, payload);
      maps.turns.set(spoolTurnKey(record.payload), realId);
      break;
    }
    case "llm-message":
      writeLlmMessage(stmts, {
        ...record.payload,
        sessionId: maps.sessions.get(record.payload.sessionId) ?? record.payload.sessionId,
        turnId: mapOptionalId(record.payload.turnId, maps.turns),
        subscriptionId: mapOptionalId(record.payload.subscriptionId, maps.subscriptions),
      });
      break;
    case "subscription": {
      const realId = writeSubscription(stmts, record.payload);
      maps.subscriptions.set(spoolSubscriptionKey(record.payload), realId);
      break;
    }
    case "tool-call":
      writeToolCall(stmts, {
        ...record.payload,
        sessionId: maps.sessions.get(record.payload.sessionId) ?? record.payload.sessionId,
        turnId: mapOptionalId(record.payload.turnId, maps.turns),
      });
      break;
    case "raw-event":
      writeRawEvent(stmts, record.payload);
      break;
  }
}

// ---------------------------------------------------------------------------
// AnalyticsWriter
// ---------------------------------------------------------------------------

/**
 * The primary write interface for the ToTally central store.
 *
 * Instantiate via `AnalyticsWriter.open()`. All record methods are
 * idempotent: replaying the same event is always safe.
 */
export class AnalyticsWriter {
  private readonly dbState: WriterDbState;
  private readonly spool: SpoolWriter;
  private readonly spoolDir: string;
  private closed = false;

  private constructor(
    dbState: WriterDbState,
    spool: SpoolWriter,
    spoolDir: string
  ) {
    this.dbState = dbState;
    this.spool = spool;
    this.spoolDir = spoolDir;
  }

  // -------------------------------------------------------------------------
  // Open
  // -------------------------------------------------------------------------

  /**
   * Opens the central store for writing.
   *
   * Tries to connect to the SQLite DB, runs pending migrations, and drains
   * any closed spool files. If the DB is unavailable or its schema is in the
   * degraded range, the writer falls back to spool-only mode silently.
   *
   * Throws only when the DB schema version is too far ahead of this binary
   * (past the forward window) — this requires updating the package.
   */
  static async open(options?: WriterOptions): Promise<AnalyticsWriter> {
    const dbPath = options?.dbPath ?? defaultDatabasePath();
    const spoolDir = options?.spoolDir ?? defaultSpoolDir();
    const harnessName = options?.harnessName ?? "unknown";

    const spool = new SpoolWriter(spoolDir, harnessName);
    const outcome = tryOpenDb(dbPath);

    if (outcome.kind === "too_new") {
      throw new Error(
        `Database schema v${outcome.version} is too new for this writer ` +
          `(max known: v${MAX_KNOWN_SCHEMA_VERSION}, ` +
          `forward window: ±${SCHEMA_FORWARD_WINDOW}, ` +
          `min supported: v${MIN_SUPPORTED_SCHEMA_VERSION}). ` +
          `Update the token-tally package and rebuild.`
      );
    }

    const dbState: WriterDbState =
      outcome.kind === "ok"
        ? { writable: true, db: outcome.db, stmts: outcome.stmts }
        : { writable: false };

    const writer = new AnalyticsWriter(dbState, spool, spoolDir);

    if (dbState.writable) {
      // Best-effort: drain closed spool files from previous sessions.
      // Drain errors are not fatal — they're left for the next open or manual ingest.
      writer.runSpoolDrain();
    }

    return writer;
  }

  // -------------------------------------------------------------------------
  // Record methods
  // -------------------------------------------------------------------------

  /**
   * Registers or updates a harness identity row.
   * Always call this first so FK constraints on child tables pass.
   *
   * Returns `{ id: payload.name }` — for harnesses, `id === name`.
   */
  async recordHarness(payload: HarnessPayload): Promise<RecordResult> {
    this.assertOpen();
    return this.withDbOrSpool(
      (s) => ({ id: writeHarness(s, payload) }),
      { type: "harness", payload },
      () => ({ id: payload.name })
    );
  }

  /** Records or updates a session. Returns the ToTally session UUID. */
  async recordSession(payload: SessionPayload): Promise<RecordResult> {
    this.assertOpen();
    return this.withDbOrSpool(
      (s) => ({ id: writeSession(s, payload) }),
      { type: "session", payload },
      () => ({ id: `spool:${payload.harnessId}:${payload.harnessSessionId}` })
    );
  }

  /** Records or updates a turn. Returns the ToTally turn UUID. */
  async recordTurn(payload: TurnPayload): Promise<RecordResult> {
    this.assertOpen();
    return this.withDbOrSpool(
      (s) => ({ id: writeTurn(s, payload) }),
      { type: "turn", payload },
      () => ({ id: `spool:${payload.sessionId}:${payload.harnessTurnId}` })
    );
  }

  /**
   * Records or updates an LLM message.
   *
   * The writer computes `cost_total_micros` from the four breakdown fields.
   * Callers must not include `costTotalMicros` — it is always derived.
   */
  async recordLlmMessage(payload: LlmMessagePayload): Promise<RecordResult> {
    this.assertOpen();
    return this.withDbOrSpool(
      (s) => ({ id: writeLlmMessage(s, payload) }),
      { type: "llm-message", payload },
      () => ({ id: `spool:${payload.harnessId}:${payload.harnessMessageId}` })
    );
  }

  /** Records or updates a subscription period. Returns the subscription UUID. */
  async recordSubscription(
    payload: SubscriptionPayload
  ): Promise<RecordResult> {
    this.assertOpen();
    return this.withDbOrSpool(
      (s) => ({ id: writeSubscription(s, payload) }),
      { type: "subscription", payload },
      () => ({ id: `spool:${payload.harnessId}:${payload.planName}:${payload.periodStart}` })
    );
  }

  /** Records or updates a tool call. Returns the tool call UUID. */
  async recordToolCall(payload: ToolCallPayload): Promise<RecordResult> {
    this.assertOpen();
    return this.withDbOrSpool(
      (s) => ({ id: writeToolCall(s, payload) }),
      { type: "tool-call", payload },
      () => ({ id: `spool:${payload.harnessId}:${payload.harnessToolCallId}` })
    );
  }

  /**
   * Records a raw event (opt-in per harness; disabled by default).
   *
   * Writers must maintain a static allowlist of permitted `kind` values and
   * must never include prompts, tool I/O, file contents, or secrets.
   */
  async recordRawEvent(payload: RawEventPayload): Promise<void> {
    this.assertOpen();
    if (this.dbState.writable) {
      const stmts = this.dbState.stmts;
      try {
        withBusyRetry(() => writeRawEvent(stmts, payload));
        return;
      } catch {
        // Fall through to spool.
      }
    }
    this.spool.write({ type: "raw-event", payload });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Rotates the active spool file and drains all closed spool files into the
   * DB (if available). Useful for long-running writers that want to guarantee
   * durability at known checkpoints.
   */
  async flush(): Promise<void> {
    this.assertOpen();
    this.spool.rotate();
    if (this.dbState.writable) {
      this.runSpoolDrain();
    }
  }

  /**
   * Flushes, then closes the database connection.
   *
   * After `close()`, all further record calls will throw.
   */
  async close(): Promise<void> {
    this.assertOpen();
    this.closed = true;

    // Rotate the active spool file so its events can be drained.
    this.spool.rotate();

    if (this.dbState.writable) {
      // Drain any newly-closed spool files (including the one we just rotated).
      this.runSpoolDrain();
      this.dbState.db.close();
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("AnalyticsWriter has been closed");
    }
  }

  /**
   * Tries to execute `dbFn(stmts)` against the live DB, falling back to the
   * spool if the DB is not writable or if the write fails with SQLITE_BUSY.
   *
   * `dbFn`          — receives the prepared statements; returns a RecordResult.
   * `spoolRecord`   — the record to append if the DB write fails.
   * `spoolFallback` — returns a synthetic RecordResult for the spool path
   *                   (the real UUID is not known until drain time).
   */
  private withDbOrSpool(
    dbFn: (stmts: PreparedStatements) => RecordResult,
    spoolRecord: SpoolRecord,
    spoolFallback: () => RecordResult
  ): RecordResult {
    if (this.dbState.writable) {
      // Capture stmts so the closure doesn't re-check this.dbState.writable.
      const stmts = this.dbState.stmts;
      try {
        return withBusyRetry(() => dbFn(stmts));
      } catch {
        // DB write failed (busy after retries, or other error) — spool instead.
      }
    }

    this.spool.write(spoolRecord);
    return spoolFallback();
  }

  /**
   * Drains all closed spool files into the DB. Each file is wrapped in a
   * single transaction. Drain errors are soft (the file is left on disk).
   */
  private runSpoolDrain(): void {
    if (!this.dbState.writable) return;

    const { db, stmts } = this.dbState;
    const drainTransaction = db.transaction((records: SpoolRecord[]) => {
      const maps: SpoolDrainIdMaps = {
        sessions: new Map(),
        turns: new Map(),
        subscriptions: new Map(),
      };

      for (const record of records) {
        dispatchSpoolRecord(stmts, maps, record);
      }
    });

    drainClosedSpoolFiles(this.spoolDir, (records) => {
      drainTransaction(records);
    });
  }
}
