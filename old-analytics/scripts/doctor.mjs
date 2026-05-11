#!/usr/bin/env node
/**
 * scripts/doctor.mjs — Standalone CLI for the analytics doctor check.
 *
 * Usage:
 *   node scripts/doctor.mjs --db ~/.pi/analytics/events.db \
 *                           --raw-log-dir ~/.pi/analytics/raw \
 *                           [--json]
 *
 * The script initialises SqliteSink against the provided DB path, runs all
 * doctor invariants, and exits with code 0 (all checks passed) or 1 (one or
 * more error-level anomalies found).
 *
 * This lets e2e.sh run the doctor without needing pi to be registered for the
 * /analytics doctor command.
 */

import { parseArgs } from "node:util";
import { homedir } from "node:os";

// Parse CLI flags ─────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    db:                    { type: "string" },
    "raw-log-dir":         { type: "string" },
    json:                  { type: "boolean", default: false },
    backfill:              { type: "boolean", default: false },
    "heal-stale-sessions": { type: "boolean", default: false },
    help:                  { type: "boolean", default: false },
  },
  strict: false,
});

if (args.help) {
  console.log(`
analytics doctor — standalone invariant checker

Usage:
  node scripts/doctor.mjs --db <path> [--raw-log-dir <path>] [--json] [--backfill] [--heal-stale-sessions]

Options:
  --db                    Path to events.db (required)
  --raw-log-dir           Path to NDJSON raw log directory (optional)
  --json                  Output JSON instead of human-readable text
  --backfill              Backfill turns.model_id from llm_messages
  --heal-stale-sessions   Auto-close sessions with no ended_at older than 24h
  --help                  Show this help
`.trim());
  process.exit(0);
}

if (!args.db) {
  console.error("error: --db is required");
  process.exit(1);
}

// Expand ~ in paths ───────────────────────────────────────────────────────────

function expandHome(p) {
  return p.startsWith("~") ? homedir() + p.slice(1) : p;
}

const dbPath = expandHome(args.db);
const rawLogDir = args["raw-log-dir"] ? expandHome(args["raw-log-dir"]) : undefined;

// Build a minimal AnalyticsConfig pointing at the provided DB ─────────────────

const config = {
  local: {
    enabled: true,
    dbPath,
    rawLogDir: rawLogDir ?? "~/.pi/analytics/raw",
  },
  privacy: {
    storePrompts: "hashed",
    storeToolArgs: "summary",
    storeToolOutputs: "size-only",
    redactPatterns: [],
  },
  git: { enabled: false, fetchPR: false, ghTimeoutMs: 2000 },
};

// Dynamic import so the TS source is loaded via Node's native TS support ──────
//
// better-sqlite3 is a native addon compiled against a specific Node ABI
// (MODULE_VERSION).  If the shell `node` differs from the Node that ran
// `npm install`, the native module load will fail with ERR_DLOPEN_FAILED.
// We catch that case explicitly and print a clear remediation command so the
// user (and e2e.sh) gets an actionable message rather than a cryptic crash.

const EXT_DIR = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

let SqliteSink, runDoctor, formatDoctorText, backfillTurnModels, healStaleSessions;
try {
  ({ SqliteSink }           = await import("../src/sinks/sqlite.ts"));
  ({ runDoctor, formatDoctorText, backfillTurnModels, healStaleSessions } = await import("../src/commands/doctor.ts"));
} catch (err) {
  const msg = String(err?.message ?? err);
  if (err?.code === "ERR_DLOPEN_FAILED" || /MODULE_VERSION/.test(msg) || /was compiled against a different Node\.js version/.test(msg)) {
    console.error("[doctor] native module version mismatch — rebuild better-sqlite3:");
    console.error(`  cd ${EXT_DIR} && npm rebuild better-sqlite3`);
    console.error(`  (current node: ${process.version}, modules: ${process.versions.modules})`);
    console.error("Original error:", err.message);
    process.exit(2);
  }
  throw err;
}

// Run ─────────────────────────────────────────────────────────────────────────

const sink = new SqliteSink();
await sink.init(config);

if (args.backfill) {
  const { updated } = backfillTurnModels(sink);
  if (args.json) {
    console.log(JSON.stringify({ updated }, null, 2));
  } else {
    console.log(`✅ Backfilled model_id for ${updated} turn(s).`);
  }
  if (!args["heal-stale-sessions"]) {
    await sink.close();
    process.exit(0);
  }
}

if (args["heal-stale-sessions"]) {
  // Print state before.
  const before = runDoctor(sink, { rawLogDir });
  if (args.json) {
    console.log(JSON.stringify(before, null, 2));
  } else {
    console.log(formatDoctorText(before));
  }

  const { healed } = healStaleSessions(sink);
  if (args.json) {
    console.log(JSON.stringify({ healed }, null, 2));
  } else {
    console.log(`✅ Healed ${healed} stale session(s).`);
  }

  // Print state after.
  const after = runDoctor(sink, { rawLogDir });
  if (args.json) {
    console.log(JSON.stringify(after, null, 2));
  } else {
    console.log(formatDoctorText(after));
  }

  await sink.close();
  process.exit(after.ok ? 0 : 1);
}

const report = runDoctor(sink, { rawLogDir });

await sink.close();

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(formatDoctorText(report));
}

process.exit(report.ok ? 0 : 1);
