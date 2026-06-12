/**
 * sqlite/drain.ts — Best-effort token/model extraction from Cursor's state.vscdb.
 *
 * Cursor stores private per-bubble token counts and model information in a
 * SQLite key-value table (`cursorDiskKV`) inside state.vscdb. This module
 * opens that file read-only and extracts data for a given conversation.
 *
 * DESIGN PRINCIPLES
 * ─────────────────
 * 1. Read-only, non-blocking. We open with `query_only = 1` immediately after
 *    connecting, so any accidental write attempt is rejected by SQLite itself.
 *    We hold the connection only long enough to run the queries.
 *
 * 2. Never throw out of the hook path. Every failure mode (file absent,
 *    locked, wrong schema, corrupted row) is caught and returns an empty
 *    list. The hook handler continues with placeholder rows.
 *
 * 3. Idempotent records. The harnessMessageId we build follows the canonical
 *    form `cursor:<composerId>:<bubbleId>:assistant`. If bubbleId happens to
 *    equal generation_id (the common case), the T8 handler's upsert will
 *    update the exact placeholder row written by afterAgentResponse.
 *
 * 4. Session-level model fallback. `composerData:<composerId>` stores the
 *    `lastUsedModel` for the session. We expose this as the `sessionModel`
 *    in the returned result so T8 can apply it even when per-bubble model
 *    attribution is absent.
 *
 * IMPORTANT CAVEAT: state.vscdb is a private Cursor internal. Its schema and
 * key format may change across Cursor versions without notice.
 */

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { getCursorStateDbPath } from "./paths.js";
import { parseBubbleKey, composerDataKey } from "./keys.js";
import type { BackfillRecord } from "../transcript/drain.js";
import { inferProvider } from "@token-tally/harness-kit";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result returned by drainSqlite — records plus a session-level model hint. */
export interface SqliteDrainResult {
  /**
   * Per-bubble backfill records. Each record has a harnessMessageId of the
   * form `cursor:<composerId>:<bubbleId>:assistant`. When bubbleId == the
   * generation_id used in the placeholder, the T8 upsert matches exactly.
   */
  records: BackfillRecord[];

