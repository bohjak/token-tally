/**
 * commands/doctor.ts — T19: /analytics doctor self-check command.
 *
 * Runs invariant checks against the live SQLite database and (optionally) the
 * NDJSON raw-log directory.  Exported as a pure function so it can be called
 * from unit tests, the standalone `scripts/doctor.mjs` CLI, and — once T15
 * is updated — the `/analytics doctor` registered command.
 *
 * ## Invariants
 *
 * 1. Orphaned tool_calls   — turn_id not in turns.id                 [error]
 * 2. Stale turns           — ended_at IS NULL + started_at > 24h ago [warn]
 * 3. Cost drift            — abs(cost_total - sum of components) > 0.0001 [warn]
 * 4. Stale sessions        — ended_at IS NULL + started_at > 24h ago [warn]
 * 5. NDJSON-vs-SQLite drift— today's NDJSON lines vs SQLite row sum  [warn]
 *    (skipped when rawLogDir is not provided)
 * 6. Redaction telemetry   — top-N rule hit counts across last 7d    [info]
 *    (skipped when rawLogDir is not provided)
 * 7. Disk usage            — events.db + raw/ total bytes            [info]
 *
 * ## Error policy
 *
 * Every check is wrapped in try/catch.  A failing check emits a warn-level
 * anomaly "doctor_check_failed:<check_name>" rather than throwing, so a
 * single broken query never aborts the full report.
 *
 * ## `ok` semantics
 *
 * `report.ok === true` iff no anomaly has severity "error".  Warn-level
 * anomalies indicate degraded state but are not fatal.  Info entries are
 * always present and never affect `ok`.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SqliteSink } from "../sinks/sqlite.ts";

// ── Public types ──────────────────────────────────────────────────────────────

export interface DoctorOpts {
  /**
   * If true, the caller intends to print JSON.  runDoctor itself is pure;
   * the caller (CLI / command) formats accordingly.
   */
  json?: boolean;
  /**
   * Absolute or ~-prefixed path to the NDJSON raw-log directory.
   * When absent, checks 5 & 6 are skipped and an info entry is added.
   */
  rawLogDir?: string;
}

export interface DoctorAnomaly {
  /** Short machine-readable identifier for the invariant. */
  check: string;
  severity: "warn" | "error";
  /** Number of affected rows / lines. */
  count: number;
  /** Up to 3 example rows for human inspection.  Never contains secret text. */
  sample?: unknown;
}

export interface DoctorInfo {
  label: string;
  value: unknown;
}

