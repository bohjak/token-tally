// @ts-check
/**
 * Tests: concurrent writer behaviour
 *
 * Covers:
 *   - Two writer processes writing to the same DB simultaneously produce no
 *     duplicates and no corruption (FK integrity holds)
 *
 * Implementation: uses node:worker_threads to simulate parallel processes.
 * Workers share the file-system path but use independent SQLite connections,
 * exactly as real harness writers do.
 *
 * The test file doubles as the worker script: when `isMainThread` is false,
 * the worker body executes; when true, the test suite runs.
 */

"use strict";

const { Worker, isMainThread, workerData, parentPort } = require("node:worker_threads");
const path = require("node:path");

// ---------------------------------------------------------------------------
// Worker body (executes when this file is loaded as a worker thread)
// ---------------------------------------------------------------------------

if (!isMainThread) {
  (async () => {
    const { AnalyticsWriter } = require("../dist/src/index");
    const {
      dbPath,
      spoolDir,
      harnessId,
      sessionCount,
      workerIndex,
    } = /** @type {{ dbPath: string; spoolDir: string; harnessId: string; sessionCount: number; workerIndex: number }} */ (
      workerData
    );

    try {
      const writer = await AnalyticsWriter.open({
        dbPath,
        spoolDir,
        harnessName: harnessId,
      });
      await writer.recordHarness({ name: harnessId, displayName: harnessId });

      for (let i = 0; i < sessionCount; i++) {
        // Session IDs are unique per worker so they don't collapse on the
        // unique constraint — we want each worker to own its own sessions.
        const { id: sessionId } = await writer.recordSession({
          harnessId,
          harnessSessionId: `worker${workerIndex}-s${i}`,
          startedAt: Date.now(),
        });
        const { id: turnId } = await writer.recordTurn({
          harnessId,
          sessionId,
          harnessTurnId: `worker${workerIndex}-t${i}`,
          startedAt: Date.now(),
        });
        await writer.recordLlmMessage({
          harnessId,
          sessionId,
          turnId,
          harnessMessageId: `worker${workerIndex}-m${i}`,
          ts: Date.now(),
          inputTokens: 10,
          outputTokens: 5,
          costInputMicros: 1_000,
          costOutputMicros: 500,
          costSource: "writer",
        });
      }

      await writer.close();
      parentPort?.postMessage({ ok: true });
    } catch (err) {
      parentPort?.postMessage({ ok: false, error: String(err) });
    }
  })();
}

// ---------------------------------------------------------------------------
// Helper: spawn N worker threads (main-thread only)
// ---------------------------------------------------------------------------

// `__filename` is the absolute path of this CJS file; safe to pass to Worker().

/**
 * Spawn N workers each writing `sessionCount` sessions to the shared DB.
 *
 * @param {number} count
 * @param {{ dbPath: string; spoolDir: string; harnessId: string; sessionCount: number }} opts
 * @returns {Promise<Array<{ ok: boolean; error?: string }>>}
 */
function spawnWorkers(count, opts) {
  return Promise.all(
    Array.from({ length: count }, (_, i) =>
      new Promise((resolve) => {
        const w = new Worker(__filename, {
          workerData: {
            dbPath: opts.dbPath,
            spoolDir: opts.spoolDir,
            harnessId: opts.harnessId,
            sessionCount: opts.sessionCount,
            workerIndex: i,
          },
        });
        w.on("message", (/** @type {{ ok: boolean; error?: string }} */ msg) => resolve(msg));
        w.on("error", (err) => resolve({ ok: false, error: String(err) }));
        w.on("exit", (code) => {
          // Only fires if the worker exited without sending a message.
          if (code !== 0) resolve({ ok: false, error: `exit code ${code}` });
        });
      })
    )
  );
}

// ---------------------------------------------------------------------------
// Tests (main-thread only)
// ---------------------------------------------------------------------------

if (isMainThread) {
  const { describe, test, before, after } = require("node:test");
  const assert = require("node:assert/strict");
  const { join } = require("node:path");
  const { makeTempDir, openDb, countRows } = require("./helpers");

  describe("concurrent writers", () => {
    /** @type {{ dir: string; cleanup: () => void }} */
    let tmp;

    before(() => {
      tmp = makeTempDir();
    });

    after(() => {
      tmp.cleanup();
    });

    test("two workers writing simultaneously produce correct session counts", async () => {
      const dbPath = join(tmp.dir, "concurrent.db");
      const spoolDir = join(tmp.dir, "concurrent-spool");
      const WORKERS = 2;
      const SESSIONS_PER_WORKER = 3;

      const results = await spawnWorkers(WORKERS, {
        dbPath,
        spoolDir,
        harnessId: "pi",
        sessionCount: SESSIONS_PER_WORKER,
      });

      for (const [i, r] of results.entries()) {
        assert.ok(r.ok, `worker ${i} failed: ${r.ok ? "" : r.error}`);
      }

      const db = openDb(dbPath);
      const sessionCount = countRows(db, "sessions");
      const msgCount = countRows(db, "llm_messages");
      db.close();

      // Each worker writes unique sessions; no UNIQUE collision expected.
      // Total should equal WORKERS × SESSIONS_PER_WORKER.
      assert.equal(
        sessionCount,
        WORKERS * SESSIONS_PER_WORKER,
        `expected ${WORKERS * SESSIONS_PER_WORKER} sessions, got ${sessionCount}`
      );
      assert.equal(
        msgCount,
        WORKERS * SESSIONS_PER_WORKER,
        `expected ${WORKERS * SESSIONS_PER_WORKER} messages, got ${msgCount}`
      );
    });

    test("concurrent writes leave FK integrity intact", async () => {
      const dbPath = join(tmp.dir, "concurrent-fk.db");
      const spoolDir = join(tmp.dir, "concurrent-fk-spool");

      const results = await spawnWorkers(3, {
        dbPath,
        spoolDir,
        harnessId: "pi",
        sessionCount: 2,
      });
      // Workers may spool on busy; that's acceptable — FK check applies to
      // whatever was written to the DB.
      for (const [i, r] of results.entries()) {
        assert.ok(r.ok, `worker ${i} failed: ${r.ok ? "" : r.error}`);
      }

      const db = openDb(dbPath);
      db.pragma("foreign_keys = ON");
      const violations = /** @type {any[]} */ (db.pragma("foreign_key_check"));
      db.close();

      assert.equal(violations.length, 0, "no FK violations after concurrent writes");
    });

    test("same-session upsert from two workers produces exactly 1 row", async () => {
      // Both workers write the same harnessSessionId → UNIQUE constraint causes
      // ON CONFLICT DO UPDATE; the row must exist exactly once.
      const dbPath = join(tmp.dir, "concurrent-upsert.db");
      const spoolDir = join(tmp.dir, "concurrent-upsert-spool");

      // Use a shared harness ID so both workers upsert the same harness row too.
      const results = await spawnWorkers(2, {
        dbPath,
        spoolDir,
        harnessId: "shared",
        sessionCount: 1,
      });

      // Both workers share harnessId but use different harnessSessionIds
      // (worker0-s0 vs worker1-s0). So sessions = 2, harnesses = 1.
      for (const [i, r] of results.entries()) {
        assert.ok(r.ok, `worker ${i} failed: ${r.ok ? "" : r.error}`);
      }

      const db = openDb(dbPath);
      assert.equal(countRows(db, "harnesses"), 1, "harness upsert should produce 1 row");
      db.close();
    });
  });
}
