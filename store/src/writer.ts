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

import Database from "better-sqlite3";
import {
  MAX_KNOWN_SCHEMA_VERSION,
  MIN_SUPPORTED_SCHEMA_VERSION,
  SCHEMA_FORWARD_WINDOW,
  openWriterConnection,
  readSchemaCompatibility,
  withBusyRetry,
} from "./connection";
import {
  PreparedStatements,
  drainBatch,
  prepareStatements,
  writeHarness,
  writeSession,
  writeTurn,
  writeLlmMessage,
  writeSubscription,
  writeToolCall,
  writeRawEvent,
} from "./drain-engine";
import { runMigrations } from "./migrations";
import { defaultDatabasePath, defaultSpoolDir } from "./paths";
import { SpoolWriter, drainClosedSpoolFiles, drainSingleSpoolFile, quarantineSpoolFile, defaultFailedDir } from "./spool";
import type { BoundedDrainOptions, SpoolRecord } from "./spool";
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
// Drain options
// ---------------------------------------------------------------------------

/**
 * Controls when and how aggressively AnalyticsWriter drains closed spool files.
 *
 * The default for all fields is `false` / no limit. Hot-path callers —
 * one-shot CLI `record`, Pi/Cursor/Claude hooks — should accept the defaults
 * so they never trigger an expensive full-directory scan.
 *
 * Long-running or background processes — the drain daemon, manual ingest —
 * should pass `{ onOpen: true }` or `{ onClose: true }` to opt in to
 * full-directory drain, and can add `maxFiles` / `maxMs` to bound each pass.
 */
export type WriterDrainOptions = BoundedDrainOptions & {
  /**
   * Drain all closed spool files in the spool directory when the writer opens.
   * Default: false.
   *
   * Set to `true` for the drain daemon, manual `token-tally ingest`, and any
   * caller that deliberately wants to sweep up accumulated spool files.
   */
  onOpen?: boolean;

  /**
   * Drain all closed spool files in the spool directory when the writer closes.
   * Default: false.
   *
   * Note: the writer ALWAYS drains its own just-rotated file on close
   * regardless of this flag — that is bounded to one file and is the
   * lightweight durability guarantee. This flag adds a full-directory sweep
   * on top of the per-writer drain.
   */
  onClose?: boolean;
};

/**
 * Options accepted by `AnalyticsWriter.open()`.
 *
 * Extends `WriterOptions` with explicit drain control. All drain fields
 * default to off so short-lived hot-path callers pay no spool-scan overhead.
 */
export type WriterOpenOptions = WriterOptions & {
  /**
   * Drain configuration for this writer. Omit (or leave `undefined`) for the
   * safe hot-path default: no full-directory drain on open or close, only the
   * writer's own just-rotated file is drained on close.
   */
  drain?: WriterDrainOptions;
};

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
  | { writable: false; reason?: string };

// ---------------------------------------------------------------------------
// Retryable-error classification
// ---------------------------------------------------------------------------

/**
 * Returns true for SQLite errors that are safe to spool for later retry:
 *   SQLITE_BUSY and variants (SQLITE_BUSY_SNAPSHOT) — lock held by another writer.
 *   SQLITE_IOERR family — I/O error, potentially transient.
 *
 * Returns false for permanent errors that will fail on every replay attempt:
 *   SQLITE_CONSTRAINT — FK violation, CHECK violation, UNIQUE conflict.
 *   SQLITE_ERROR      — binding error, SQL syntax error.
 *
 * Non-retryable errors must propagate so callers receive a clear failure
 * instead of silently discarding data into a spool that will re-fail on drain.
 */
function isRetryableSqliteError(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== "string") return false;
  return code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_IOERR");
}

// (Low-level write functions and drain engine live in drain-engine.ts.
//  They are imported at the top of this file; see that module for documentation.)

// ---------------------------------------------------------------------------
// Public status type
// ---------------------------------------------------------------------------

/**
 * Reported by `AnalyticsWriter.status`. Consumed by ingest functions and the
 * migrate CLI to detect when the writer is in spool-only mode.
 */