export interface DoctorReport {
  /** True iff no anomaly has severity "error". */
  ok: boolean;
  anomalies: DoctorAnomaly[];
  info: DoctorInfo[];
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function expandHome(p: string): string {
  return p.startsWith("~") ? homedir() + p.slice(1) : p;
}

/** Returns the UTC date string (YYYY-MM-DD) for a given Unix-ms timestamp. */
function toUtcDateStr(tsMs: number): string {
  const d = new Date(tsMs);
  const yyyy = d.getUTCFullYear().toString();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Returns Unix ms for the start of a UTC day given by YYYY-MM-DD string. */
function startOfUtcDayMs(dateStr: string): number {
  return Date.parse(`${dateStr}T00:00:00.000Z`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * Run all doctor invariants and return a structured report.
 *
 * Pass `opts.rawLogDir` to enable NDJSON-based checks (drift + redaction
 * telemetry + disk usage of raw/).
 */
export function runDoctor(sink: SqliteSink, opts?: DoctorOpts): DoctorReport {
  const anomalies: DoctorAnomaly[] = [];
  const info: DoctorInfo[] = [];

  const rawLogDir = opts?.rawLogDir ? expandHome(opts.rawLogDir) : undefined;

  const db = sink.database;
  if (!db) {
    anomalies.push({
      check: "db_not_initialized",
      severity: "error",
      count: 1,
      sample: "SqliteSink.database is null — call init() before running doctor",
    });
    return { ok: false, anomalies, info };
  }

  // ── 1. Orphaned tool_calls ────────────────────────────────────────────────
  // tool_calls.turn_id has a REFERENCES turns(id) FK, but FK enforcement may
  // have been off at insert time (e.g., older DB, migration edge case).
  try {
    const rows = db
      .prepare(
        `SELECT id, turn_id
         FROM tool_calls
         WHERE turn_id NOT IN (SELECT id FROM turns)
         LIMIT 10`,
      )
      .all() as Array<{ id: string; turn_id: string }>;

    if (rows.length > 0) {
      anomalies.push({
        check: "orphaned_tool_calls",
        severity: "error",
        count: rows.length,
        sample: rows.slice(0, 3).map((r) => ({ id: r.id, turn_id: r.turn_id })),
      });
    }
  } catch (err) {
    anomalies.push({
      check: "doctor_check_failed:orphaned_tool_calls",
      severity: "warn",
      count: 1,
      sample: String(err),
    });
  }

  // ── 2. Stale turns ────────────────────────────────────────────────────────
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const rows = db
      .prepare(
        `SELECT id, started_at
         FROM turns
         WHERE ended_at IS NULL AND started_at < ?
         LIMIT 10`,
      )
      .all(cutoff) as Array<{ id: string; started_at: number }>;

    if (rows.length > 0) {
      anomalies.push({
        check: "stale_turns",
        severity: "warn",
        count: rows.length,
        sample: rows.slice(0, 3),
      });
    }
  } catch (err) {
    anomalies.push({
      check: "doctor_check_failed:stale_turns",
      severity: "warn",
      count: 1,
      sample: String(err),
    });
  }

  // ── 3. Cost drift ─────────────────────────────────────────────────────────
  try {
    const rows = db
      .prepare(
        `SELECT id, cost_total, cost_input, cost_output, cost_cache_read, cost_cache_write
         FROM llm_messages
         WHERE abs(cost_total - (cost_input + cost_output + cost_cache_read + cost_cache_write)) > 0.0001
         LIMIT 10`,
      )
      .all() as Array<{
        id: string;
        cost_total: number;
        cost_input: number;
        cost_output: number;
        cost_cache_read: number;
        cost_cache_write: number;
      }>;

    if (rows.length > 0) {
      anomalies.push({
        check: "cost_drift",
        severity: "warn",
        count: rows.length,
        sample: rows.slice(0, 3).map((r) => ({
          id: r.id,
          cost_total: r.cost_total,
          computed: +(
            r.cost_input +
            r.cost_output +
            r.cost_cache_read +
            r.cost_cache_write
          ).toFixed(8),
          delta: +(
            r.cost_total -
            (r.cost_input + r.cost_output + r.cost_cache_read + r.cost_cache_write)
          ).toFixed(8),
        })),
      });
    }
  } catch (err) {
    anomalies.push({
      check: "doctor_check_failed:cost_drift",
      severity: "warn",
      count: 1,
      sample: String(err),
    });
  }

  // ── 4. Stale sessions ─────────────────────────────────────────────────────
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const rows = db
      .prepare(
        `SELECT id, started_at
         FROM sessions
         WHERE ended_at IS NULL AND started_at < ?
         LIMIT 10`,
      )
      .all(cutoff) as Array<{ id: string; started_at: number }>;

    if (rows.length > 0) {
      anomalies.push({
        check: "stale_sessions",
        severity: "warn",
        count: rows.length,
        sample: rows.slice(0, 3),
      });
      // Companion info entry telling the user how to fix it.
      info.push({
        label: "stale_sessions_healable",
        value: `${rows.length} session(s) can be auto-closed — run /analytics doctor --heal-stale-sessions`,
      });
    }
  } catch (err) {
    anomalies.push({
      check: "doctor_check_failed:stale_sessions",
      severity: "warn",
      count: 1,
      sample: String(err),
    });
  }

  // ── 5. NDJSON-vs-SQLite count drift ──────────────────────────────────────
  if (!rawLogDir) {
    info.push({
      label: "ndjson_skipped",
      value: "rawLogDir not provided — checks 5 & 6 skipped",
    });
  } else {
    try {
      const today = toUtcDateStr(Date.now());
      const ndjsonPath = join(rawLogDir, `events-${today}.ndjson`);
      const ndjsonLines = existsSync(ndjsonPath)
        ? readFileSync(ndjsonPath, "utf8")
            .split("\n")
            .filter((l) => l.trim().length > 0).length
        : 0;

      // SQLite "today" count: sum of event-bearing tables that have a ts
      // or started_at column timestamped today.  This is intentionally a
      // rough lower-bound — NDJSON also contains session_start/end,
      // model_select, etc. that have no dedicated table.  We flag divergence
      // only when the gap > 5 rows.
      const todayStartMs = startOfUtcDayMs(today);
      const { total: sqliteTodayCount } = db
        .prepare(
          `SELECT
             (SELECT count(*) FROM prompts          WHERE ts           >= ?) +
             (SELECT count(*) FROM turns            WHERE started_at   >= ?) +
             (SELECT count(*) FROM llm_messages     WHERE ts           >= ?) +
             (SELECT count(*) FROM tool_calls       WHERE started_at   >= ?) +
             (SELECT count(*) FROM files_touched    WHERE ts           >= ?) +
             (SELECT count(*) FROM commits_made     WHERE ts           >= ?) +
             (SELECT count(*) FROM branch_transitions WHERE ts         >= ?) AS total`,
        )
        .get(
          todayStartMs,
          todayStartMs,
          todayStartMs,
          todayStartMs,
          todayStartMs,
          todayStartMs,
          todayStartMs,
        ) as { total: number };

      // NDJSON always contains more lines than SQLite because it records
      // session_start/end, model_select, thinking_level_select, branch_transition
      // etc. — events with no corresponding SQLite table rows.  The gap is
      // typically thousands per day in normal operation, so a fixed numeric
      // tolerance produces constant false-positive anomalies.  Report as info
      // only so operators can spot a 10x+ drift visually without noise.
      const drift = ndjsonLines - sqliteTodayCount;
      info.push({
        label: "ndjson_sqlite_diff",
        value: {
          ndjson_lines: ndjsonLines,
          sqlite_count: sqliteTodayCount,
          diff: drift,
        },
      });
    } catch (err) {
      anomalies.push({
        check: "doctor_check_failed:ndjson_drift",
        severity: "warn",
        count: 1,
        sample: String(err),
      });
    }

    // ── 6. Redaction telemetry (last 7 days) ───────────────────────────────
    // Reads NDJSON files and aggregates the `redacted` hit counters.
    // Never echoes matched text — only rule-name counts.
    try {
      const hits: Record<string, number> = {};
      let filesScanned = 0;

      for (let daysBack = 7; daysBack >= 0; daysBack--) {
        const dateStr = toUtcDateStr(Date.now() - daysBack * 24 * 60 * 60 * 1000);
        const filePath = join(rawLogDir, `events-${dateStr}.ndjson`);
        if (!existsSync(filePath)) continue;

        filesScanned++;
        const lines = readFileSync(filePath, "utf8").split("\n");

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const evt = JSON.parse(trimmed) as {
              redacted?: Record<string, number>;
            };
            if (evt.redacted && typeof evt.redacted === "object") {
              for (const [rule, count] of Object.entries(evt.redacted)) {
                if (typeof count === "number") {
                  hits[rule] = (hits[rule] ?? 0) + count;
                }
              }
            }
          } catch {
            // Skip malformed NDJSON lines — don't abort the whole scan.
          }
        }
      }

      const topRules = Object.entries(hits)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([rule, count]) => ({ rule, count }));

      info.push({
        label: "redaction_telemetry_7d",
        value: topRules.length > 0 ? topRules : "no redaction hits in last 7d",
      });
      info.push({ label: "ndjson_files_scanned", value: filesScanned });
    } catch (err) {
      info.push({ label: "redaction_telemetry_error", value: String(err) });
    }
  }

  // ── 7. Disk usage ─────────────────────────────────────────────────────────
  // Use db.name (better-sqlite3) to get the file path without needing config.
  try {
    const dbName = db.name;
    if (dbName && dbName !== ":memory:" && existsSync(dbName)) {
      info.push({ label: "events_db_bytes", value: statSync(dbName).size });
    } else {
      info.push({ label: "events_db_bytes", value: dbName === ":memory:" ? "in-memory" : "n/a" });
    }
  } catch (err) {
    info.push({ label: "disk_usage_error", value: String(err) });
  }

  if (rawLogDir && existsSync(rawLogDir)) {
    try {
      let rawBytes = 0;
      for (const f of readdirSync(rawLogDir)) {
        try {
          rawBytes += statSync(join(rawLogDir, f)).size;
        } catch {
          /* skip unreadable entries */
        }
      }
      info.push({ label: "raw_dir_bytes", value: rawBytes });
    } catch (err) {
      info.push({ label: "raw_dir_bytes_error", value: String(err) });
    }
  }

  const ok = anomalies.every((a) => a.severity !== "error");

  // ── Backfillable NULL turns check ─────────────────────────────────────────
  // Report how many NULL-model turns COULD be fixed by backfillTurnModels().
  // We only count here; no UPDATE is performed without explicit intent.
  try {
    const backfillable = (db.prepare(`
      SELECT COUNT(*) AS n FROM turns
      WHERE model_id IS NULL
        AND EXISTS (
          SELECT 1 FROM llm_messages lm
          WHERE lm.turn_id = turns.id AND lm.model_id IS NOT NULL
        )
    `).get() as { n: number } | undefined)?.n ?? 0;

    if (backfillable > 0) {
      info.push({
        label: "turns_backfillable",
        value: `${backfillable} turn(s) with NULL model_id can be fixed — run backfillTurnModels() or /analytics doctor --backfill`,
      });
    }
  } catch (err) {
    info.push({ label: "turns_backfillable_error", value: String(err) });
  }

  return { ok, anomalies, info };
}
// ── Backfill helper ───────────────────────────────────────────────────────────

