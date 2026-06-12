/**
 * Canonical spool-drain engine for the ToTally central store.
 *
 * This module owns two things:
 *
 *   1. The prepared-statement bundle and low-level write functions that
 *      implement each table upsert. These are consumed by both live record
 *      calls (via AnalyticsWriter) and the drain engine.
 *
 *   2. `drainBatch` — the single, authoritative function for replaying a
 *      batch of SpoolRecords into the database. It must always be called
 *      inside a SQLite transaction provided by the caller.
 *
 * ## Why one engine?
 *
 * Before this module existed, two separate code paths drained spool files:
 *
 *   - Writer-internal `dispatchSpoolRecord` (writer.ts): used prepared
 *     statements directly; transactional; fast. Did NOT implement the T10
 *     legacy cross-file synthetic-ID repair, so cross-file spool references
 *     would trigger an FK violation and quarantine.
 *
 *   - Ingest `applyRecordsToWriter` (ingest.ts): called the public record
 *     methods one-by-one; included T10 repair. Not wrapped in a transaction
 *     (each public method call was its own implicit transaction).
 *
 * The same `.ndjson.closed` file therefore produced different outcomes
 * depending on who drained it — a correctness bug.
 *
 * `drainBatch` fixes this by merging both paths: it is transactional and
 * prepared-statement-based (fast path) AND includes T10 repair (correctness).
 *
 * ## Caller contract
 *
 * The caller MUST wrap the `drainBatch` call in a `db.transaction(...)` so
 * that either all records in a file commit or none do. The function itself
 * does NOT open or commit a transaction — that responsibility belongs to the
 * caller, which has the right context for bounding the transaction scope.
 *
 * On any unresolvable synthetic ID or SQLite error, `drainBatch` throws.
 * The caller's transaction rolls back automatically. The caller is expected
 * to quarantine the file so it is not retried indefinitely.
 */

import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import { redactRemoteUrl } from "./util";
import type { SpoolRecord } from "./spool";
import type {
  HarnessPayload,
  LlmMessagePayload,
  RawEventPayload,
  SessionPayload,
  SubscriptionPayload,
  ToolCallPayload,
  TurnPayload,
} from "./types";

// ---------------------------------------------------------------------------
// Prepared statement bundle
// ---------------------------------------------------------------------------

// All statements are prepared once at open time and reused for every write.
// This avoids re-parsing SQL on each call and surfaces SQL errors immediately
// at open time rather than at the first write.
export type PreparedStatements = {
  upsertHarness: Database.Statement;
  upsertSession: Database.Statement;
  upsertTurn: Database.Statement;
  upsertLlmMessage: Database.Statement;
  upsertSubscription: Database.Statement;
  upsertToolCall: Database.Statement;
  insertRawEvent: Database.Statement;
};

