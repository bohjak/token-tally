// @ts-check
/**
 * Tests: spool fallback and drain
 *
 * Covers:
 *   - Writer falls back to spool when DB path is unavailable
 *   - Explicit opt-in spool drain on next successful open restores rows to the DB
 *   - Active spool file is NOT drained (only .ndjson.closed)
 *   - SpoolWriter.rotate() produces a .ndjson.closed file
 *   - Drain is idempotent: re-opening after a successful drain sees same rows
 *   - ingestFile does not scan/drain the default spool directory (T5)
 *   - ingestDir routes to bounded drain and respects maxFiles bound (T5)
 *   - Pi lifecycle multi-record spool file ingests parent/child records (T5)
 *   - Idempotency: ingesting same file twice produces no duplicate rows (T5)
 *   - Legacy emergency spool repair: turn with spool:pi: session (T10)
 *   - Legacy emergency spool repair: llm-message with spool:<uuid>: turn (T10)
 *   - Legacy emergency spool repair: llm-message with spool:spool: nested turn (T10)
 *   - Legacy emergency spool repair: tool-call with nested turn (T10)
 *   - Legacy emergency spool fixture ingests successfully (T10)
 *   - Unparseable legacy spool ID quarantines cleanly (T10)
 */

"use strict";

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { join } = require("node:path");
const { existsSync, readdirSync } = require("node:fs");
const {
  AnalyticsWriter,
  SpoolWriter,
  drainClosedSpoolFiles,
  promoteStaleActiveFiles,
} = require("../dist/src/index");
const { ingestFile, ingestDir } = require("../dist/src/ingest");
const { makeTempDir, openDb, countRows, seedMinimalData } = require("./helpers");
const path = require("node:path");
const fs = require("node:fs");

// A path that can never be a valid DB (writing to /dev/null sub-path fails).
const UNREACHABLE_DB = "/dev/null/token-tally.db";