export type WriterStatus = {
  /** true when the writer holds an open DB connection and writes go to SQLite. */
  writable: boolean;
  /**
   * When writable is false, the human-readable reason the DB connection could
   * not be established (schema too new, file corrupt, persistent BUSY, etc.).
   */
  reason?: string;
};

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
  private readonly drainOptions: WriterDrainOptions;
  private closed = false;

  private constructor(
    dbState: WriterDbState,
    spool: SpoolWriter,
    spoolDir: string,
    drainOptions: WriterDrainOptions
  ) {
    this.dbState = dbState;
    this.spool = spool;
    this.spoolDir = spoolDir;
    this.drainOptions = drainOptions;
  }

  // -------------------------------------------------------------------------
  // Open
  // -------------------------------------------------------------------------

  /**
   * Opens the central store for writing.
   *
   * Tries to connect to the SQLite DB and runs pending migrations. If the DB
   * is unavailable or its schema is in the degraded range the writer falls
   * back to spool-only mode silently.
   *
   * By default, no full-directory spool drain is performed on open or close.
   * Hot-path callers (one-shot CLI, harness hooks) rely on this default so
   * they never pay a directory-scan penalty.
   *
   * Pass `drain: { onOpen: true }` for the drain daemon or manual ingest to
   * sweep up accumulated spool files. `drain: { maxFiles, maxMs }` bounds
   * each pass.
   *
   * On `close()`, the writer ALWAYS drains its own just-rotated spool file
   * (one file, bounded by definition) regardless of drain options. This is
   * the lightweight per-writer durability guarantee.
   *
   * Throws only when the DB schema version is too far ahead of this binary
   * (past the forward window) — that requires updating the package.
   */
  static async open(options?: WriterOpenOptions): Promise<AnalyticsWriter> {
    const dbPath = options?.dbPath ?? defaultDatabasePath();
    const spoolDir = options?.spoolDir ?? defaultSpoolDir();
    const harnessName = options?.harnessName ?? "unknown";
    // Capture drain options once; default to no full-directory drain.
    const drainOptions: WriterDrainOptions = options?.drain ?? {};

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
        : {
            writable: false,
            reason: outcome.kind === "unavailable" ? outcome.reason : undefined,
          };

    const writer = new AnalyticsWriter(dbState, spool, spoolDir, drainOptions);

    if (dbState.writable && drainOptions.onOpen === true) {
      // Full-directory drain is opt-in. Errors are soft — left for the daemon
      // or manual ingest. Bounds (maxFiles, maxMs) are respected.
      writer.runSpoolDrain();
    }

    return writer;
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  /**
   * Reports whether the writer has an active DB connection.
   *
   * `writable: false` means the writer opened in spool-only mode (DB was
   * unavailable at open time). In that mode all record calls append to the
   * NDJSON spool file rather than writing directly to SQLite.
   *
   * Ingest functions and the migrate CLI consume this to detect false-success
   * scenarios where no rows would actually reach the database.
   */
  get status(): WriterStatus {
    if (this.dbState.writable) {
      return { writable: true };
    }
    return { writable: false, reason: this.dbState.reason };
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
      } catch (err) {
        // Same retryability policy as withDbOrSpool: only spool on BUSY / I/O.
        // Constraint or binding errors propagate to the caller.
        if (!isRetryableSqliteError(err)) {
          throw err;
        }
        // Fall through to spool.
      }
    }
    this.spool.write({ type: "raw-event", payload });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Rotates the active spool file and drains it into the DB (if available).
   *
   * Only the writer's own just-rotated file is drained by default (bounded
   * to one file). Set `drain: { onClose: true }` in `open()` options to also
   * trigger a full-directory sweep.
   *
   * Useful for long-running writers that want durability at known checkpoints.
   */
  async flush(): Promise<void> {
    this.assertOpen();
    const closedPath = this.spool.rotate();
    if (this.dbState.writable) {
      // Always drain the writer's own rotated file (one file, low overhead).
      if (closedPath != null) {
        this.runSingleFileDrain(closedPath);
      }
      // Full-directory drain only when the caller explicitly opted in.
      if (this.drainOptions.onClose === true) {
        this.runSpoolDrain();
      }
    }
  }

  /**
   * Flushes, then closes the database connection.
   *
   * The writer's own active spool file is rotated and drained (bounded to that
   * one file). A full-directory drain is performed only when `drain.onClose`
   * was set in `open()` options — hot-path callers leave accumulated spool
   * files for the daemon or manual ingest.
   *
   * After `close()`, all further record calls will throw.
   */
  async close(): Promise<void> {
    this.assertOpen();
    this.closed = true;

    // Rotate the active spool file so its events are eligible for drain.
    const closedPath = this.spool.rotate();

    if (this.dbState.writable) {
      // Always drain the writer's own just-rotated file (bounded to one file).
      // This is the lightweight per-writer durability guarantee: records that
      // fell back to spool during this session are committed before the DB
      // connection closes, without scanning unrelated closed files.
      if (closedPath != null) {
        this.runSingleFileDrain(closedPath);
      }
      // Full-directory drain is opt-in to avoid scanning thousands of old
      // files on every hook invocation or one-shot record call.
      if (this.drainOptions.onClose === true) {
        this.runSpoolDrain();
      }
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
      } catch (err) {
        // Only spool on retryable errors (SQLITE_BUSY budget exhausted, I/O).
        // Non-retryable errors (FK violations, CHECK violations, binding errors)
        // propagate to the caller: they indicate bad payload data that will
        // fail the same way on every drain attempt and must never be silently
        // discarded into a spool that can never be committed.
        if (!isRetryableSqliteError(err)) {
          throw err;
        }
        // Retryable (SQLITE_BUSY after budget exhausted) — fall through to spool.
      }
    }

    this.spool.write(spoolRecord);
    return spoolFallback();
  }

  /**
   * Applies a batch of SpoolRecords to the database in a single transaction.
   *
   * This is the canonical drain entry point shared by all callers:
   * `ingestFile`, `ingestDir`, and the writer's own internal drain paths.
   * Using a single engine ensures that T10 legacy cross-file spool-ID repair
   * is applied uniformly — the same `.closed` file always produces the same
   * result regardless of which path drains it.
   *
   * Throws on first non-repairable record (FK violation, unparseable synthetic
   * ID, etc.). The caller is responsible for catching the error and quarantining
   * the file so it is not retried indefinitely.
   *
   * Must only be called when the writer has a live DB connection. Callers that
   * get a writer from `AnalyticsWriter.open()` should check `writer.status.writable`
   * before calling (as `ingestFile` and `ingestDir` already do).
   */
  drainRecords(records: SpoolRecord[]): void {
    if (!this.dbState.writable) {
      throw new Error("drainRecords requires a writable DB connection; open the writer with a reachable DB path");
    }
    const { db, stmts } = this.dbState;
    // Wrap in a transaction so either all records in the batch commit or none
    // do (atomicity per file). drainBatch itself does NOT open a transaction.
    db.transaction(() => {
      drainBatch(stmts, records);
    })();
  }

  /**
   * Drains all closed spool files into the DB using the canonical drain engine.
   * Each file is processed in its own transaction. Drain errors are soft —
   * failed files are quarantined so they are not retried from the spool dir.
   */
  private runSpoolDrain(): void {
    if (!this.dbState.writable) return;

    const { db, stmts } = this.dbState;
    // Each file gets its own transaction: success commits, failure rolls back
    // that file's writes so no partial data reaches the DB.
    const drainTransaction = db.transaction((records: SpoolRecord[]) => {
      drainBatch(stmts, records);
    });

    drainClosedSpoolFiles(
      this.spoolDir,
      (records) => {
        drainTransaction(records);
      },
      this.drainOptions,
    );
  }

  /**
   * Drains one specific closed spool file into the DB using the canonical drain
   * engine. Used for the writer's own just-rotated file so close/flush can
   * preserve durability without a full-directory scan.
   *
   * If drain fails, the file is quarantined to the adjacent `<spoolDir>.failed/`
   * directory so it is not retried on every subsequent close. If quarantine
   * also fails the file stays in the spool directory for the daemon to inspect.
   */
  private runSingleFileDrain(filePath: string): void {
    if (!this.dbState.writable) return;

    const { db, stmts } = this.dbState;
    const drainTransaction = db.transaction((records: SpoolRecord[]) => {
      drainBatch(stmts, records);
    });

    const result = drainSingleSpoolFile(filePath, (records) => {
      drainTransaction(records);
    });

    if (result.error != null) {
      // Drain failed — quarantine so the file is not retried from spool on
      // every subsequent writer open or close. If quarantine also fails the
      // file stays in the spool directory where the daemon can inspect it.
      const failedDir = defaultFailedDir(this.spoolDir);
      quarantineSpoolFile(filePath, failedDir, result.error.message, result.firstRecord ?? null);
    }
  }
}