/**
 * Backfill `turns.model_id` and `turns.provider` for turns that have NULL
 * values but have at least one `llm_messages` row (written after migration 002)
 * that carries the real model attribution.
 *
 * NOT called automatically — only run with explicit user intent:
 *   /analytics doctor --backfill   (wired in index.ts)
 *   or call directly from a script.
 *
 * Idempotent: only updates rows where model_id IS NULL and a source exists.
 * Returns the number of turns updated.
 */
export function backfillTurnModels(sink: SqliteSink): { updated: number } {
  const db = sink.database;
  if (!db) return { updated: 0 };
  try {
    const result = db.prepare(`
      UPDATE turns
      SET
        model_id = (
          SELECT lm.model_id FROM llm_messages lm
          WHERE lm.turn_id = turns.id AND lm.model_id IS NOT NULL
          ORDER BY lm.ts ASC LIMIT 1
        ),
        provider = (
          SELECT lm.provider FROM llm_messages lm
          WHERE lm.turn_id = turns.id AND lm.provider IS NOT NULL
          ORDER BY lm.ts ASC LIMIT 1
        )
      WHERE turns.model_id IS NULL
        AND EXISTS (
          SELECT 1 FROM llm_messages lm
          WHERE lm.turn_id = turns.id AND lm.model_id IS NOT NULL
        )
    `).run();
    return { updated: result.changes };
  } catch (err) {
    console.warn("[analytics:doctor] backfillTurnModels failed:", err);
    return { updated: 0 };
  }
}



