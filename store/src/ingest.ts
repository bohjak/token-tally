/**
 * Spool ingestion utilities for the ToTally central store.
 *
 * `ingestFile` and `ingestDir` are the programmatic entry points for draining
 * closed spool files into the central database. They are used by the CLI
 * (`token-tally ingest`) and by the drain daemon (T6).
 *
 * Drain semantics:
 *   - Active spool files (`*.ndjson`)  — NEVER touched; a live writer may
 *     hold them open.
 *   - Closed spool files (`*.ndjson.closed`) — parsed and committed in a
 *     single transaction per file, then deleted on success.
 *
 * Neither function scans the default spool directory as a side effect.
 * Callers opt in to directory drain by using `ingestDir` or by passing a
 * directory path to the CLI. Hot-path callers (CLI `record`, harness hooks)
 * should not call either function — they rely on the daemon for background
 * persistence.
 *
 * Ingestion writes through `AnalyticsWriter` so all idempotency, FK, and
 * schema-version rules are enforced automatically.
 */

import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { defaultFailedDir, quarantineSpoolFile } from "./spool";
import type { BoundedDrainOptions, SpoolRecord } from "./spool";
import { AnalyticsWriter } from "./writer";
import type { WriterOptions } from "./types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options accepted by the ingest functions.
 *
 * Extends `WriterOptions` with optional drain bounds. The bounds apply to
 * directory drain passes (`ingestDir`). Single-file ingest (`ingestFile`)
 * ignores bounds because it processes exactly one file by definition.
 */
export type IngestOptions = WriterOptions & BoundedDrainOptions;

