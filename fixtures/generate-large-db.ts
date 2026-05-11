/**
 * generate-large-db.ts — Performance fixture generator for ToTally.
 *
 * Creates a SQLite database with ~1 million `llm_messages` rows spread across
 * 3 harnesses and 6 months of timestamps. The DB is intended for performance
 * testing the tray query layer (budget: <50 ms for today/week summary on a
 * modern Mac) and is never committed to the repository.
 *
 * Usage:
 *   pnpm exec tsx fixtures/generate-large-db.ts --out /tmp/token-tally-large.db
 *   pnpm exec tsx fixtures/generate-large-db.ts --out /tmp/tt-perf.db --rows 500000
 *
 * The generator bulk-inserts using a single transaction per harness/batch for
 * acceptable performance. Expect ~10–30 seconds on a modern Mac for 1 M rows.
 *
 * IMPORTANT: Do not commit the generated DB. It is regenerated on demand.
 */

import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_ROWS = 1_000_000;
const BATCH_SIZE = 10_000; // rows per transaction to keep memory flat

/** Harness profiles: distribution of rows across providers and models. */
type HarnessProfile = {
  harnessId: string;
  displayName: string;
  fraction: number; // share of total rows (must sum to 1.0)
  models: Array<{ id: string; provider: string; inputRate: number; outputRate: number }>;
};

const HARNESS_PROFILES: HarnessProfile[] = [
  {
    harnessId: "pi",
    displayName: "Pi",
    fraction: 0.5,
    models: [
      { id: "claude-3-opus-20240229",    provider: "anthropic", inputRate: 15, outputRate: 75  },
      { id: "claude-3-5-sonnet-20241022", provider: "anthropic", inputRate:  3, outputRate: 15  },
      { id: "claude-3-haiku-20240307",   provider: "anthropic", inputRate:  0.25, outputRate: 1.25 },
    ],
  },
  {
    harnessId: "claude-code",
    displayName: "Claude Code",
    fraction: 0.35,
    models: [
      { id: "claude-opus-4-5",   provider: "anthropic", inputRate: 15,  outputRate: 75  },
      { id: "claude-sonnet-4-5", provider: "anthropic", inputRate:  3,  outputRate: 15  },
    ],
  },
  {
    harnessId: "opencode",
    displayName: "OpenCode",
    fraction: 0.15,
    models: [
      { id: "gpt-4o",      provider: "openai", inputRate: 2.5, outputRate: 10  },
      { id: "gpt-4o-mini", provider: "openai", inputRate: 0.15, outputRate: 0.6 },
    ],
  },
];

// Repository profiles sprinkled across sessions.
const REPOS = [
  { owner: "acme", name: "backend",  remote: "git@github.com:acme/backend.git" },
  { owner: "acme", name: "frontend", remote: "git@github.com:acme/frontend.git" },
  { owner: "me",   name: "dotfiles", remote: null },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseArgs(): { outPath: string; targetRows: number } {
  const args = process.argv.slice(2);
  let outPath: string | undefined;
  let targetRows = DEFAULT_ROWS;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out" && args[i + 1]) {
      outPath = resolve(args[++i]);
    } else if (args[i] === "--rows" && args[i + 1]) {
      targetRows = parseInt(args[++i], 10);
    }
  }

  if (outPath == null) {
    console.error(
      "Usage: pnpm exec tsx fixtures/generate-large-db.ts --out <path> [--rows N]"
    );
    process.exit(1);
  }

  return { outPath, targetRows };
}

