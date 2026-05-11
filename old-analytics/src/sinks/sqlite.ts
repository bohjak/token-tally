/**
 * sqlite.ts — SqliteSink: writes analytics events to a local SQLite database.
 *
 * Uses better-sqlite3 (synchronous API) so `write()` never awaits and the
 * hot path is never blocked on storage I/O.
 *
 * Migration strategy:
 *   A `_meta` table holds a `schema_version` integer.  On `init()`, any
 *   migration file whose version number exceeds the stored version is
 *   executed in order, then the version is bumped.  Migration files live
 *   next to this file under `./migrations/`.
 *
 * Error policy:
 *   Every `write()` call is wrapped in try/catch.  Failed inserts are logged
 *   via `console.warn` and silently dropped — a bad storage write MUST NOT
 *   propagate to the pi hot path.
 *
 * files_touched join note:
 *   `files_touched.tool_call_id` stores the *pi correlation ID*
 *   (ToolCallEvent.tool_call_id / FileTouchedEvent.tool_call_id), not the
 *   row-PK `tool_calls.id`.  Join via `tool_calls.tool_call_id = files_touched.tool_call_id`.
 */

import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { homedir } from "os";
import type {
  AnalyticsConfig,
  AnalyticsEvent,
  AnalyticsSink,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Row types returned by read-side methods
// ---------------------------------------------------------------------------

export type SessionRow = {
  id: string;
  parent_session_id: string | null;
  parent_session_file: string | null;
  started_at: number;
  ended_at: number | null;
  cwd: string;
  repo_root: string | null;
  repo_remote: string | null;
  repo_owner: string | null;
  repo_name: string | null;
  branch_start: string | null;
  branch_end: string | null;
  head_sha_start: string | null;
  head_sha_end: string | null;
  dirty_at_start: number | null;
  pi_version: string;
  hostname: string;
  exit_reason: string | null;
};

export type CommitRow = {
  id: number;
  session_id: string;
  turn_id: string | null;
  sha: string;
  ts: number;
  subject: string;
  files_changed: number;
  insertions: number;
  deletions: number;
};

export type FileTouchedRow = {
  id: number;
  tool_call_id: string;
  session_id: string;
  ts: number;
  path: string;
  op: string;
  bytes: number;
  sensitive: number;
};

export type PrAssociationRow = {
  session_id: string;
  repo_remote: string;
  pr_number: number;
  pr_url: string;
  confidence: number;
  reason: string;
  linked_at: number;
};

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function expandHome(p: string): string {
  return p.startsWith("~") ? homedir() + p.slice(1) : p;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// SqliteSink
// ---------------------------------------------------------------------------

export class SqliteSink implements AnalyticsSink {
  private db: Database.Database | null = null;

  // Prepared statements — populated in prepareStatements() after migration.
  private stmt = {
    // sessions
    insertSession: null as Database.Statement | null,
    patchSession: null as Database.Statement | null,
    endSession: null as Database.Statement | null,
    // branch_transitions
    insertBranchTransition: null as Database.Statement | null,
    // pr_associations
    upsertPr: null as Database.Statement | null,
    // prompts
    insertPrompt: null as Database.Statement | null,
    // turns
    insertTurn: null as Database.Statement | null,
    endTurn: null as Database.Statement | null,
    patchProviderResponse: null as Database.Statement | null,
    // llm_messages
    insertLlmMessage: null as Database.Statement | null,
    // tool_calls
    insertToolCall: null as Database.Statement | null,
    // files_touched
    insertFileTouched: null as Database.Statement | null,
    // commits_made
    insertCommit: null as Database.Statement | null,
    // resource_usage
    insertResourceUsage: null as Database.Statement | null,
  } as const;

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async init(config: AnalyticsConfig): Promise<void> {
    const dbPath = expandHome(config.local.dbPath);
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");

    this.runMigrations();
    this.prepareStatements();
  }

  write(event: AnalyticsEvent): void {
    if (!this.db) {
      console.warn("[analytics:SqliteSink] write() called before init()");
      return;
    }
    try {
      this.dispatch(event);
    } catch (err) {
      console.warn(
        `[analytics:SqliteSink] write failed for event '${event.kind}':`,
        err,
      );
    }
  }

  async flush(): Promise<void> {
    // better-sqlite3 writes are synchronous and immediately durable — no-op.
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  // ── Migrations ────────────────────────────────────────────────────────────

  private runMigrations(): void {
    const db = this.db!;

    db.exec(`
      CREATE TABLE IF NOT EXISTS _meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    const versionRow = db
      .prepare("SELECT value FROM _meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;

    const currentVersion = versionRow ? parseInt(versionRow.value, 10) : 0;

    const migrations = [
      { version: 1, file: join(__dirname, "migrations", "001_init.sql") },
      { version: 2, file: join(__dirname, "migrations", "002_llm_message_model.sql") },
      { version: 3, file: join(__dirname, "migrations", "003_llm_message_cache_retention.sql") },
    ] as const;

    const setVersion = db.prepare(
      "INSERT OR REPLACE INTO _meta(key, value) VALUES ('schema_version', ?)",
    );

    for (const m of migrations) {
      if (m.version > currentVersion) {
        const sql = readFileSync(m.file, "utf-8");
        db.exec(sql);
        setVersion.run(String(m.version));
      }
    }
  }

  // ── Prepared statements ───────────────────────────────────────────────────

  private prepareStatements(): void {
    const db = this.db!;

    (this.stmt as Record<string, Database.Statement | null>).insertSession =
      db.prepare(`
        INSERT INTO sessions
          (id, parent_session_id, parent_session_file, started_at, cwd,
           repo_root, repo_remote, repo_owner, repo_name,
           branch_start, head_sha_start, dirty_at_start, pi_version, hostname)
        VALUES
          (@id, @parent_session_id, @parent_session_file, @started_at, @cwd,
           @repo_root, @repo_remote, @repo_owner, @repo_name,
           @branch_start, @head_sha_start, @dirty_at_start, @pi_version, @hostname)
      `);

    (this.stmt as Record<string, Database.Statement | null>).patchSession =
      db.prepare(`
        UPDATE sessions SET
          repo_root      = @repo_root,
          repo_remote    = @repo_remote,
          repo_owner     = @repo_owner,
          repo_name      = @repo_name,
          branch_start   = @branch_start,
          head_sha_start = @head_sha_start,
          dirty_at_start = @dirty_at_start
        WHERE id = @session_id
      `);

    (this.stmt as Record<string, Database.Statement | null>).endSession =
      db.prepare(`
        UPDATE sessions SET
          ended_at    = @ended_at,
          branch_end  = @branch_end,
          head_sha_end = @head_sha_end,
          exit_reason = @exit_reason
        WHERE id = @session_id
      `);

    (
      this.stmt as Record<string, Database.Statement | null>
    ).insertBranchTransition = db.prepare(`
      INSERT INTO branch_transitions (session_id, ts, turn_id, from_branch, to_branch)
      VALUES (@session_id, @ts, @turn_id, @from_branch, @to_branch)
    `);

    (this.stmt as Record<string, Database.Statement | null>).upsertPr =
      db.prepare(`
        INSERT INTO pr_associations
          (session_id, repo_remote, pr_number, pr_url, confidence, reason, linked_at)
        VALUES
          (@session_id, @repo_remote, @pr_number, @pr_url, @confidence, @reason, @linked_at)
        ON CONFLICT(session_id, pr_number) DO UPDATE SET
          confidence = max(confidence, excluded.confidence),
          reason     = CASE
                         WHEN excluded.confidence > confidence THEN excluded.reason
                         ELSE reason
                       END,
          pr_url     = excluded.pr_url,
          linked_at  = excluded.linked_at
      `);

    (this.stmt as Record<string, Database.Statement | null>).insertPrompt =
      db.prepare(`
        INSERT INTO prompts
          (id, session_id, ts, source, command, slash_kind,
           text_len, text_sha256, image_count)
        VALUES
          (@id, @session_id, @ts, @source, @command, @slash_kind,
           @text_len, @text_sha256, @image_count)
      `);

    (this.stmt as Record<string, Database.Statement | null>).insertTurn =
      db.prepare(`
        INSERT INTO turns
          (id, prompt_id, session_id, idx, started_at,
           model_id, provider, thinking_level)
        VALUES
          (@id, @prompt_id, @session_id, @idx, @started_at,
           @model_id, @provider, @thinking_level)
      `);

    (this.stmt as Record<string, Database.Statement | null>).endTurn =
      db.prepare(`
        UPDATE turns SET
          ended_at       = @ended_at,
          model_id       = @model_id,
          provider       = @provider,
          thinking_level = @thinking_level,
          stop_reason    = @stop_reason
        WHERE id = @turn_id
      `);

    (
      this.stmt as Record<string, Database.Statement | null>
    ).patchProviderResponse = db.prepare(`
      UPDATE turns SET
        http_status         = @http_status,
        ratelimit_remaining = @ratelimit_remaining,
        ratelimit_reset     = @ratelimit_reset
      WHERE id = @turn_id
    `);

    (this.stmt as Record<string, Database.Statement | null>).insertLlmMessage =
      db.prepare(`
        INSERT INTO llm_messages
          (id, turn_id, session_id, role, ts,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
           cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total,
           cache_write_retention, time_to_first_token_ms, total_duration_ms, stop_reason,
           model_id, provider)
        VALUES
          (@id, @turn_id, @session_id, @role, @ts,
           @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens,
           @cost_input, @cost_output, @cost_cache_read, @cost_cache_write, @cost_total,
           @cache_write_retention, @time_to_first_token_ms, @total_duration_ms, @stop_reason,
           @model_id, @provider)
      `);

    (this.stmt as Record<string, Database.Statement | null>).insertToolCall =
      db.prepare(`
        INSERT INTO tool_calls
          (id, turn_id, session_id, tool_call_id, name,
           started_at, ended_at, duration_ms, is_error,
           input_bytes, output_bytes, error_kind)
        VALUES
          (@id, @turn_id, @session_id, @tool_call_id, @name,
           @started_at, @ended_at, @duration_ms, @is_error,
           @input_bytes, @output_bytes, @error_kind)
      `);

    (
      this.stmt as Record<string, Database.Statement | null>
    ).insertFileTouched = db.prepare(`
      INSERT INTO files_touched
        (tool_call_id, session_id, ts, path, op, bytes, sensitive)
      VALUES
        (@tool_call_id, @session_id, @ts, @path, @op, @bytes, @sensitive)
    `);

    (this.stmt as Record<string, Database.Statement | null>).insertCommit =
      db.prepare(`
        INSERT INTO commits_made
          (session_id, turn_id, sha, ts, subject,
           files_changed, insertions, deletions)
        VALUES
          (@session_id, @turn_id, @sha, @ts, @subject,
           @files_changed, @insertions, @deletions)
      `);

    (
      this.stmt as Record<string, Database.Statement | null>
    ).insertResourceUsage = db.prepare(`
      INSERT INTO resource_usage (session_id, ts, label, kind, name)
      VALUES (@session_id, @ts, @label, @kind, @name)
    `);
  }

  // ── Event dispatch ────────────────────────────────────────────────────────

  private dispatch(event: AnalyticsEvent): void {
    switch (event.kind) {
      // ── Session ────────────────────────────────────────────────────────────
      case "session_start":
        this.stmt.insertSession!.run({
          id: event.id,
          parent_session_id: event.parent_session_id,
          parent_session_file: event.parent_session_file,
          started_at: event.started_at,
          cwd: event.cwd,
          repo_root: event.repo_root,
          repo_remote: event.repo_remote,
          repo_owner: event.repo_owner,
          repo_name: event.repo_name,
          branch_start: event.branch_start,
          head_sha_start: event.head_sha_start,
          dirty_at_start: event.dirty_at_start,
          pi_version: event.pi_version,
          hostname: event.hostname,
        });
        break;

      case "session_patch":
        this.stmt.patchSession!.run({
          session_id: event.session_id,
          repo_root: event.repo_root,
          repo_remote: event.repo_remote,
          repo_owner: event.repo_owner,
          repo_name: event.repo_name,
          branch_start: event.branch_start,
          head_sha_start: event.head_sha_start,
          dirty_at_start: event.dirty_at_start,
        });
        break;

      case "session_end":
        this.stmt.endSession!.run({
          session_id: event.session_id,
          ended_at: event.ended_at,
          branch_end: event.branch_end,
          head_sha_end: event.head_sha_end,
          exit_reason: event.exit_reason,
        });
        break;

      // ── Branch ─────────────────────────────────────────────────────────────
      case "branch_transition":
        this.stmt.insertBranchTransition!.run({
          session_id: event.session_id,
          ts: event.ts,
          turn_id: event.turn_id,
          from_branch: event.from_branch,
          to_branch: event.to_branch,
        });
        break;

      // ── PR ─────────────────────────────────────────────────────────────────
      case "pr_association":
        this.stmt.upsertPr!.run({
          session_id: event.session_id,
          repo_remote: event.repo_remote,
          pr_number: event.pr_number,
          pr_url: event.pr_url,
          confidence: event.confidence,
          reason: event.reason,
          linked_at: event.ts,
        });
        break;

      // ── Prompt ─────────────────────────────────────────────────────────────
      case "prompt":
        this.stmt.insertPrompt!.run({
          id: event.id,
          session_id: event.session_id,
          ts: event.ts,
          source: event.source,
          command: event.command,
          slash_kind: event.slash_kind,
          text_len: event.text_len,
          text_sha256: event.text_sha256,
          image_count: event.image_count,
        });
        break;

      // ── Turn ───────────────────────────────────────────────────────────────
      case "turn_start":
        this.stmt.insertTurn!.run({
          id: event.id,
          prompt_id: event.prompt_id,
          session_id: event.session_id,
          idx: event.idx,
          started_at: event.started_at,
          model_id: event.model_id,
          provider: event.provider,
          thinking_level: event.thinking_level,
        });
        break;

      case "turn_end":
        this.stmt.endTurn!.run({
          turn_id: event.turn_id,
          ended_at: event.ended_at,
          model_id: event.model_id,
          provider: event.provider,
          thinking_level: event.thinking_level,
          stop_reason: event.stop_reason,
        });
        break;

      case "provider_response":
        this.stmt.patchProviderResponse!.run({
          turn_id: event.turn_id,
          http_status: event.http_status,
          ratelimit_remaining: event.ratelimit_remaining,
          ratelimit_reset: event.ratelimit_reset,
        });
        break;

      // ── LLM message ────────────────────────────────────────────────────────
      case "llm_message":
        this.stmt.insertLlmMessage!.run({
          id: event.id,
          turn_id: event.turn_id,
          session_id: event.session_id,
          role: event.role,
          ts: event.ts,
          input_tokens: event.input_tokens,
          output_tokens: event.output_tokens,
          cache_read_tokens: event.cache_read_tokens,
          cache_write_tokens: event.cache_write_tokens,
          cost_input: event.cost_input,
          cost_output: event.cost_output,
          cost_cache_read: event.cost_cache_read,
          cost_cache_write: event.cost_cache_write,
          cost_total: event.cost_total,
          cache_write_retention: event.cache_write_retention ?? null,
          time_to_first_token_ms: event.time_to_first_token_ms,
          total_duration_ms: event.total_duration_ms,
          stop_reason: event.stop_reason,
          model_id: event.model_id ?? null,
          provider: event.provider ?? null,
        });
        break;

      // ── Tool calls ─────────────────────────────────────────────────────────
      case "tool_call":
        this.stmt.insertToolCall!.run({
          id: event.id,
          turn_id: event.turn_id,
          session_id: event.session_id,
          tool_call_id: event.tool_call_id,
          name: event.name,
          started_at: event.started_at,
          ended_at: event.ended_at,
          duration_ms: event.duration_ms,
          is_error: event.is_error ? 1 : 0,
          input_bytes: event.input_bytes,
          output_bytes: event.output_bytes,
          error_kind: event.error_kind,
        });
        break;

      case "file_touched":
        this.stmt.insertFileTouched!.run({
          tool_call_id: event.tool_call_id,
          session_id: event.session_id,
          ts: event.ts,
          path: event.path,
          op: event.op,
          bytes: event.bytes,
          sensitive: event.sensitive ? 1 : 0,
        });
        break;

      // ── Tool side-effect: marker event — NDJSON only, no DB row ───────────
      case "tool_side_effect":
        // Intentional no-op: this event is persisted in NDJSON for replay and
        // consumed by T13/T15 to trigger eager PR linking, but it has no
        // dedicated table in SQLite.
        break;

      // ── Commits ────────────────────────────────────────────────────────────
      case "commit_made":
        this.stmt.insertCommit!.run({
          session_id: event.session_id,
          turn_id: event.turn_id,
          sha: event.sha,
          ts: event.ts,
          subject: event.subject,
          files_changed: event.files_changed,
          insertions: event.insertions,
          deletions: event.deletions,
        });
        break;

      // ── Model / thinking-level → resource_usage ────────────────────────────
      case "model_select":
        this.stmt.insertResourceUsage!.run({
          session_id: event.session_id,
          ts: event.ts,
          label: "model_select",
          kind: "model",
          name: event.model_id,
        });
        break;

      case "thinking_level_select":
        this.stmt.insertResourceUsage!.run({
          session_id: event.session_id,
          ts: event.ts,
          label: "thinking_level_select",
          kind: "thinking_level",
          name: event.thinking_level,
        });
        break;

      case "resource_used":
        this.stmt.insertResourceUsage!.run({
          session_id: event.session_id,
          ts: event.ts,
          label: event.label,
          kind: event.kind_,
          name: event.name,
        });
        break;

      default: {
        // Exhaustiveness check: TypeScript narrows `event` to `never` here if
        // all variants are handled.  At runtime, unknown future event kinds
        // are silently ignored rather than crashing the hot path.
        const _: never = event;
        void _;
        break;
      }
    }
  }

  // ── Read-side query methods ───────────────────────────────────────────────
  // Used by T13 (PrLinker) and T14 (/usage command).

  // The read-side methods below are tolerant of post-close calls: PrLinker
  // (T13) is a best-effort background reconciler whose async exec calls (`gh`,
  // `git`) may resolve after session_shutdown has already closed the sink.
  // Returning empty results in that case lets in-flight sweeps wind down
  // gracefully instead of throwing.

  /** Returns all commits recorded for the given session, oldest-first. */
  getCommitsForSession(sessionId: string): CommitRow[] {
    if (!this.db) return [];
    return this.db.prepare(
      "SELECT * FROM commits_made WHERE session_id = ? ORDER BY ts ASC",
    ).all(sessionId) as CommitRow[];
  }

  /** Returns all files touched in the given session, ordered by ts. */
  getFilesTouchedForSession(sessionId: string): FileTouchedRow[] {
    if (!this.db) return [];
    return this.db.prepare(
      "SELECT * FROM files_touched WHERE session_id = ? ORDER BY ts ASC",
    ).all(sessionId) as FileTouchedRow[];
  }

  /**
   * Returns sessions for a given repo remote that started at or after `ts`
   * (Unix ms), ordered by started_at ascending.
   */
  findSessionsByRepoSince(repo: string, ts: number): SessionRow[] {
    if (!this.db) return [];
    return this.db.prepare(
      "SELECT * FROM sessions WHERE repo_remote = ? AND started_at >= ? ORDER BY started_at ASC",
    ).all(repo, ts) as SessionRow[];
  }

  /** Returns the session row with the given id, or undefined if not found. */
  getSessionById(id: string): SessionRow | undefined {
    if (!this.db) return undefined;
    return this.db.prepare(
      "SELECT * FROM sessions WHERE id = ?",
    ).get(id) as SessionRow | undefined;
  }

  /**
   * Upserts a PR association row.  On conflict (same session_id + pr_number),
   * only upgrades confidence — never downgrades.  Tolerant of post-close calls.
   */
  upsertPrAssociation(row: PrAssociationRow): void {
    if (!this.db || !this.stmt.upsertPr) return;
    try {
      this.stmt.upsertPr.run({
        session_id: row.session_id,
        repo_remote: row.repo_remote,
        pr_number: row.pr_number,
        pr_url: row.pr_url,
        confidence: row.confidence,
        reason: row.reason,
        linked_at: row.linked_at,
      });
    } catch (err) {
      console.warn("[analytics:SqliteSink] upsertPrAssociation failed:", err);
    }
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private assertOpen(): void {
    if (!this.db) throw new Error("SqliteSink not initialized — call init() first");
  }

  /**
   * Expose the underlying database handle for use by T14 (/usage command)
   * which needs to run arbitrary aggregation queries.
   * Returns null before init() is called.
   */
  get database(): Database.Database | null {
    return this.db;
  }
}