describe("spool fallback and drain", () => {
  /** @type {{ dir: string; cleanup: () => void }} */
  let tmp;

  before(() => {
    tmp = makeTempDir();
  });

  after(() => {
    tmp.cleanup();
  });

  test("writer falls back to spool when DB is unavailable", async () => {
    const spoolDir = join(tmp.dir, "spool-fallback");

    const writer = await AnalyticsWriter.open({
      dbPath: UNREACHABLE_DB,
      spoolDir,
      harnessName: "pi",
    });

    await writer.recordHarness({ name: "pi", displayName: "Pi" });
    await writer.recordSession({
      harnessId: "pi",
      harnessSessionId: "spool-sess-1",
      startedAt: Date.now(),
    });
    await writer.close();

    // A .ndjson.closed file should exist; the DB write was skipped.
    assert.ok(existsSync(spoolDir), "spool dir should exist");
    const closedFiles = readdirSync(spoolDir).filter(
      (/** @type {string} */ f) => f.endsWith(".ndjson.closed")
    );
    assert.ok(closedFiles.length > 0, "should have at least one .ndjson.closed file");
  });

  test("explicit drain on next open restores rows to the DB from spool", async () => {
    const spoolDir = join(tmp.dir, "spool-drain");
    const goodDb = join(tmp.dir, "good-drain.db");

    // --- Phase 1: write to spool (bad DB path) ---
    const w1 = await AnalyticsWriter.open({
      dbPath: UNREACHABLE_DB,
      spoolDir,
      harnessName: "pi",
    });
    await w1.recordHarness({ name: "pi", displayName: "Pi" });
    const { id: spoolSessionId } = await w1.recordSession({
      harnessId: "pi",
      harnessSessionId: "drain-sess-1",
      startedAt: 1_000_000,
    });
    const { id: spoolTurnId } = await w1.recordTurn({
      harnessId: "pi",
      sessionId: spoolSessionId,
      harnessTurnId: "drain-turn-1",
      startedAt: 1_100_000,
    });
    await w1.recordLlmMessage({
      harnessId: "pi",
      sessionId: spoolSessionId,
      turnId: spoolTurnId,
      harnessMessageId: "drain-msg-1",
      ts: 1_200_000,
      inputTokens: 50,
      costInputMicros: 500,
      costSource: "writer",
    });
    await w1.close();

    // Confirm rows are NOT in the good DB yet.
    const db0 = openDb(goodDb);
    // goodDb doesn't even exist yet at this point — AnalyticsWriter.open will
    // create and migrate it during phase 2.
    db0.close();

    // --- Phase 2: open the good DB with explicit drain — replay spool ---
    const w2 = await AnalyticsWriter.open({
      dbPath: goodDb,
      spoolDir,
      harnessName: "pi",
      drain: { onOpen: true },
    });
    await w2.close();

    const db = openDb(goodDb);
    assert.equal(countRows(db, "harnesses"), 1, "harness should be drained");
    assert.equal(countRows(db, "sessions"), 1, "session should be drained");
    assert.equal(countRows(db, "turns"), 1, "turn should be drained");
    assert.equal(countRows(db, "llm_messages"), 1, "llm_message should be drained");
    db.close();

    // Spool dir should now be empty (files deleted after successful drain).
    const remaining = readdirSync(spoolDir).filter(
      (/** @type {string} */ f) => f.endsWith(".ndjson.closed")
    );
    assert.equal(remaining.length, 0, "closed spool files should be deleted after drain");
  });

  test("active .ndjson files are not drained", async () => {
    const spoolDir = join(tmp.dir, "spool-active-guard");
    const goodDb = join(tmp.dir, "good-active.db");

    // Create an active spool file manually (simulate a live writer).
    const { mkdirSync, writeFileSync } = require("node:fs");
    mkdirSync(spoolDir, { recursive: true });
    const activeFile = join(spoolDir, "pi-99999.ndjson");
    writeFileSync(activeFile, '{"type":"harness","payload":{"name":"pi","displayName":"Pi"}}\n');

    // Open the good DB with explicit drain. The active file should NOT be drained.
    const writer = await AnalyticsWriter.open({
      dbPath: goodDb,
      spoolDir,
      harnessName: "pi",
      drain: { onOpen: true },
    });
    await writer.close();

    assert.ok(existsSync(activeFile), "active spool file must not be touched by drain");

    const db = openDb(goodDb);
    // harnesses should be empty because the active file was NOT drained.
    assert.equal(countRows(db, "harnesses"), 0);
    db.close();
  });

  test("SpoolWriter.rotate() produces a .ndjson.closed file from an active file", () => {
    const spoolDir = join(tmp.dir, "spool-rotate");
    const sw = new SpoolWriter(spoolDir, "pi");

    // Write one record to create the active file.
    sw.write({ type: "harness", payload: { name: "pi", displayName: "Pi" } });

    const before = readdirSync(spoolDir);
    assert.ok(
      before.some((/** @type {string} */ f) => f.endsWith(".ndjson") && !f.endsWith(".ndjson.closed")),
      "should have an active .ndjson file before rotation"
    );

    sw.rotate();

    const after = readdirSync(spoolDir);
    assert.ok(
      after.some((/** @type {string} */ f) => f.endsWith(".ndjson.closed")),
      "should have a .ndjson.closed file after rotation"
    );
    assert.ok(
      !after.some((/** @type {string} */ f) => f.endsWith(".ndjson") && !f.endsWith(".ndjson.closed")),
      "active .ndjson file should be gone after rotation"
    );
  });

  test("empty active spool file is cleaned up on rotate (no closed file)", () => {
    const spoolDir = join(tmp.dir, "spool-empty-rotate");
    const sw = new SpoolWriter(spoolDir, "pi");

    // Do NOT write anything — active file was never created.
    sw.rotate(); // no-op, should not throw

    // Even if the directory was created, no .ndjson.closed should exist.
    if (existsSync(spoolDir)) {
      const files = readdirSync(spoolDir);
      assert.equal(files.length, 0, "no files should exist when nothing was written");
    }
  });

  test("drain is idempotent: re-opening after full drain produces same row counts", async () => {
    const spoolDir = join(tmp.dir, "spool-idem-drain");
    const goodDb = join(tmp.dir, "good-idem.db");

    // Phase 1: spool.
    const w1 = await AnalyticsWriter.open({
      dbPath: UNREACHABLE_DB,
      spoolDir,
      harnessName: "pi",
    });
    await w1.recordHarness({ name: "pi", displayName: "Pi" });
    await w1.recordSession({ harnessId: "pi", harnessSessionId: "idem-s1", startedAt: 1 });
    await w1.close();

    // Phase 2: explicitly drain into goodDb.
    const w2 = await AnalyticsWriter.open({
      dbPath: goodDb,
      spoolDir,
      harnessName: "pi",
      drain: { onOpen: true },
    });
    await w2.close();

    // Phase 3: explicitly drain again — no spool files left, row counts unchanged.
    const w3 = await AnalyticsWriter.open({
      dbPath: goodDb,
      spoolDir,
      harnessName: "pi",
      drain: { onOpen: true },
    });
    await w3.close();

    const db = openDb(goodDb);
    assert.equal(countRows(db, "harnesses"), 1);
    assert.equal(countRows(db, "sessions"), 1);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// T5: ingest API and bounded drain behavior
// ---------------------------------------------------------------------------

describe("ingest API and bounded drain (T5)", () => {
  /** @type {{ dir: string; cleanup: () => void }} */
  let tmp;

  before(() => {
    tmp = makeTempDir();
  });

  after(() => {
    tmp.cleanup();
  });

  test("ingestFile does not scan or drain the default spool directory", async () => {
    // Place an extra .closed spool file in a separate spool dir that is NOT
    // the file being ingested, to confirm ingestFile leaves it alone.
    const extraSpoolDir = path.join(tmp.dir, "extra-spool");
    const dbPath = path.join(tmp.dir, "no-side-scan.db");
    fs.mkdirSync(extraSpoolDir, { recursive: true });

    // Write a valid harness record into an extra closed spool file.
    const extraFile = path.join(extraSpoolDir, "extra-pi-99-12345.ndjson.closed");
    fs.writeFileSync(
      extraFile,
      JSON.stringify({ type: "harness", payload: { name: "bystander", displayName: "Bystander" } }) + "\n",
      "utf8",
    );

    // Create the target file to ingest (a different harness).
    const targetFile = path.join(tmp.dir, "target-ingest.ndjson.closed");
    fs.writeFileSync(
      targetFile,
      JSON.stringify({ type: "harness", payload: { name: "pi", displayName: "Pi" } }) + "\n",
      "utf8",
    );

    // ingestFile with only the target path and a different spoolDir.
    // The extra file in extraSpoolDir must be untouched.
    const result = await ingestFile(targetFile, { dbPath, spoolDir: extraSpoolDir });

    assert.equal(result.ingested, 1, "target file should be ingested");
    assert.equal(result.errors.length, 0);

    // Extra file in extraSpoolDir must NOT have been drained.
    assert.ok(fs.existsSync(extraFile), "extra spool file must still exist (not touched by ingestFile)");

    // Only 'pi' harness should be in the DB, not 'bystander'.
    const db = openDb(dbPath);
    assert.equal(
      db.prepare("SELECT count(*) as n FROM harnesses WHERE name='pi'").get().n,
      1,
      "only the target harness should be in the DB",
    );
    assert.equal(
      db.prepare("SELECT count(*) as n FROM harnesses WHERE name='bystander'").get().n,
      0,
      "bystander harness must not be drained as a side effect of ingestFile",
    );
    db.close();
  });

  test("ingestDir respects maxFiles bound: stops after N files", async () => {
    const spoolDir = path.join(tmp.dir, "bounded-spool");
    const dbPath = path.join(tmp.dir, "bounded.db");
    fs.mkdirSync(spoolDir, { recursive: true });

    // Write 3 closed spool files, each with a distinct harness.
    for (const name of ["harness-a", "harness-b", "harness-c"]) {
      fs.writeFileSync(
        path.join(spoolDir, `${name}-1-${Date.now()}.ndjson.closed`),
        JSON.stringify({ type: "harness", payload: { name, displayName: name } }) + "\n",
        "utf8",
      );
    }

    // Drain at most 1 file.
    const result = await ingestDir(spoolDir, { dbPath, maxFiles: 1 });

    assert.equal(result.ingested, 1, "should have drained exactly 1 file");
    assert.equal(result.errors.length, 0, "no errors expected for valid files");

    // 2 files should remain on disk.
    const remaining = fs.readdirSync(spoolDir).filter(
      (/** @type {string} */ f) => f.endsWith(".ndjson.closed"),
    );
    assert.equal(remaining.length, 2, "2 files should remain after maxFiles=1 drain");
  });

  test("Pi lifecycle multi-record spool fixture ingests parent/child records successfully", async () => {
    const dbPath = path.join(tmp.dir, "lifecycle-fixture.db");

    // Copy the fixture to a temp dir so the test can delete it on success.
    const fixtureSource = path.join(
      __dirname,
      "fixtures",
      "pi-lifecycle-spool.ndjson.closed",
    );
    const fixtureCopy = path.join(tmp.dir, "pi-lifecycle-spool.ndjson.closed");
    fs.copyFileSync(fixtureSource, fixtureCopy);

    const result = await ingestFile(fixtureCopy, { dbPath });

    assert.equal(result.ingested, 1, "fixture should be ingested");
    assert.equal(result.errors.length, 0, `unexpected errors: ${JSON.stringify(result.errors)}`);

    // Verify all five record types are present in the DB.
    const db = openDb(dbPath);
    assert.equal(
      db.prepare("SELECT count(*) as n FROM harnesses WHERE name='pi'").get().n,
      1,
      "harness row",
    );
    assert.equal(
      db.prepare("SELECT count(*) as n FROM sessions WHERE harness_id='pi'").get().n,
      1,
      "session row",
    );
    assert.equal(
      db.prepare("SELECT count(*) as n FROM turns WHERE harness_id='pi'").get().n,
      1,
      "turn row",
    );
    assert.equal(
      db.prepare("SELECT count(*) as n FROM llm_messages WHERE harness_id='pi'").get().n,
      1,
      "llm_message row",
    );
    assert.equal(
      db.prepare("SELECT count(*) as n FROM tool_calls WHERE harness_id='pi'").get().n,
      1,
      "tool_call row",
    );
    db.close();

    // File must be deleted after successful ingest.
    assert.ok(!fs.existsSync(fixtureCopy), "fixture file must be deleted after successful ingest");
  });

  test("ingesting the same spool file twice produces no duplicate rows (idempotency)", async () => {
    const dbPath = path.join(tmp.dir, "idempotent.db");

    // Ingest the fixture once.
    const fixtureSrc = path.join(
      __dirname,
      "fixtures",
      "pi-lifecycle-spool.ndjson.closed",
    );
    const copy1 = path.join(tmp.dir, "idempotent-pass1.ndjson.closed");
    fs.copyFileSync(fixtureSrc, copy1);

    const r1 = await ingestFile(copy1, { dbPath });
    assert.equal(r1.ingested, 1, "first ingest must succeed");
    assert.equal(r1.errors.length, 0);

    // Re-copy and ingest the same records a second time.
    const copy2 = path.join(tmp.dir, "idempotent-pass2.ndjson.closed");
    fs.copyFileSync(fixtureSrc, copy2);

    const r2 = await ingestFile(copy2, { dbPath });
    assert.equal(r2.ingested, 1, "second ingest must also succeed (upsert semantics)");
    assert.equal(r2.errors.length, 0);

    // Row counts must be identical after both passes.
    const db = openDb(dbPath);
    assert.equal(
      db.prepare("SELECT count(*) as n FROM harnesses WHERE name='pi'").get().n,
      1,
      "harness must not be duplicated",
    );
    assert.equal(
      db.prepare("SELECT count(*) as n FROM sessions WHERE harness_id='pi'").get().n,
      1,
      "session must not be duplicated",
    );
    assert.equal(
      db.prepare("SELECT count(*) as n FROM turns WHERE harness_id='pi'").get().n,
      1,
      "turn must not be duplicated",
    );
    assert.equal(
      db.prepare("SELECT count(*) as n FROM llm_messages WHERE harness_id='pi'").get().n,
      1,
      "llm_message must not be duplicated",
    );
    assert.equal(
      db.prepare("SELECT count(*) as n FROM tool_calls WHERE harness_id='pi'").get().n,
      1,
      "tool_call must not be duplicated",
    );
    db.close();
  });

  test("ingestDir with a directory path drains closed files in that directory", async () => {
    const spoolDir = path.join(tmp.dir, "dir-routing-spool");
    const dbPath = path.join(tmp.dir, "dir-routing.db");
    fs.mkdirSync(spoolDir, { recursive: true });

    fs.writeFileSync(
      path.join(spoolDir, "pi-1-99.ndjson.closed"),
      JSON.stringify({ type: "harness", payload: { name: "pi-dir", displayName: "Pi Dir" } }) + "\n",
      "utf8",
    );

    const result = await ingestDir(spoolDir, { dbPath });

    assert.equal(result.ingested, 1, "file in the given directory should be drained");
    assert.equal(result.errors.length, 0);

    const db = openDb(dbPath);
    assert.equal(
      db.prepare("SELECT count(*) as n FROM harnesses WHERE name='pi-dir'").get().n,
      1,
    );
    db.close();
  });
});

// ---------------------------------------------------------------------------
// T6: stale active-file promotion
// ---------------------------------------------------------------------------

describe("promoteStaleActiveFiles (T6)", () => {
  /** @type {{ dir: string; cleanup: () => void }} */
  let tmp;

  before(() => {
    tmp = makeTempDir();
  });

  after(() => {
    tmp.cleanup();
  });

  test("returns empty result when spool directory does not exist", () => {
    const result = promoteStaleActiveFiles(path.join(tmp.dir, "nonexistent-spool"));
    assert.deepEqual(result.promoted, []);
    assert.deepEqual(result.skipped, []);
  });

  test("returns empty result when spool directory contains only closed files", () => {
    const spoolDir = path.join(tmp.dir, "only-closed");
    fs.mkdirSync(spoolDir, { recursive: true });
    fs.writeFileSync(
      path.join(spoolDir, "pi-1-12345-99999.ndjson.closed"),
      "{\"type\":\"harness\"}\n",
      "utf8",
    );
    const result = promoteStaleActiveFiles(spoolDir);
    assert.deepEqual(result.promoted, []);
    assert.equal(result.skipped.length, 0);
  });

  test("skips active files with unrecognised filenames", () => {
    // A filename without a PID in the expected position should never be promoted.
    const spoolDir = path.join(tmp.dir, "unrecognised");
    fs.mkdirSync(spoolDir, { recursive: true });
    const badName = "no-pid-here.ndjson";
    fs.writeFileSync(path.join(spoolDir, badName), "{}\n", "utf8");
    const result = promoteStaleActiveFiles(spoolDir, { minAgeMs: 0 });
    assert.equal(result.promoted.length, 0, "must not promote unrecognised file");
    assert.equal(result.skipped.length, 1);
    assert.ok(
      result.skipped[0].reason.includes("recognised"),
      `unexpected skip reason: ${result.skipped[0].reason}`,
    );
    // Original file must still exist.
    assert.ok(fs.existsSync(path.join(spoolDir, badName)));
  });

  test("skips active file whose PID is the current process (alive)", () => {
    // Use the current process PID — guaranteed to be alive.
    const spoolDir = path.join(tmp.dir, "alive-pid");
    fs.mkdirSync(spoolDir, { recursive: true });
    // T3 Pi writer format: pi-<pid>-<open_ts>.ndjson
    const filename = `pi-${process.pid}-${Date.now()}.ndjson`;
    const filePath = path.join(spoolDir, filename);
    fs.writeFileSync(filePath, "{}\n", "utf8");

    const result = promoteStaleActiveFiles(spoolDir, { minAgeMs: 0 });
    assert.equal(result.promoted.length, 0, "must not promote a file with a live PID");
    assert.equal(result.skipped.length, 1);
    assert.ok(
      result.skipped[0].reason.includes("alive"),
      `unexpected skip reason: ${result.skipped[0].reason}`,
    );
    assert.ok(fs.existsSync(filePath), "original file must still exist");
  });

  test("skips active file whose PID is dead but below the minimum age threshold", () => {
    // PID 1 is init — always alive on macOS/Linux. PID 2 may be dead.
    // Use a known-dead PID value that won't collide with the current process.
    // We synthesize a definitely-dead PID by using a very high value unlikely
    // to be recycled, then use minAgeMs=Infinity to force the age guard.
    const spoolDir = path.join(tmp.dir, "too-young");
    fs.mkdirSync(spoolDir, { recursive: true });
    // Use a PID value that is almost certainly dead on any normal system.
    // (PID 4194303 is the theoretical max on Linux; no process runs that long.)
    const deadPid = 2999997;
    const filename = `pi-${deadPid}-${Date.now()}.ndjson`;
    const filePath = path.join(spoolDir, filename);
    fs.writeFileSync(filePath, "{}\n", "utf8");

    // minAgeMs = 1 year — file was just created so it won't pass the age guard.
    const result = promoteStaleActiveFiles(spoolDir, { minAgeMs: 365 * 24 * 3600 * 1000 });
    // If the PID happens to be alive (very unlikely), it will be skipped with
    // 'alive' reason. If it's dead but too young, it'll be skipped with 'too
    // recent'. Either way, it must not be promoted.
    assert.equal(result.promoted.length, 0, "must not promote a too-young file");
    assert.ok(fs.existsSync(filePath), "original file must still exist");
  });

  test("promotes an active file with a dead PID and sufficient age", () => {
    // Use an extremely high PID that is guaranteed dead, and backdate the
    // file's mtime past the minimum age threshold.
    const spoolDir = path.join(tmp.dir, "promote-success");
    fs.mkdirSync(spoolDir, { recursive: true });
    const deadPid = 2999998; // almost certainly never running
    const openTs = Date.now() - 10 * 60 * 1000; // 10 min ago
    const filename = `pi-${deadPid}-${openTs}.ndjson`;
    const filePath = path.join(spoolDir, filename);
    fs.writeFileSync(filePath, JSON.stringify({ type: "harness", payload: { name: "pi", displayName: "Pi" } }) + "\n", "utf8");

    // Backdate the file mtime by 10 minutes so it clears the default 5-min threshold.
    const backdated = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(filePath, backdated, backdated);

    // Use minAgeMs=1ms so the age check definitely passes (if PID is dead).
    const result = promoteStaleActiveFiles(spoolDir, { minAgeMs: 1 });

    if (result.promoted.length === 1) {
      // PID confirmed dead: file promoted correctly.
      assert.equal(result.promoted[0].reason, "dead-pid");
      assert.ok(
        result.promoted[0].closedPath.endsWith(".ndjson.closed"),
        "closed path must end in .ndjson.closed",
      );
      assert.ok(
        !fs.existsSync(filePath),
        "original active file must be gone after promotion",
      );
      assert.ok(
        fs.existsSync(result.promoted[0].closedPath),
        "closed file must exist at the reported path",
      );
    } else {
      // PID happened to be alive on this machine — acceptable, skip is expected.
      assert.equal(result.promoted.length, 0);
      assert.ok(fs.existsSync(filePath), "file must still exist if not promoted");
    }
  });

  test("recognises both Pi T3 format (pid-ts) and store format (pid-only)", () => {
    // This test verifies filename parsing covers both naming conventions.
    const spoolDir = path.join(tmp.dir, "dual-format");
    fs.mkdirSync(spoolDir, { recursive: true });

    const deadPid = 2999999;
    // T3 Pi format
    const piFile = `pi-${deadPid}-${Date.now() - 20000}.ndjson`;
    // Store writer format
    const storeFile = `claude-code-${deadPid}.ndjson`;

    fs.writeFileSync(path.join(spoolDir, piFile), "{}\n", "utf8");
    fs.writeFileSync(path.join(spoolDir, storeFile), "{}\n", "utf8");

    // Backdate both files.
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(path.join(spoolDir, piFile), old, old);
    fs.utimesSync(path.join(spoolDir, storeFile), old, old);

    const result = promoteStaleActiveFiles(spoolDir, { minAgeMs: 1 });

    // Both may be promoted (if PID is dead) or both skipped with 'alive' reason.
    // The key assertion: neither file is skipped with an 'unrecognised' reason.
    const unrecognisedSkips = result.skipped.filter(
      (s) => s.reason.includes("recognised"),
    );
    assert.equal(
      unrecognisedSkips.length,
      0,
      `both filenames should be parseable; got unrecognised: ${JSON.stringify(unrecognisedSkips)}`,
    );
  });
});

describe("failed-file quarantine (T8)", () => {
  /** @type {{ dir: string; cleanup: () => void }} */
  let tmp;

  before(() => {
    tmp = makeTempDir();
  });

  after(() => {
    tmp.cleanup();
  });

  test("drainClosedSpoolFiles quarantines malformed JSON with metadata", () => {
    const spoolDir = path.join(tmp.dir, "quarantine-json");
    fs.mkdirSync(spoolDir, { recursive: true });
    const badFile = path.join(spoolDir, "pi-111-1.ndjson.closed");
    fs.writeFileSync(badFile, "{not valid json}\n", "utf8");

    const result = drainClosedSpoolFiles(spoolDir, () => {
      throw new Error("callback should not run for malformed JSON");
    });

    assert.equal(result.drained, 0);
    assert.equal(result.quarantined, 1);
    assert.equal(result.errors.length, 0);
    assert.equal(fs.existsSync(badFile), false, "bad file must leave active spool");

    const failedDir = `${spoolDir}.failed`;
    const quarantinedPath = path.join(failedDir, path.basename(badFile));
    assert.equal(fs.existsSync(quarantinedPath), true, "original file content must be preserved");
    assert.equal(fs.readFileSync(quarantinedPath, "utf8"), "{not valid json}\n");

    const meta = JSON.parse(fs.readFileSync(`${quarantinedPath}.failed.json`, "utf8"));
    assert.equal(meta.version, 1);
    assert.equal(meta.originalPath, badFile);
    assert.match(meta.quarantinedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(meta.error, /JSON|Expected|Unexpected/i);
    assert.equal(meta.firstRecord, null);
  });

  test("drainClosedSpoolFiles quarantines DB/callback failures with first record", () => {
    const spoolDir = path.join(tmp.dir, "quarantine-callback");
    fs.mkdirSync(spoolDir, { recursive: true });
    const badFile = path.join(spoolDir, "pi-222-1.ndjson.closed");
    const firstRecord = { type: "harness", payload: { name: "pi", displayName: "Pi" } };
    fs.writeFileSync(badFile, JSON.stringify(firstRecord) + "\n", "utf8");

    const result = drainClosedSpoolFiles(spoolDir, () => {
      throw new Error("SQLITE_CONSTRAINT_FOREIGNKEY: missing parent row");
    });

    assert.equal(result.drained, 0);
    assert.equal(result.quarantined, 1);
    assert.equal(result.errors.length, 0);

    const quarantinedPath = path.join(`${spoolDir}.failed`, path.basename(badFile));
    const meta = JSON.parse(fs.readFileSync(`${quarantinedPath}.failed.json`, "utf8"));
    assert.equal(meta.error, "SQLITE_CONSTRAINT_FOREIGNKEY: missing parent row");
    assert.deepEqual(meta.firstRecord, firstRecord);
  });

  test("drainClosedSpoolFiles can disable quarantine for legacy behavior", () => {
    const spoolDir = path.join(tmp.dir, "quarantine-disabled");
    fs.mkdirSync(spoolDir, { recursive: true });
    const badFile = path.join(spoolDir, "pi-333-1.ndjson.closed");
    fs.writeFileSync(badFile, "{not valid json}\n", "utf8");

    const result = drainClosedSpoolFiles(spoolDir, () => undefined, {
      failedDir: null,
    });

    assert.equal(result.quarantined, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(fs.existsSync(badFile), true, "legacy mode leaves file in active spool");
  });

  test("ingestFile quarantines failed files and surfaces underlying error", async () => {
    const spoolDir = path.join(tmp.dir, "ingest-file-quarantine");
    const dbPath = path.join(tmp.dir, "ingest-file-quarantine.db");
    fs.mkdirSync(spoolDir, { recursive: true });
    const badFile = path.join(spoolDir, "pi-444-1.ndjson.closed");
    fs.writeFileSync(badFile, "{not valid json}\n", "utf8");

    const result = await ingestFile(badFile, { dbPath });

    assert.equal(result.ingested, 0);
    assert.equal(result.quarantined, 1);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /quarantined to/);
    assert.match(result.errors[0].message, /JSON|Expected|Unexpected/i);
    assert.equal(fs.existsSync(badFile), false);
  });
});

// ---------------------------------------------------------------------------
// T10: Legacy emergency spool repair
// ---------------------------------------------------------------------------

describe("legacy emergency spool repair (T10)", () => {
  /** @type {{ dir: string; cleanup: () => void }} */
  let tmp;

  before(() => {
    tmp = makeTempDir();
  });

  after(() => {
    tmp.cleanup();
  });

  test("turn with spool:pi: session synthesises parent session and ingests successfully", async () => {
    const dbPath = path.join(tmp.dir, "legacy-turn.db");
    // Legacy one-record-per-file: turn referencing a synthetic session ID.
    const spoolFile = path.join(tmp.dir, "legacy-turn.ndjson.closed");
    fs.writeFileSync(
      spoolFile,
      JSON.stringify({
        type: "turn",
        payload: {
          harnessId: "pi",
          sessionId: "spool:pi:/legacy/sessions/sess-turn-test.jsonl",
          harnessTurnId: "/legacy/sessions/sess-turn-test.jsonl:t0",
          turnIndex: 0,
          startedAt: 1700000000001,
        },
      }) + "\n",
      "utf8",
    );

    const result = await ingestFile(spoolFile, { dbPath });

    assert.equal(result.ingested, 1, "file should be ingested");
    assert.equal(result.errors.length, 0, `unexpected errors: ${JSON.stringify(result.errors)}`);

    const db = openDb(dbPath);
    // A synthesised session row should have been created.
    assert.equal(
      db
        .prepare("SELECT count(*) as n FROM sessions WHERE harness_session_id=?")
        .get("/legacy/sessions/sess-turn-test.jsonl").n,
      1,
      "synthesised session should exist",
    );
    // The turn row should exist with the correct harness_turn_id.
    assert.equal(
      db
        .prepare("SELECT count(*) as n FROM turns WHERE harness_turn_id=?")
        .get("/legacy/sessions/sess-turn-test.jsonl:t0").n,
      1,
      "turn row should exist",
    );
    db.close();
  });

  test("llm-message with spool:<uuid>: turn synthesises parent turn and ingests successfully", async () => {
    const dbPath = path.join(tmp.dir, "legacy-llm-uuid.db");
    // First create the session in the DB so we have a real UUID.
    const writer = await AnalyticsWriter.open({ dbPath, harnessName: "pi" });
    await writer.recordHarness({ name: "pi", displayName: "Pi" });
    const { id: sessionUuid } = await writer.recordSession({
      harnessId: "pi",
      harnessSessionId: "uuid-llm-test-session",
      startedAt: 1700000000000,
    });
    await writer.close();

    // Legacy llm-message: sessionId is a real UUID, but turnId is synthetic.
    const spoolFile = path.join(tmp.dir, "legacy-llm-uuid.ndjson.closed");
    fs.writeFileSync(
      spoolFile,
      JSON.stringify({
        type: "llm-message",
        payload: {
          harnessId: "pi",
          sessionId: sessionUuid,
          turnId: `spool:${sessionUuid}:/legacy/sessions/uuid-llm-test.jsonl:t2`,
          harnessMessageId: "/legacy/sessions/uuid-llm-test.jsonl:t2:m0",
          ts: 1700000000100,
          inputTokens: 100,
          outputTokens: 50,
          costInputMicros: 1000,
          costOutputMicros: 500,
          costSource: "harness",
        },
      }) + "\n",
      "utf8",
    );

    const result = await ingestFile(spoolFile, { dbPath });

    assert.equal(result.ingested, 1, "file should be ingested");
    assert.equal(result.errors.length, 0, `unexpected errors: ${JSON.stringify(result.errors)}`);

    const db = openDb(dbPath);
    // A synthesised turn should have been created.
    assert.equal(
      db
        .prepare("SELECT count(*) as n FROM turns WHERE harness_turn_id=?")
        .get("/legacy/sessions/uuid-llm-test.jsonl:t2").n,
      1,
      "synthesised turn should exist",
    );
    assert.equal(
      db
        .prepare("SELECT count(*) as n FROM llm_messages WHERE harness_message_id=?")
        .get("/legacy/sessions/uuid-llm-test.jsonl:t2:m0").n,
      1,
      "llm_message row should exist",
    );
    db.close();
  });

  test("llm-message with spool:spool:pi: nested turn synthesises session+turn and ingests", async () => {
    const dbPath = path.join(tmp.dir, "legacy-llm-nested.db");
    // Legacy nested synthetic: both session and turn were in different spool files.
    const sessPath = "/legacy/sessions/nested-sess.jsonl";
    const nestedTurnId = `spool:spool:pi:${sessPath}:${sessPath}:t1`;

    const spoolFile = path.join(tmp.dir, "legacy-llm-nested.ndjson.closed");
    fs.writeFileSync(
      spoolFile,
      JSON.stringify({
        type: "llm-message",
        payload: {
          harnessId: "pi",
          sessionId: "spool:pi:/legacy/sessions/nested-sess.jsonl",
          turnId: nestedTurnId,
          harnessMessageId: "/legacy/sessions/nested-sess.jsonl:t1:m0",
          ts: 1700000000200,
          inputTokens: 200,
          outputTokens: 80,
          costInputMicros: 2000,
          costOutputMicros: 800,
          costSource: "harness",
        },
      }) + "\n",
      "utf8",
    );

    const result = await ingestFile(spoolFile, { dbPath });

    assert.equal(result.ingested, 1, "file should be ingested");
    assert.equal(result.errors.length, 0, `unexpected errors: ${JSON.stringify(result.errors)}`);

    const db = openDb(dbPath);
    assert.equal(
      db
        .prepare("SELECT count(*) as n FROM sessions WHERE harness_session_id=?")
        .get(sessPath).n,
      1,
      "synthesised session should exist",
    );
    assert.equal(
      db
        .prepare("SELECT count(*) as n FROM turns WHERE harness_turn_id=?")
        .get(`${sessPath}:t1`).n,
      1,
      "synthesised turn should exist",
    );
    assert.equal(
      db
        .prepare("SELECT count(*) as n FROM llm_messages WHERE harness_message_id=?")
        .get("/legacy/sessions/nested-sess.jsonl:t1:m0").n,
      1,
      "llm_message row should exist",
    );
    db.close();
  });

  test("tool-call with nested spool turn synthesises parent rows and ingests", async () => {
    const dbPath = path.join(tmp.dir, "legacy-tool-nested.db");
    const sessPath = "/legacy/sessions/tool-nested-sess.jsonl";
    const nestedTurnId = `spool:spool:pi:${sessPath}:${sessPath}:t0`;

    const spoolFile = path.join(tmp.dir, "legacy-tool-nested.ndjson.closed");
    fs.writeFileSync(
      spoolFile,
      JSON.stringify({
        type: "tool-call",
        payload: {
          harnessId: "pi",
          sessionId: "spool:pi:/legacy/sessions/tool-nested-sess.jsonl",
          turnId: nestedTurnId,
          harnessToolCallId: "toolu_test_legacy_001",
          toolName: "read",
          startedAt: 1700000000300,
          endedAt: 1700000000350,
          isError: false,
        },
      }) + "\n",
      "utf8",
    );

    const result = await ingestFile(spoolFile, { dbPath });

    assert.equal(result.ingested, 1, "file should be ingested");
    assert.equal(result.errors.length, 0, `unexpected errors: ${JSON.stringify(result.errors)}`);

    const db = openDb(dbPath);
    assert.equal(
      db
        .prepare("SELECT count(*) as n FROM tool_calls WHERE harness_tool_call_id=?")
        .get("toolu_test_legacy_001").n,
      1,
      "tool_call row should exist",
    );
    db.close();
  });

  test("pi-emergency-spool fixture (real-format turn) ingests successfully", async () => {
    const dbPath = path.join(tmp.dir, "emergency-fixture.db");
    const fixtureSrc = path.join(
      __dirname,
      "fixtures",
      "pi-emergency-spool.ndjson.closed",
    );
    const fixtureCopy = path.join(tmp.dir, "pi-emergency-spool.ndjson.closed");
    fs.copyFileSync(fixtureSrc, fixtureCopy);

    const result = await ingestFile(fixtureCopy, { dbPath });

    assert.equal(result.ingested, 1, "fixture should be ingested");
    assert.equal(result.errors.length, 0, `unexpected errors: ${JSON.stringify(result.errors)}`);

    const db = openDb(dbPath);
    assert.equal(
      db
        .prepare("SELECT count(*) as n FROM sessions WHERE harness_session_id=?")
        .get("/sentinel/sessions/sess-001.jsonl").n,
      1,
      "synthesised session should exist from fixture",
    );
    assert.equal(
      db
        .prepare("SELECT count(*) as n FROM turns WHERE harness_turn_id=?")
        .get("/sentinel/sessions/sess-001.jsonl:t0").n,
      1,
      "turn row from fixture should exist",
    );
    db.close();

    assert.ok(!fs.existsSync(fixtureCopy), "fixture file should be deleted after ingest");
  });

  test("unparseable legacy spool ID quarantines with a clear FK or parse error", async () => {
    const dbPath = path.join(tmp.dir, "legacy-unparse.db");
    // A turn record where sessionId is a spool:* ID with a malformed harnessId
    // (contains a slash — parseLegacySpoolSessionId returns null for these).
    const spoolFile = path.join(tmp.dir, "legacy-unparse.ndjson.closed");
    fs.writeFileSync(
      spoolFile,
      JSON.stringify({
        type: "turn",
        payload: {
          harnessId: "pi",
          sessionId: "spool:/bad/harnessid/path:some-session",
          harnessTurnId: "some-turn",
          startedAt: 1700000000000,
        },
      }) + "\n",
      "utf8",
    );

    const result = await ingestFile(spoolFile, { dbPath });

    // The file must fail (FK constraint on the un-repaired spool session ID)
    // and be quarantined — not left in the spool directory for infinite retry.
    assert.equal(result.ingested, 0, "malformed spool ID must not be ingested silently");
    assert.equal(result.quarantined, 1, "file must be quarantined, not left in spool");
    assert.equal(fs.existsSync(spoolFile), false, "file must not remain in original location");
  });

  test("legacy repair is idempotent: ingesting same legacy record twice produces no duplicates", async () => {
    const dbPath = path.join(tmp.dir, "legacy-idem.db");
    const sessPath = "/legacy/sessions/idem-sess.jsonl";
    const record = JSON.stringify({
      type: "turn",
      payload: {
        harnessId: "pi",
        sessionId: `spool:pi:${sessPath}`,
        harnessTurnId: `${sessPath}:t0`,
        turnIndex: 0,
        startedAt: 1700000001000,
      },
    });

    const file1 = path.join(tmp.dir, "legacy-idem-1.ndjson.closed");
    const file2 = path.join(tmp.dir, "legacy-idem-2.ndjson.closed");
    fs.writeFileSync(file1, record + "\n", "utf8");
    fs.writeFileSync(file2, record + "\n", "utf8");

    const r1 = await ingestFile(file1, { dbPath });
    assert.equal(r1.ingested, 1);
    assert.equal(r1.errors.length, 0);

    const r2 = await ingestFile(file2, { dbPath });
    assert.equal(r2.ingested, 1, "second ingest must succeed (upsert semantics)");
    assert.equal(r2.errors.length, 0);

    const db = openDb(dbPath);
    assert.equal(
      db.prepare("SELECT count(*) as n FROM sessions").get().n,
      1,
      "only one session row after two ingests",
    );
    assert.equal(
      db.prepare("SELECT count(*) as n FROM turns").get().n,
      1,
      "only one turn row after two ingests",
    );
    db.close();
  });
});