  /**
   * Session-level model id from `composerData:<composerId>.lastUsedModel`.
   * Null when absent or unparseable. T8 may apply this to messages whose
   * per-bubble model attribution is missing.
   */
  sessionModel: string | null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Query Cursor's `state.vscdb` for token/model data for a conversation.
 *
 * @param conversationId  The `conversation_id` from the hook payload.
 * @param dbPath          Override the default platform path (used in tests).
 * @returns               Per-bubble records and optional session model hint.
 *                        Returns `{ records: [], sessionModel: null }` on
 *                        any failure — never throws.
 */
export async function drainSqlite(
  conversationId: string,
  dbPath?: string,
): Promise<SqliteDrainResult> {
  const empty: SqliteDrainResult = { records: [], sessionModel: null };

  // ── 1. Resolve DB path ────────────────────────────────────────────────────
  const resolvedPath = dbPath ?? getCursorStateDbPath();
  if (resolvedPath === undefined) {
    // Unknown platform or missing env var — skip silently.
    return empty;
  }

  // ── 2. Open database ──────────────────────────────────────────────────────
  // Guard: only open if the file already exists. DatabaseSync's default open
  // flags can CREATE a new file, which would leave an empty state.vscdb inside
  // Cursor's private storage if the DB is temporarily absent (e.g. during a
  // Cursor update or migration). We never want to create that file.
  if (!existsSync(resolvedPath)) {
    return empty;
  }

  let db: DatabaseSync;
  try {
    // DatabaseSync is the Node 24 built-in SQLite API (stable, no native addon).
    // We do not pass `{ readonly: true }` because the option was added in a
    // later patch release; PRAGMA query_only=1 achieves equivalent protection.
    db = new DatabaseSync(resolvedPath);
  } catch (err) {
    // Permission denied, DB locked, or corrupt — all expected.
    return empty;
  }

  try {
    // Prevent any accidental DML immediately after opening.
    db.exec("PRAGMA query_only = 1");

    // Verify the expected table exists — schema may differ across Cursor versions.
    const tableCheck = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'",
      )
      .get() as { name: string } | null;

    if (tableCheck === null) {
      // Table absent — likely a future or past Cursor version with a different schema.
      return empty;
    }

    // ── 3. Extract session-level model ────────────────────────────────────────
    const sessionModel = extractSessionModel(db, conversationId);

    // ── 4. Extract per-bubble records ─────────────────────────────────────────
    const records = extractBubbleRecords(db, conversationId);

    return { records, sessionModel };
  } catch (err) {
    console.warn("[cursor-writer] sqlite drain: unexpected error querying state.vscdb:", err);
    return empty;
  } finally {
    // Always close to release any internal locks immediately.
    try {
      db.close();
    } catch {
      // Ignore close errors — they don't affect the data we already read.
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract `lastUsedModel` from the session-level `composerData` KV row.
 * Returns null when the row is absent, the value is not valid JSON, or the
 * `lastUsedModel` field is absent/non-string.
 */
function extractSessionModel(db: DatabaseSync, conversationId: string): string | null {
  try {
    const key = composerDataKey(conversationId);
    const row = db
      .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
      .get(key) as { value: string } | null;

    if (row === null || typeof row.value !== "string") return null;

    const data = JSON.parse(row.value) as unknown;
    if (data === null || typeof data !== "object") return null;

    const lastUsedModel = (data as Record<string, unknown>)["lastUsedModel"];
    if (typeof lastUsedModel === "string" && lastUsedModel.trim() !== "") {
      return lastUsedModel.trim();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Query all `bubbleId:<conversationId>:*` rows and extract per-bubble records.
 *
 * Rows with zero or absent token counts are skipped — they add nothing beyond
 * the placeholder that afterAgentResponse already wrote.
 */
function extractBubbleRecords(
  db: DatabaseSync,
  conversationId: string,
): BackfillRecord[] {
  const records: BackfillRecord[] = [];

  // LIKE pattern: match all bubbles belonging to this conversation.
  // Using LIKE avoids a full table scan on large DBs.
  const pattern = `bubbleId:${conversationId}:%`;

  let rows: Array<{ key: string; value: string }>;
  try {
    rows = db
      .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE ?")
      .all(pattern) as Array<{ key: string; value: string }>;
  } catch {
    return records;
  }

  for (const row of rows) {
    try {
      const record = parseBubbleRow(row.key, row.value);
      if (record !== null) {
        records.push(record);
      }
    } catch {
      // Skip malformed rows rather than aborting the whole drain.
    }
  }

  return records;
}

/**
 * Parse one `bubbleId:` KV row into a BackfillRecord.
 * Returns null when the row has no usable token data.
 */
function parseBubbleRow(key: string, rawValue: string): BackfillRecord | null {
  const parsed = parseBubbleKey(key);
  if (parsed === null) return null;

  const { composerId, bubbleId } = parsed;

  let data: Record<string, unknown>;
  try {
    const json = JSON.parse(rawValue) as unknown;
    if (json === null || typeof json !== "object" || Array.isArray(json)) return null;
    data = json as Record<string, unknown>;
  } catch {
    return null;
  }

  // ── Extract token counts ──────────────────────────────────────────────────
  // `tokenCount` is the documented field name based on empirical observation.
  // All token fields are best-effort and often zero in practice.
  const tokenCount = data["tokenCount"];
  const tc =
    tokenCount !== null && typeof tokenCount === "object"
      ? (tokenCount as Record<string, unknown>)
      : null;

  const inputTokens = toInt(tc?.["inputTokens"]);
  const outputTokens = toInt(tc?.["outputTokens"]);

  // Skip rows with no token data — they don't improve on the placeholder.
  if (inputTokens === 0 && outputTokens === 0) return null;

  // ── Extract model / provider ──────────────────────────────────────────────
  // `model` and `providerOptions.provider` are present when Cursor persisted them.
  const modelId =
    typeof data["model"] === "string" && data["model"].trim() !== ""
      ? data["model"].trim()
      : null;

  const providerOptions = data["providerOptions"];
  const explicitProvider =
    providerOptions !== null &&
    typeof providerOptions === "object" &&
    typeof (providerOptions as Record<string, unknown>)["provider"] === "string"
      ? ((providerOptions as Record<string, unknown>)["provider"] as string)
      : null;

  const provider = explicitProvider ?? (modelId !== null ? inferProvider(modelId) : null);

  // ── Form canonical harness message id ────────────────────────────────────
  // If bubbleId == generation_id (the common case), this matches the placeholder.
  const harnessMessageId = `cursor:${composerId}:${bubbleId}:assistant`;

  return {
    harnessMessageId,
    modelId: modelId ?? undefined,
    provider: provider ?? undefined,
    inputTokens,
    outputTokens,
  };
}


/**
 * Safely convert an unknown value to a non-negative integer.
 */
function toInt(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.floor(v));
  return 0;
}