export function prepareStatements(db: Database.Database): PreparedStatements {
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
    // All nullable and time fields use COALESCE / NULLIF so that close or replay
    // events (which may carry null repo fields or startedAt = 0) can never
    // clobber values that were written by an earlier, richer event:
    //   started_at   — NULLIF(excluded, 0) guards against the close-event
    //                  sentinel value of 0; falls back to the stored value.
    //   session_file, cwd, repo_* — prefer the incoming value only when it is
    //                  non-null; otherwise keep what is already stored.
    //   ended_at     — existing behaviour: keep stored value when new is null.
    upsertSession: db.prepare(`
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
    `),

    // turns: idempotency key (session_id, harness_turn_id).
    // started_at uses COALESCE/NULLIF for the same reason as sessions above.
    upsertTurn: db.prepare(`
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
        -- Preserve stored turn_id when the incoming row carries NULL (e.g. a
        -- backfill pass that updates only tokens/costs). A non-null incoming
        -- turn_id always wins, so full-attribution replays work correctly.
        turn_id                 = COALESCE(excluded.turn_id, llm_messages.turn_id),
        -- Preserve original event ts when the incoming row uses ts=0 as the
        -- sentinel meaning "do not change timestamp". Writers that wish to
        -- update tokens/costs without altering the original event time pass
        -- ts=0. A real (non-zero) timestamp always wins.
        ts                      = COALESCE(NULLIF(excluded.ts, 0), llm_messages.ts),
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
// Token / cost coercion
// ---------------------------------------------------------------------------

/**
 * Rounds a numeric payload field to the nearest integer and validates that
 * the result is non-negative and finite.
 *
 * - Float values are rounded with Math.round (0.5 rounds up). This is the
 *   documented contract for all cost and token fields; callers that need
 *   exact integers should pass them as such.
 * - Negative values and non-finite values (NaN, Infinity) are rejected by
 *   throwing RangeError. These indicate a bug in the writer plugin.
 * - undefined / null coerces to 0.
 */
export function coerceToNonNegativeInt(val: number | undefined | null, fieldName: string): number {
  if (val === undefined || val === null) return 0;
  const rounded = Math.round(val);
  if (!isFinite(rounded) || rounded < 0) {
    throw new RangeError(
      `LlmMessagePayload: ${fieldName} must be a non-negative finite number; got ${val}`
    );
  }
  return rounded;
}

// ---------------------------------------------------------------------------
// Low-level write functions
// ---------------------------------------------------------------------------
//
// These are module-level functions (not methods) so that both live writes
// (via AnalyticsWriter.withDbOrSpool) and the drain engine can call them
// directly without going through the public record API.

export function writeHarness(
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

export function writeSession(
  stmts: PreparedStatements,
  payload: SessionPayload
): string {
  const id = randomUUID();
  // Redact any credentials embedded in the remote URL before storage.
  const repoRemote =
    payload.repoRemote != null ? redactRemoteUrl(payload.repoRemote) : null;
  const row = stmts.upsertSession.get({
    id,
    harnessId: payload.harnessId,
    harnessSessionId: payload.harnessSessionId,
    sessionFile: payload.sessionFile ?? null,
    cwd: payload.cwd ?? null,
    repoOwner: payload.repoOwner ?? null,
    repoName: payload.repoName ?? null,
    repoRemote,
    startedAt: payload.startedAt,
    endedAt: payload.endedAt ?? null,
  }) as { id: string } | undefined;

  // RETURNING always yields the canonical id (new or existing).
  return row?.id ?? id;
}

export function writeTurn(stmts: PreparedStatements, payload: TurnPayload): string {
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

export function writeLlmMessage(
  stmts: PreparedStatements,
  payload: LlmMessagePayload
): string {
  const id = randomUUID();

  // Validate and coerce token/cost fields to non-negative integers.
  // Float values are rounded with Math.round (documented contract).
  // Negative or non-finite values throw RangeError — they indicate a bug in
  // the writer plugin and must not be silently stored or spooled.
  const inputTokens = coerceToNonNegativeInt(payload.inputTokens, "inputTokens");
  const outputTokens = coerceToNonNegativeInt(payload.outputTokens, "outputTokens");
  const cacheReadTokens = coerceToNonNegativeInt(payload.cacheReadTokens, "cacheReadTokens");
  const cacheWriteTokens = coerceToNonNegativeInt(payload.cacheWriteTokens, "cacheWriteTokens");
  const costInputMicros = coerceToNonNegativeInt(payload.costInputMicros, "costInputMicros");
  const costOutputMicros = coerceToNonNegativeInt(payload.costOutputMicros, "costOutputMicros");
  const costCacheReadMicros = coerceToNonNegativeInt(payload.costCacheReadMicros, "costCacheReadMicros");
  const costCacheWriteMicros = coerceToNonNegativeInt(payload.costCacheWriteMicros, "costCacheWriteMicros");
  // cost_total_micros is the writer-maintained cached sum. The DB CHECK
  // enforces exact equality with the four breakdown columns. Because all four
  // parts are rounded to integers above, their sum is also an integer and
  // the CHECK strict-equality invariant is always satisfiable.
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
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
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

export function writeSubscription(
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

export function writeToolCall(
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

export function writeRawEvent(
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

// ---------------------------------------------------------------------------
// Spool-drain ID maps and key helpers
// ---------------------------------------------------------------------------

// Placeholder IDs returned by spool-mode record calls are deterministic. During
// drain, parent rows receive their real UUIDs; these maps translate any child
// payloads that referenced spool placeholders back to the canonical DB IDs.
export type DrainIdMaps = {
  sessions: Map<string, string>;
  turns: Map<string, string>;
  subscriptions: Map<string, string>;
};

// The spool-mode session placeholder is: "spool:<harnessId>:<harnessSessionId>"
export function spoolSessionKey(payload: SessionPayload): string {
  return `spool:${payload.harnessId}:${payload.harnessSessionId}`;
}

// The spool-mode turn placeholder is: "spool:<sessionId>:<harnessTurnId>"
// where sessionId may itself be a spool:* placeholder.
export function spoolTurnKey(payload: TurnPayload): string {
  return `spool:${payload.sessionId}:${payload.harnessTurnId}`;
}

export function spoolSubscriptionKey(payload: SubscriptionPayload): string {
  return `spool:${payload.harnessId}:${payload.planName}:${payload.periodStart}`;
}

// ---------------------------------------------------------------------------
// T10 legacy cross-file spool-ID parsers
// ---------------------------------------------------------------------------

// UUID pattern used to detect Case-1 legacy turn IDs (spool:<uuid>:<harnessTurnId>).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parses a legacy synthetic session spool ID back to its natural key.
 *
 * Format: `spool:<harnessId>:<harnessSessionId>`
 *
 * Used by the T10 legacy repair path: when a turn or child record was written
 * to the emergency spool in a different file than its parent session record,
 * the session ID is a synthetic placeholder (`spool:<harnessId>:<path>`) rather
 * than a real DB UUID. This function extracts the natural key so the repair
 * logic can synthesize or look up the parent session row.
 *
 * Returns null for non-spool IDs, malformed IDs, or IDs where harnessId looks
 * suspicious (contains path separators — it should be a simple slug).
 */
function parseLegacySpoolSessionId(
  id: string,
): { harnessId: string; harnessSessionId: string } | null {
  if (!id.startsWith('spool:')) return null;
  const body = id.slice(6); // strip 'spool:'
  const colonIdx = body.indexOf(':');
  if (colonIdx <= 0) return null;
  const harnessId = body.slice(0, colonIdx);
  const harnessSessionId = body.slice(colonIdx + 1);
  if (!harnessSessionId) return null;
  // harnessId must be a simple identifier — no path separators.
  if (harnessId.includes('/') || harnessId.includes('\\')) return null;
  return { harnessId, harnessSessionId };
}

/**
 * Parses a legacy synthetic turn spool ID back to its natural key.
 *
 * Two formats exist in the legacy emergency-spool backlog:
 *
 *   Case 1 — UUID-prefixed (session was already in the DB at write time):
 *     `spool:<uuid>:<harnessTurnId>`
 *
 *   Case 2 — Nested synthetic (session was also in a different spool file):
 *     `spool:spool:<harnessId>:<path>:<path>:t<N>`
 *     The path segment is duplicated because the legacy writer used it as both
 *     the harnessSessionId and the base of the harnessTurnId (`<path>:t<N>`).
 *
 * Returns null when the ID cannot be parsed deterministically. The caller
 * should let these propagate to the quarantine path rather than guessing.
 */
function parseLegacySpoolTurnId(
  id: string,
): { sessionId: string; harnessTurnId: string } | null {
  if (!id.startsWith('spool:')) return null;
  const body = id.slice(6); // strip outer 'spool:'

  // Case 1: UUID-prefixed.
  // The session UUID is exactly 36 chars; the 37th char must be ':'.
  if (body.length > 36 && body[36] === ':') {
    const candidate = body.slice(0, 36);
    if (UUID_RE.test(candidate)) {
      const harnessTurnId = body.slice(37);
      if (harnessTurnId) return { sessionId: candidate, harnessTurnId };
    }
  }

  // Case 2: Nested synthetic session ID.
  // body = "spool:<harnessId>:<path>:<path>:t<N>"
  // (the path appears twice because of how the legacy writer formed the key)
  if (body.startsWith('spool:')) {
    const innerBody = body.slice(6); // strip inner 'spool:'
    const harnessColonIdx = innerBody.indexOf(':');
    if (harnessColonIdx <= 0) return null;
    const harnessId = innerBody.slice(0, harnessColonIdx);
    // harnessId must be a simple identifier — no path separators.
    if (harnessId.includes('/') || harnessId.includes('\\')) return null;
    const afterHarnessId = innerBody.slice(harnessColonIdx + 1);
    // afterHarnessId = "<path>:<path>:t<N>"
    const tMatch = afterHarnessId.match(/:t(\d+)$/);
    if (tMatch == null) return null;
    const beforeT = afterHarnessId.slice(0, afterHarnessId.length - tMatch[0].length);
    // beforeT = "<path>:<path>" — path appears twice, separated by exactly one ':'
    const pathColonIdx = beforeT.indexOf(':');
    if (pathColonIdx <= 0) return null;
    const path1 = beforeT.slice(0, pathColonIdx);
    const path2 = beforeT.slice(pathColonIdx + 1);
    // Validate the path-repetition invariant before trusting the parse.
    if (path1 !== path2) return null;
    const sessionId = `spool:${harnessId}:${path1}`;
    const harnessTurnId = `${path1}:t${tMatch[1]!}`;
    return { sessionId, harnessTurnId };
  }

  return null;
}

// ---------------------------------------------------------------------------
// T10 repair helpers (called inside a transaction by drainBatch)
// ---------------------------------------------------------------------------

/**
 * Resolves a session ID to a real DB UUID.
 *
 * For in-file synthetic IDs: looks up from the maps populated by earlier
 * session records in the same batch.
 *
 * For cross-file synthetic IDs (T10 repair): parses the natural key from the
 * synthetic ID and synthesises the parent harness + session rows using
 * `startedAt = 0` as a sentinel (the upsert COALESCE preserves any existing
 * real timestamp). Caches the result in `maps.sessions`.
 *
 * Throws if the ID starts with "spool:" but cannot be parsed. The caller's
 * transaction rolls back and the file is quarantined.
 */
function resolveOrRepairSession(
  stmts: PreparedStatements,
  maps: DrainIdMaps,
  sessionId: string,
): string {
  // Fast path: already resolved (in-file or previously repaired cross-file).
  const cached = maps.sessions.get(sessionId);
  if (cached != null) return cached;

  // Real UUID — pass through without repair.
  if (!sessionId.startsWith('spool:')) return sessionId;

  // Cross-file synthetic ID: attempt T10 repair.
  const parsed = parseLegacySpoolSessionId(sessionId);
  if (parsed == null) {
    // Cannot parse → throw so the file is quarantined with a clear error.
    throw new Error(
      `Cannot resolve synthetic session ID '${sessionId}': ` +
      `the natural key could not be parsed (harnessId appears to ` +
      `contain path separators or the format is unrecognised). ` +
      `Record quarantined for manual inspection.`
    );
  }

  // Synthesise the harness row (FK required by sessions) and the session row.
  // Both are idempotent upserts; if the rows already exist in the DB the
  // RETURNING clause returns the existing canonical UUID.
  writeHarness(stmts, { name: parsed.harnessId, displayName: parsed.harnessId });
  const realId = writeSession(stmts, {
    harnessId: parsed.harnessId,
    harnessSessionId: parsed.harnessSessionId,
    sessionFile: parsed.harnessSessionId,
    // startedAt = 0 is the sentinel value meaning "do not overwrite an existing
    // real timestamp". The upsert SQL uses COALESCE(NULLIF(0, 0), existing).
    startedAt: 0,
  });

  // Cache so subsequent records in the same batch resolve without another write.
  maps.sessions.set(sessionId, realId);
  return realId;
}

/**
 * Resolves a turn ID to a real DB UUID.
 *
 * Mirrors the session repair logic: checks the in-file map first, then
 * attempts T10 repair for cross-file synthetic IDs. The parent session is
 * also repaired via `resolveOrRepairSession` if it is synthetic.
 *
 * `harnessId` is the harness of the child record requesting the repair — used
 * to synthesise the turn row when the turn's own harnessId is not known from
 * the parsed spool ID alone.
 */
function resolveOrRepairTurn(
  stmts: PreparedStatements,
  maps: DrainIdMaps,
  turnId: string,
  harnessId: string,
): string {
  const cached = maps.turns.get(turnId);
  if (cached != null) return cached;

  if (!turnId.startsWith('spool:')) return turnId;

  const parsed = parseLegacySpoolTurnId(turnId);
  if (parsed == null) {
    throw new Error(
      `Cannot resolve synthetic turn ID '${turnId}': ` +
      `the natural key could not be parsed (format is unrecognised or the ` +
      `path/harnessSessionId repeat invariant was not satisfied). ` +
      `Record quarantined for manual inspection.`
    );
  }

  // Resolve (or repair) the turn's parent session.
  // resolveOrRepairSession handles cross-file repair and caches the result.
  const resolvedSessionId = resolveOrRepairSession(stmts, maps, parsed.sessionId);

  // Synthesise the turn with startedAt = 0 sentinel (same reasoning as session).
  const realId = writeTurn(stmts, {
    harnessId,
    sessionId: resolvedSessionId,
    harnessTurnId: parsed.harnessTurnId,
    startedAt: 0,
  });

  maps.turns.set(turnId, realId);
  return realId;
}

// ---------------------------------------------------------------------------
// Canonical drain engine
// ---------------------------------------------------------------------------

/**
 * Applies a batch of SpoolRecords to the database using prepared statements.
 *
 * This is the single, canonical engine used by ALL drain paths:
 *   - Writer-internal drain (close/flush/onOpen sweep)
 *   - Ingest-path drain (ingestFile, ingestDir)
 *
 * **MUST be called inside a `db.transaction(...)` by the caller.** Either all
 * records commit or none do (atomicity per file).
 *
 * ## ID resolution
 *
 * Spool-mode writes produce synthetic placeholder IDs (prefix "spool:"). This
 * function resolves them in two ways:
 *
 * 1. In-file: a session record writes its real UUID into `maps.sessions`. Child
 *    records in the same batch look it up from the map.
 *
 * 2. Cross-file (T10 legacy repair): if a child record's parent ID is still
 *    synthetic after the map lookup (because the parent was in a different file),
 *    the natural key embedded in the spool ID is parsed and a placeholder parent
 *    row is synthesised with `startedAt = 0`. This sentinel preserves any
 *    existing real timestamp via the upsert COALESCE rule.
 *
 * ## Failure contract
 *
 * On any unresolvable synthetic ID or SQLite error, this function throws.
 * The caller's transaction rolls back automatically. The file should be
 * quarantined so it is not retried indefinitely.
 */
export function drainBatch(
  stmts: PreparedStatements,
  records: SpoolRecord[]
): void {
  // Session/turn/subscription IDs from spool mode are synthetic placeholders
  // (prefix "spool:"). Map them to real DB UUIDs as parent rows are processed.
  // The maps also cache T10 cross-file repair results so each unique synthetic
  // ID is resolved at most once per drainBatch call.
  const maps: DrainIdMaps = {
    sessions: new Map(),
    turns: new Map(),
    subscriptions: new Map(),
  };

  for (const record of records) {
    switch (record.type) {
      case "harness":
        writeHarness(stmts, record.payload);
        break;

      case "session": {
        const realId = writeSession(stmts, record.payload);
        // Map the in-file spool placeholder to the real UUID so child records
        // in this batch can resolve their parent session without a DB round-trip.
        maps.sessions.set(spoolSessionKey(record.payload), realId);
        break;
      }

      case "turn": {
        // Resolve (or repair) the parent session ID before writing the turn.
        const sessionId = resolveOrRepairSession(stmts, maps, record.payload.sessionId);
        const realId = writeTurn(stmts, { ...record.payload, sessionId });
        maps.turns.set(spoolTurnKey(record.payload), realId);
        break;
      }

      case "llm-message": {
        // Resolve session (may trigger T10 repair for cross-file refs).
        const sessionId = resolveOrRepairSession(stmts, maps, record.payload.sessionId);

        // Resolve optional turn ID (may trigger T10 repair).
        let turnId: string | undefined;
        if (record.payload.turnId != null) {
          const lookedUp = maps.turns.get(record.payload.turnId) ?? record.payload.turnId;
          turnId = lookedUp.startsWith('spool:')
            ? resolveOrRepairTurn(stmts, maps, lookedUp, record.payload.harnessId)
            : lookedUp;
        }

        // Subscription IDs do not carry cross-file synthetic refs in practice
        // (subscriptions were not part of the legacy emergency-spool format).
        const subscriptionId = record.payload.subscriptionId != null
          ? (maps.subscriptions.get(record.payload.subscriptionId) ?? record.payload.subscriptionId)
          : undefined;

        writeLlmMessage(stmts, { ...record.payload, sessionId, turnId, subscriptionId });
        break;
      }

      case "subscription": {
        const realId = writeSubscription(stmts, record.payload);
        maps.subscriptions.set(spoolSubscriptionKey(record.payload), realId);
        break;
      }

      case "tool-call": {
        // Same resolution pattern as llm-message.
        const sessionId = resolveOrRepairSession(stmts, maps, record.payload.sessionId);

        let turnId: string | undefined;
        if (record.payload.turnId != null) {
          const lookedUp = maps.turns.get(record.payload.turnId) ?? record.payload.turnId;
          turnId = lookedUp.startsWith('spool:')
            ? resolveOrRepairTurn(stmts, maps, lookedUp, record.payload.harnessId)
            : lookedUp;
        }

        writeToolCall(stmts, { ...record.payload, sessionId, turnId });
        break;
      }

      case "raw-event":
        writeRawEvent(stmts, record.payload);
        break;
    }
  }
}