/** Result of ingesting a single file or a directory of spool files. */
export type IngestResult = {
  /** Number of spool files successfully ingested and deleted. */
  ingested: number;
  /** Number of active spool files skipped because they are still open (*.ndjson). */
  skipped: number;
  /**
   * Number of closed spool files that were present but not attempted because
   * a `maxFiles` or `maxMs` bound was hit. These files remain on disk for the
   * next drain pass (daemon or manual ingest).
   */
  skippedByBound: number;
  /**
   * Number of files that failed ingest and were moved to the quarantine
   * directory with a `.failed.json` metadata file. These files will NOT be
   * retried from the active spool directory (they are out of the spool dir).
   * Non-zero means data was not persisted; see the quarantine dir for details.
   */
  quarantined: number;
  /**
   * Files that failed ingest AND could not be quarantined (still in the spool
   * directory). An empty array with `quarantined > 0` means all failures were
   * handled cleanly. Non-empty means files are stuck in the spool dir and
   * need manual intervention.
   */
  errors: Array<{ file: string; message: string }>;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ingests a single NDJSON file into the central store.
 *
 * The file may be either:
 *   - A `*.ndjson.closed` file — ingested directly.
 *   - A `*.ndjson` (active) file supplied explicitly — promoted to `.closed`
 *     first (safe only when the caller is certain the writer process is dead,
 *     e.g. after `token-tally ingest <path>` targeting a dead writer's file).
 *
 * This function does NOT scan or drain the default spool directory as a side
 * effect. It opens a writer for the DB connection, processes the single
 * specified file, and closes the writer. All idempotency and FK rules apply
 * via the writer's INSERT … ON CONFLICT semantics.
 *
 * Bounds (`maxFiles`, `maxMs`) in `options` are accepted but ignored for
 * single-file ingest — exactly one file is always processed.
 */
export async function ingestFile(
  filePath: string,
  options?: IngestOptions
): Promise<IngestResult> {
  if (!existsSync(filePath)) {
    return {
      ingested: 0,
      skipped: 0,
      skippedByBound: 0,
      quarantined: 0,
      errors: [{ file: filePath, message: "File not found." }],
    };
  }

  // If the file is an active spool file, promote it to .closed before
  // draining. The caller is responsible for confirming the writer is dead.
  let targetPath = filePath;
  if (filePath.endsWith(".ndjson") && !filePath.endsWith(".ndjson.closed")) {
    const closedPath = filePath.replace(/\.ndjson$/, `-manual-${Date.now()}.ndjson.closed`);
    try {
      renameSync(filePath, closedPath);
      targetPath = closedPath;
    } catch (err) {
      return {
        ingested: 0,
        skipped: 0,
        skippedByBound: 0,
        quarantined: 0,
        errors: [
          {
            file: filePath,
            message: `Cannot promote active spool file to .closed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  }

  // Open a writer for the DB connection. No drain options are set so the
  // writer will not scan the default spool directory during open or close.
  // We handle exactly the one file ourselves below.
  const writer = await AnalyticsWriter.open({
    dbPath: options?.dbPath,
    harnessName: options?.harnessName ?? "token-tally-ingest",
    spoolDir: options?.spoolDir,
    // Explicitly no full-directory drain — this function processes one file.
  });

  const errors: Array<{ file: string; message: string }> = [];
  let ingested = 0;
  let quarantined = 0;

  try {
    const lines = readFileSync(targetPath, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "");
    const records = lines.map((line) => JSON.parse(line) as SpoolRecord);
    await applyRecordsToWriter(writer, records);
    unlinkSync(targetPath);
    ingested = 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Attempt to quarantine so the file is not retried on future ingest passes.
    // Only quarantine .ndjson.closed files (not explicitly-promoted active files
    // that the caller wanted to ingest in-place).
    const resolvedFailedDir: string | null =
      options?.failedDir !== undefined
        ? options.failedDir
        : defaultFailedDir(dirname(targetPath));

    if (resolvedFailedDir != null) {
      // Try to get the first record for quarantine metadata.
      let firstRecord: unknown = null;
      try {
        const rawLines = readFileSync(targetPath, "utf8").split("\n").filter(l => l.trim() !== "");
        if (rawLines.length > 0) firstRecord = JSON.parse(rawLines[0]!);
      } catch { /* parsing failed, firstRecord stays null */ }

      const quarantinePath = quarantineSpoolFile(targetPath, resolvedFailedDir, message, firstRecord);
      if (quarantinePath != null) {
        quarantined++;
        errors.push({
          file: targetPath,
          message: `${message} (quarantined to ${quarantinePath})`,
        });
      } else {
        // Quarantine itself failed — file stays where it is.
        errors.push({
          file: targetPath,
          message: `${message} (quarantine failed — file left in place)`,
        });
      }
    } else {
      // Quarantine disabled (options.failedDir === null).
      errors.push({ file: targetPath, message });
    }
  }

  await writer.close();

  return { ingested, skipped: 0, skippedByBound: 0, quarantined, errors };
}

/**
 * Ingests all `*.ndjson.closed` files in `dir` into the central store.
 * Active `*.ndjson` files are skipped — they may be held open by live writers.
 *
 * Callers control how many files or how much wall time to budget via
 * `options.maxFiles` and `options.maxMs`. Files skipped due to a bound remain
 * on disk for the next drain pass. Omit both to drain all closed files.
 *
 * This function is explicit — it does NOT drain the default spool directory
 * unless `dir` is omitted, and it never scans unrelated directories.
 *
 * ## T10 legacy repair
 *
 * Each file is processed via `applyRecordsToWriter`, which includes the legacy
 * synthetic spool ID repair logic. This is the same path used by `ingestFile`
 * and ensures cross-file synthetic `spool:*` IDs are resolved (or quarantined
 * with a clear error) rather than failing with a silent FK constraint.
 */
export async function ingestDir(
  dir?: string,
  options?: IngestOptions
): Promise<IngestResult> {
  const { defaultSpoolDir } = await import("./paths");
  const targetDir = dir ?? defaultSpoolDir();

  if (!existsSync(targetDir)) {
    return { ingested: 0, skipped: 0, skippedByBound: 0, quarantined: 0, errors: [] };
  }

  const allFiles = readdirSync(targetDir);
  const activeFiles = allFiles.filter(
    (f) => f.endsWith(".ndjson") && !f.endsWith(".ndjson.closed")
  );
  const closedFiles = allFiles.filter((f) => f.endsWith(".ndjson.closed"));

  if (closedFiles.length === 0) {
    return { ingested: 0, skipped: activeFiles.length, skippedByBound: 0, quarantined: 0, errors: [] };
  }

  const resolvedFailedDir: string | null =
    options?.failedDir !== undefined
      ? options.failedDir
      : defaultFailedDir(targetDir);

  // Evaluate bounds. Infinity makes bound checks uniform without conditionals.
  const maxFiles = options?.maxFiles ?? Infinity;
  const deadline = options?.maxMs != null ? Date.now() + options.maxMs : Infinity;

  // Open the writer ONCE for the whole batch — one DB open/close per ingestDir
  // call regardless of file count. No drain-on-open: we process files manually
  // using applyRecordsToWriter so T10 legacy repair applies to every file.
  const writer = await AnalyticsWriter.open({
    dbPath: options?.dbPath,
    harnessName: options?.harnessName ?? "token-tally-ingest",
    spoolDir: targetDir,
    // Explicit no-drain: this writer is opened solely for its DB connection.
    // We handle drain manually below.
  });

  let ingested = 0;
  let quarantined = 0;
  let skippedByBound = 0;
  const errors: Array<{ file: string; message: string }> = [];
  let processed = 0;

  for (const filename of closedFiles) {
    // Check both bounds before attempting the next file.
    if (processed >= maxFiles || Date.now() > deadline) {
      skippedByBound++;
      continue;
    }
    processed++;

    const filePath = join(targetDir, filename);
    let drainError: string | null = null;
    let firstRecord: unknown = null;

    try {
      const lines = readFileSync(filePath, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "");
      const records = lines.map((line) => JSON.parse(line) as SpoolRecord);
      // Capture first record for quarantine metadata even if drain fails.
      firstRecord = records[0] ?? null;
      await applyRecordsToWriter(writer, records);
      unlinkSync(filePath);
      ingested++;
    } catch (err) {
      drainError = err instanceof Error ? err.message : String(err);
    }

    if (drainError != null) {
      if (resolvedFailedDir != null) {
        const quarantinePath = quarantineSpoolFile(
          filePath,
          resolvedFailedDir,
          drainError,
          firstRecord,
        );
        if (quarantinePath != null) {
          quarantined++;
          errors.push({
            file: filePath,
            message: `${drainError} (quarantined to ${quarantinePath})`,
          });
        } else {
          // Quarantine itself failed — file left in spool dir.
          errors.push({
            file: filePath,
            message: `${drainError} (quarantine failed — file left in spool directory)`,
          });
        }
      } else {
        // Quarantine disabled (failedDir: null) — leave file in place.
        errors.push({ file: filePath, message: drainError });
      }
    }
  }

  await writer.close();

  return { ingested, skipped: activeFiles.length, skippedByBound, quarantined, errors };
}

// ---------------------------------------------------------------------------
// Internal helpers
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

/**
 * Applies a batch of SpoolRecords to a live AnalyticsWriter.
 *
 * Records are applied in order. All writes use the writer's idempotent upsert
 * semantics so replaying the same records is always safe. Errors propagate to
 * the caller so the drain loop can mark the file as failed.
 *
 * ## Legacy cross-file ID repair (T10)
 *
 * New multi-record Pi spool files contain session, turn, and child records in
 * lifecycle order within a single file. The in-file `sessionIds`/`turnIds` maps
 * resolve synthetic `spool:*` placeholders to real DB UUIDs as records are
 * processed top-to-bottom.
 *
 * Legacy emergency spool files contain ONE record per file. Child records
 * (llm-message, tool-call) reference turn and session rows that live in
 * separate files, so the in-file maps cannot resolve them. For these records
 * the function falls back to natural-key-first repair:
 *
 *   Session: `spool:<harnessId>:<harnessSessionId>` — the harnessId and
 *     harnessSessionId are parsed out and passed to `writer.recordSession()`
 *     with `startedAt = 0` as a sentinel. The upsert SQL uses
 *     `COALESCE(NULLIF(0, 0), existing)` so an existing timestamp is preserved;
 *     a new row gets `startedAt = 0` as a placeholder marking it as synthesized.
 *
 *   Turn: `spool:<uuid>:<harnessTurnId>` (UUID-prefixed) or
 *     `spool:spool:<harnessId>:<path>:<path>:t<N>` (nested synthetic) — the
 *     natural key `(sessionId, harnessTurnId)` is extracted and
 *     `writer.recordTurn()` is called with `startedAt = 0`.
 *
 * If a synthetic ID cannot be parsed deterministically, it is passed through
 * unchanged; the FK constraint fires, and the file is quarantined with a clear
 * error that includes the underlying DB error.
 */
async function applyRecordsToWriter(
  writer: AnalyticsWriter,
  records: SpoolRecord[]
): Promise<void> {
  // Session/turn/subscription IDs that come out of spool mode are synthetic
  // placeholders (prefix "spool:"). Map them to real DB IDs as we process
  // parent rows first. The maps also cache cross-file repair results so each
  // unique synthetic ID is resolved at most once per drain pass.
  const sessionIds = new Map<string, string>();
  const turnIds = new Map<string, string>();
  const subscriptionIds = new Map<string, string>();

  for (const record of records) {
    switch (record.type) {
      case "harness":
        await writer.recordHarness(record.payload);
        break;

      case "session": {
        const result = await writer.recordSession(record.payload);
        // Map the in-file spool placeholder to the real UUID.
        const spoolKey = `spool:${record.payload.harnessId}:${record.payload.harnessSessionId}`;
        sessionIds.set(spoolKey, result.id);
        break;
      }

      case "turn": {
        let resolvedSessionId = sessionIds.get(record.payload.sessionId) ?? record.payload.sessionId;

        // Legacy cross-file repair: if the sessionId is still a synthetic
        // spool:* placeholder (not resolved by an in-file session record),
        // synthesize or look up the parent session via its natural key.
        if (resolvedSessionId.startsWith('spool:')) {
          const parsed = parseLegacySpoolSessionId(resolvedSessionId);
          if (parsed != null) {
            // Ensure the harness row exists (session has a FK to harnesses).
            await writer.recordHarness({ name: parsed.harnessId, displayName: parsed.harnessId });
            const { id } = await writer.recordSession({
              harnessId: parsed.harnessId,
              harnessSessionId: parsed.harnessSessionId,
              sessionFile: parsed.harnessSessionId,
              startedAt: 0, // sentinel: preserves existing timestamp via COALESCE
            });
            sessionIds.set(resolvedSessionId, id);
            resolvedSessionId = id;
          }
          // If still synthetic after repair attempt: throw explicitly so this
          // file is quarantined rather than silently passing through.
          // The writer's withDbOrSpool would catch FK errors and fall back to
          // spool, which hides the failure and deletes the source file.
          if (resolvedSessionId.startsWith('spool:')) {
            throw new Error(
              `Cannot resolve synthetic session ID '${resolvedSessionId}': ` +
              `the natural key could not be parsed (harnessId appears to ` +
              `contain path separators or the format is unrecognised). ` +
              `Record quarantined for manual inspection.`
            );
          }
        }

        const payload = { ...record.payload, sessionId: resolvedSessionId };
        const result = await writer.recordTurn(payload);
        const spoolKey = `spool:${record.payload.sessionId}:${record.payload.harnessTurnId}`;
        turnIds.set(spoolKey, result.id);
        break;
      }

      case "llm-message": {
        let resolvedSessionId = sessionIds.get(record.payload.sessionId) ?? record.payload.sessionId;
        let resolvedTurnId = record.payload.turnId != null
          ? (turnIds.get(record.payload.turnId) ?? record.payload.turnId)
          : undefined;

        // Legacy cross-file repair: if turnId is still a synthetic spool:*
        // placeholder, synthesize or look up the parent turn via natural key.
        if (resolvedTurnId != null && resolvedTurnId.startsWith('spool:')) {
          const parsed = parseLegacySpoolTurnId(resolvedTurnId);
          if (parsed != null) {
            // Resolve the turn's parent session first (may itself be synthetic).
            let parsedSessionId = sessionIds.get(parsed.sessionId) ?? parsed.sessionId;
            if (parsedSessionId.startsWith('spool:')) {
              const parsedSess = parseLegacySpoolSessionId(parsedSessionId);
              if (parsedSess != null) {
                await writer.recordHarness({ name: parsedSess.harnessId, displayName: parsedSess.harnessId });
                const { id } = await writer.recordSession({
                  harnessId: parsedSess.harnessId,
                  harnessSessionId: parsedSess.harnessSessionId,
                  sessionFile: parsedSess.harnessSessionId,
                  startedAt: 0,
                });
                sessionIds.set(parsedSessionId, id);
                parsedSessionId = id;
              }
            }
            const { id: turnId } = await writer.recordTurn({
              harnessId: record.payload.harnessId,
              sessionId: parsedSessionId,
              harnessTurnId: parsed.harnessTurnId,
              startedAt: 0,
            });
            turnIds.set(resolvedTurnId, turnId);
            resolvedTurnId = turnId;
          }
          // If unparseable: let FK constraint fire and quarantine the file.
        }

        // Re-resolve sessionId: it may have been synthesised during turn repair
        // (the turn's parent session is now in the sessionIds map).
        resolvedSessionId = sessionIds.get(record.payload.sessionId) ?? resolvedSessionId;

        // Legacy repair for the message's own sessionId if still synthetic.
        if (resolvedSessionId.startsWith('spool:')) {
          const parsedSess = parseLegacySpoolSessionId(resolvedSessionId);
          if (parsedSess != null) {
            await writer.recordHarness({ name: parsedSess.harnessId, displayName: parsedSess.harnessId });
            const { id } = await writer.recordSession({
              harnessId: parsedSess.harnessId,
              harnessSessionId: parsedSess.harnessSessionId,
              sessionFile: parsedSess.harnessSessionId,
              startedAt: 0,
            });
            sessionIds.set(resolvedSessionId, id);
            resolvedSessionId = id;
          }
        }

        const resolvedSubscriptionId = record.payload.subscriptionId != null
          ? (subscriptionIds.get(record.payload.subscriptionId) ?? record.payload.subscriptionId)
          : undefined;

        await writer.recordLlmMessage({
          ...record.payload,
          sessionId: resolvedSessionId,
          turnId: resolvedTurnId,
          subscriptionId: resolvedSubscriptionId,
        });
        break;
      }

      case "subscription": {
        const result = await writer.recordSubscription(record.payload);
        const spoolKey = `spool:${record.payload.harnessId}:${record.payload.planName}:${record.payload.periodStart}`;
        subscriptionIds.set(spoolKey, result.id);
        break;
      }

      case "tool-call": {
        let resolvedSessionId = sessionIds.get(record.payload.sessionId) ?? record.payload.sessionId;
        let resolvedTurnId = record.payload.turnId != null
          ? (turnIds.get(record.payload.turnId) ?? record.payload.turnId)
          : undefined;

        // Legacy cross-file repair: same pattern as llm-message above.
        if (resolvedTurnId != null && resolvedTurnId.startsWith('spool:')) {
          const parsed = parseLegacySpoolTurnId(resolvedTurnId);
          if (parsed != null) {
            let parsedSessionId = sessionIds.get(parsed.sessionId) ?? parsed.sessionId;
            if (parsedSessionId.startsWith('spool:')) {
              const parsedSess = parseLegacySpoolSessionId(parsedSessionId);
              if (parsedSess != null) {
                await writer.recordHarness({ name: parsedSess.harnessId, displayName: parsedSess.harnessId });
                const { id } = await writer.recordSession({
                  harnessId: parsedSess.harnessId,
                  harnessSessionId: parsedSess.harnessSessionId,
                  sessionFile: parsedSess.harnessSessionId,
                  startedAt: 0,
                });
                sessionIds.set(parsedSessionId, id);
                parsedSessionId = id;
              }
            }
            const { id: turnId } = await writer.recordTurn({
              harnessId: record.payload.harnessId,
              sessionId: parsedSessionId,
              harnessTurnId: parsed.harnessTurnId,
              startedAt: 0,
            });
            turnIds.set(resolvedTurnId, turnId);
            resolvedTurnId = turnId;
          }
        }

        // Re-resolve sessionId (same pattern as llm-message).
        resolvedSessionId = sessionIds.get(record.payload.sessionId) ?? resolvedSessionId;

        // Legacy repair for the tool-call's own sessionId if still synthetic.
        if (resolvedSessionId.startsWith('spool:')) {
          const parsedSess = parseLegacySpoolSessionId(resolvedSessionId);
          if (parsedSess != null) {
            await writer.recordHarness({ name: parsedSess.harnessId, displayName: parsedSess.harnessId });
            const { id } = await writer.recordSession({
              harnessId: parsedSess.harnessId,
              harnessSessionId: parsedSess.harnessSessionId,
              sessionFile: parsedSess.harnessSessionId,
              startedAt: 0,
            });
            sessionIds.set(resolvedSessionId, id);
            resolvedSessionId = id;
          }
        }

        await writer.recordToolCall({
          ...record.payload,
          sessionId: resolvedSessionId,
          turnId: resolvedTurnId,
        });
        break;
      }

      case "raw-event":
        await writer.recordRawEvent(record.payload);
        break;
    }
  }
}