// ── Heal stale sessions ───────────────────────────────────────────────────────

/**
 * Close out stale sessions that have `ended_at IS NULL` and were started more
 * than `thresholdMs` milliseconds ago (default 24h).
 *
 * For each stale session:
 *   ended_at    = COALESCE(MAX(llm_messages.ts for that session), started_at + 60 000)
 *   exit_reason = 'healed_by_doctor'
 *
 * The 24h default threshold means the currently-active pi session (started
 * seconds/minutes/hours ago) is never touched — no explicit exclusion list
 * needed.
 *
 * Idempotent: a second call on the same DB returns { healed: 0 }.
 *
 * NOT called automatically — only with explicit user intent:
 *   /analytics doctor --heal-stale-sessions
 *   node scripts/doctor.mjs --heal-stale-sessions
 */
export function healStaleSessions(
  sink: SqliteSink,
  opts?: { thresholdMs?: number },
): { healed: number } {
  const db = sink.database;
  if (!db) return { healed: 0 };
  const cutoff = Date.now() - (opts?.thresholdMs ?? 24 * 60 * 60 * 1000);
  try {
    const result = db.prepare(`
      UPDATE sessions
      SET
        ended_at = COALESCE(
          (SELECT MAX(lm.ts)
           FROM llm_messages lm
           WHERE lm.session_id = sessions.id),
          sessions.started_at + 60000
        ),
        exit_reason = 'healed_by_doctor'
      WHERE ended_at IS NULL
        AND started_at < ?
    `).run(cutoff);
    return { healed: result.changes };
  } catch (err) {
    console.warn("[analytics:doctor] healStaleSessions failed:", err);
    return { healed: 0 };
  }
}

// ── Text formatter ────────────────────────────────────────────────────────────

/**
 * Format a DoctorReport as a human-readable multi-line string.
 * The caller is responsible for printing it (console.log / ctx.ui.notify).
 */
export function formatDoctorText(r: DoctorReport): string {
  const lines: string[] = [];

  const header = r.ok
    ? "analytics doctor — ✅ all checks passed"
    : "analytics doctor — ❌ issues found";
  lines.push(header);

  if (r.anomalies.length > 0) {
    lines.push("");
    lines.push("Anomalies:");
    for (const a of r.anomalies) {
      const icon = a.severity === "error" ? "❌" : "⚠️ ";
      lines.push(`  ${icon} [${a.severity.toUpperCase()}] ${a.check}: count=${a.count}`);
      if (a.sample !== undefined) {
        lines.push(`         sample: ${JSON.stringify(a.sample)}`);
      }
    }
  } else {
    lines.push("");
    lines.push("  No anomalies.");
  }

  if (r.info.length > 0) {
    lines.push("");
    lines.push("Info:");
    for (const i of r.info) {
      lines.push(`  ${i.label}: ${JSON.stringify(i.value)}`);
    }
  }

  return lines.join("\n");
}