/** Uniform random integer in [lo, hi]. */
function randInt(lo: number, hi: number): number {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** Pick a random element from an array. */
function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

/**
 * USD cost per million tokens → micros per token.
 * inputRate and outputRate are $/M tokens on provider's published rate.
 */
function microCostPerToken(rateUsdPerMillion: number): number {
  return rateUsdPerMillion; // already micro (1 USD/M = 1 micro/token)
}

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

function openDb(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  return db;
}

function runMigrations(db: Database.Database): void {
  // Import migrations from the store package (already built).
  // Resolve relative to this file's location.
  const { runMigrations: migrate } = require("../store/dist/src/index");
  migrate(db);
}

// ---------------------------------------------------------------------------
// Data generation
// ---------------------------------------------------------------------------

/**
 * Inserts harness metadata rows.
 */
function insertHarnesses(db: Database.Database): void {
  const stmt = db.prepare(`
    INSERT INTO harnesses (name, display_name, version, integration_version, first_seen_at, last_seen_at)
    VALUES ($name, $displayName, $version, $integrationVersion, $now, $now)
    ON CONFLICT (name) DO UPDATE SET last_seen_at = excluded.last_seen_at
  `);

  const now = Date.now();
  db.transaction(() => {
    for (const h of HARNESS_PROFILES) {
      stmt.run({
        name: h.harnessId,
        displayName: h.displayName,
        version: "1.0.0",
        integrationVersion: "0.1.0",
        now,
      });
    }
  })();
}

/**
 * Returns an array of session IDs inserted for `harnessId`.
 * Sessions are distributed over 6 months ending at `endMs`.
 */
function insertSessions(
  db: Database.Database,
  harnessId: string,
  sessionCount: number,
  endMs: number
): string[] {
  const SIX_MONTHS_MS = 6 * 30 * 24 * 3_600_000;
  const startMs = endMs - SIX_MONTHS_MS;

  const stmt = db.prepare(`
    INSERT INTO sessions
      (id, harness_id, harness_session_id, cwd, repo_owner, repo_name, repo_remote, started_at, ended_at)
    VALUES
      ($id, $harnessId, $harnessSessionId, $cwd, $repoOwner, $repoName, $repoRemote, $startedAt, $endedAt)
  `);

  const ids: string[] = [];

  db.transaction(() => {
    for (let i = 0; i < sessionCount; i++) {
      const id = randomUUID();
      const repo = pick(REPOS);
      const ts = startMs + Math.random() * (endMs - startMs);

      stmt.run({
        id,
        harnessId,
        harnessSessionId: `${harnessId}-sess-${i}`,
        cwd: `/home/user/${repo.name}`,
        repoOwner: repo.owner,
        repoName: repo.name,
        repoRemote: repo.remote ?? null,
        startedAt: Math.floor(ts),
        endedAt: Math.floor(ts + randInt(30_000, 3_600_000)),
      });

      ids.push(id);
    }
  })();

  return ids;
}

/**
 * Inserts turns for each session and returns a map from sessionId → turnIds.
 */
function insertTurns(
  db: Database.Database,
  harnessId: string,
  sessionIds: string[],
  turnsPerSession: number,
  profile: HarnessProfile
): Map<string, string[]> {
  const stmt = db.prepare(`
    INSERT INTO turns
      (id, session_id, harness_id, harness_turn_id, turn_index, started_at, ended_at, provider, model_id)
    VALUES
      ($id, $sessionId, $harnessId, $harnessTurnId, $turnIndex, $startedAt, $endedAt, $provider, $modelId)
  `);

  const map = new Map<string, string[]>();

  db.transaction(() => {
    for (const sessionId of sessionIds) {
      const turnIds: string[] = [];
      for (let t = 0; t < turnsPerSession; t++) {
        const model = pick(profile.models);
        const id = randomUUID();
        const ts = Date.now() - randInt(0, 180 * 24 * 3_600_000);

        stmt.run({
          id,
          sessionId,
          harnessId,
          harnessTurnId: `${sessionId}-t${t}`,
          turnIndex: t,
          startedAt: ts,
          endedAt: ts + randInt(1_000, 120_000),
          provider: model.provider,
          modelId: model.id,
        });

        turnIds.push(id);
      }
      map.set(sessionId, turnIds);
    }
  })();

  return map;
}

type MsgBatch = {
  harnessId: string;
  sessionId: string;
  turnId: string;
  modelProvider: string;
  modelId: string;
  ts: number;
};

/**
 * Inserts `llm_messages` rows in batches.
 * Returns the number of rows inserted.
 */
function insertMessages(
  db: Database.Database,
  batches: MsgBatch[]
): number {
  const stmt = db.prepare(`
    INSERT INTO llm_messages (
      id, session_id, turn_id, harness_id, harness_message_id,
      ts, provider, model_id,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      cost_input_micros, cost_output_micros, cost_cache_read_micros, cost_cache_write_micros,
      cost_total_micros, cost_currency, cost_source
    ) VALUES (
      $id, $sessionId, $turnId, $harnessId, $harnessMessageId,
      $ts, $provider, $modelId,
      $inputTokens, $outputTokens, $cacheReadTokens, $cacheWriteTokens,
      $costInputMicros, $costOutputMicros, $costCacheReadMicros, $costCacheWriteMicros,
      $costTotalMicros, 'USD', 'writer'
    )
  `);

  // Look up model rates by modelId.
  const rateMap = new Map<string, { inputRate: number; outputRate: number }>();
  for (const h of HARNESS_PROFILES) {
    for (const m of h.models) {
      rateMap.set(m.id, { inputRate: m.inputRate, outputRate: m.outputRate });
    }
  }

  let inserted = 0;
  const insertBatch = db.transaction((slice: MsgBatch[]) => {
    for (const b of slice) {
      const rates = rateMap.get(b.modelId) ?? { inputRate: 3, outputRate: 15 };
      const inputTokens = randInt(200, 8_000);
      const outputTokens = randInt(50, 2_000);
      const cacheRead = randInt(0, 500);
      const cacheWrite = randInt(0, 100);

      const costInputMicros = Math.round(inputTokens * microCostPerToken(rates.inputRate));
      const costOutputMicros = Math.round(outputTokens * microCostPerToken(rates.outputRate));
      const costCacheReadMicros = Math.round(cacheRead * microCostPerToken(rates.inputRate * 0.1));
      const costCacheWriteMicros = Math.round(cacheWrite * microCostPerToken(rates.inputRate));
      const costTotalMicros =
        costInputMicros + costOutputMicros + costCacheReadMicros + costCacheWriteMicros;

      stmt.run({
        id: randomUUID(),
        sessionId: b.sessionId,
        turnId: b.turnId,
        harnessId: b.harnessId,
        harnessMessageId: randomUUID(), // unique per message
        ts: b.ts,
        provider: b.modelProvider,
        modelId: b.modelId,
        inputTokens,
        outputTokens,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        costInputMicros,
        costOutputMicros,
        costCacheReadMicros,
        costCacheWriteMicros,
        costTotalMicros,
      });

      inserted++;
    }
  });

  // Process in BATCH_SIZE chunks to keep memory flat.
  for (let i = 0; i < batches.length; i += BATCH_SIZE) {
    insertBatch(batches.slice(i, i + BATCH_SIZE));
    process.stdout.write(
      `\r  ${inserted.toLocaleString()} / ${batches.length.toLocaleString()} messages…`
    );
  }
  process.stdout.write("\n");

  return inserted;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const { outPath, targetRows } = parseArgs();

  if (existsSync(outPath)) {
    console.log(`Removing existing file: ${outPath}`);
    require("node:fs").unlinkSync(outPath);
  }

  console.log(`Generating large fixture DB → ${outPath}`);
  console.log(`Target: ~${targetRows.toLocaleString()} llm_messages rows`);
  console.log(`Harnesses: ${HARNESS_PROFILES.map((h) => h.harnessId).join(", ")}`);

  const db = openDb(outPath);
  runMigrations(db);

  const nowMs = Date.now();
  let totalMessages = 0;

  insertHarnesses(db);
  console.log("Harnesses inserted.");

  for (const profile of HARNESS_PROFILES) {
    const harnessRows = Math.round(targetRows * profile.fraction);
    // Choose session / turn topology so total messages ≈ harnessRows.
    const sessionCount = Math.max(1, Math.round(harnessRows / 5)); // ~5 msgs/session
    const turnsPerSession = 2;
    const msgsPerTurn = Math.round(harnessRows / (sessionCount * turnsPerSession));

    console.log(
      `\n[${profile.harnessId}] sessions=${sessionCount}, ` +
        `turns/session=${turnsPerSession}, msgs/turn=${msgsPerTurn}`
    );

    const sessionIds = insertSessions(db, profile.harnessId, sessionCount, nowMs);
    console.log(`  ${sessionIds.length.toLocaleString()} sessions inserted.`);

    const turnMap = insertTurns(db, profile.harnessId, sessionIds, turnsPerSession, profile);
    const totalTurns = Array.from(turnMap.values()).reduce((n, ids) => n + ids.length, 0);
    console.log(`  ${totalTurns.toLocaleString()} turns inserted.`);

    // Build the full batch of message descriptors.
    const batches: MsgBatch[] = [];
    for (const [sessionId, turnIds] of turnMap) {
      for (const turnId of turnIds) {
        const model = pick(profile.models);
        for (let m = 0; m < msgsPerTurn; m++) {
          batches.push({
            harnessId: profile.harnessId,
            sessionId,
            turnId,
            modelProvider: model.provider,
            modelId: model.id,
            ts: nowMs - randInt(0, 6 * 30 * 24 * 3_600_000),
          });
        }
      }
    }

    // Shuffle timestamps so they aren't artificially ordered by session.
    batches.sort(() => Math.random() - 0.5);

    const inserted = insertMessages(db, batches);
    totalMessages += inserted;
    console.log(
      `  ${inserted.toLocaleString()} messages inserted (running total: ${totalMessages.toLocaleString()})`
    );
  }

  db.close();

  console.log(
    `\nDone. Total llm_messages: ~${totalMessages.toLocaleString()} rows in ${outPath}`
  );
  console.log(
    "Tip: run the Swift PerformanceTests against this fixture to check the <50 ms budget."
  );
}

main();
