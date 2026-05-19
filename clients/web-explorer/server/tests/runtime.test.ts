/**
 * server/tests/runtime.test.ts
 *
 * Unit tests for the runtime metadata file helpers in server/runtime.ts.
 * Runs from compiled ESM output at dist/server/tests/runtime.test.js.
 *
 * Each test uses a fresh temporary directory so tests are fully isolated and
 * cannot interfere with a real explorer.json on the developer's machine.
 * XDG_RUNTIME_DIR is temporarily overridden inside each test and always
 * restored in a finally block.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
  runtimeFilePath,
  readRuntime,
  writeRuntime,
  removeRuntime,
} from "../runtime.js";
import type { RuntimeMetadata } from "../runtime.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A complete, valid RuntimeMetadata fixture used across multiple tests.
 */
const SAMPLE_META: RuntimeMetadata = {
  pid: 12345,
  port: 3741,
  host: "127.0.0.1",
  url: "http://127.0.0.1:3741",
  apiBaseUrl: "http://127.0.0.1:3741",
  dbPath: "/tmp/test-events.db",
  startedAt: 1_700_000_000_000,
  lastSeenAt: 1_700_000_001_000,
};

/**
 * Create a unique temporary directory, override XDG_RUNTIME_DIR to point at
 * it, call `fn`, then restore the env var and remove the temp dir.
 *
 * Using a unique dir per call ensures tests cannot share or interfere with
 * each other's runtime files even if Node's test runner ever parallelises them.
 */
function withTempRuntime(fn: () => void): void {
  // Unique dir: timestamp + random suffix avoids collisions when tests reuse
  // the same process (which is the common case with node --test).
  const tmpDir = join(
    tmpdir(),
    `tt-runtime-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  const savedXdg = process.env["XDG_RUNTIME_DIR"];
  process.env["XDG_RUNTIME_DIR"] = tmpDir;

  try {
    fn();
  } finally {
    // Restore the original XDG_RUNTIME_DIR (or remove it if it was unset).
    if (savedXdg === undefined) {
      delete process.env["XDG_RUNTIME_DIR"];
    } else {
      process.env["XDG_RUNTIME_DIR"] = savedXdg;
    }
    // Best-effort cleanup — ignore errors so a test failure doesn't mask
    // the real assertion failure.
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// runtimeFilePath
// ---------------------------------------------------------------------------

describe("runtimeFilePath", () => {
  it("uses XDG_RUNTIME_DIR when set", () => {
    withTempRuntime(() => {
      // XDG_RUNTIME_DIR is now set to tmpDir by withTempRuntime.
      const p = runtimeFilePath();
      const xdg = process.env["XDG_RUNTIME_DIR"]!;
      assert.ok(
        p.startsWith(xdg),
        `path "${p}" should start with XDG_RUNTIME_DIR "${xdg}"`,
      );
      assert.ok(p.includes("token-tally"), `path "${p}" should contain "token-tally"`);
      assert.ok(p.endsWith("explorer.json"), `path "${p}" should end with "explorer.json"`);
    });
  });

  it("falls back to Library/Caches on macOS when XDG_RUNTIME_DIR is unset", () => {
    if (process.platform !== "darwin") {
      // This branch is platform-specific; skip gracefully on non-macOS.
      return;
    }
    const saved = process.env["XDG_RUNTIME_DIR"];
    delete process.env["XDG_RUNTIME_DIR"];
    try {
      const p = runtimeFilePath();
      assert.ok(
        p.includes("Library/Caches"),
        `expected "Library/Caches" in path, got "${p}"`,
      );
      assert.ok(
        p.includes("token-tally"),
        `expected "token-tally" in path, got "${p}"`,
      );
      assert.ok(p.endsWith("explorer.json"), `path should end with "explorer.json"`);
    } finally {
      if (saved !== undefined) {
        process.env["XDG_RUNTIME_DIR"] = saved;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// readRuntime
// ---------------------------------------------------------------------------

describe("readRuntime", () => {
  it("returns null when the runtime file does not exist", () => {
    withTempRuntime(() => {
      // XDG_RUNTIME_DIR points at an empty temp dir (no explorer.json).
      const result = readRuntime();
      assert.equal(result, null);
    });
  });

  it("returns null when the runtime file contains malformed JSON", () => {
    withTempRuntime(() => {
      // Create the directory and write invalid JSON to the expected path.
      const dir = join(process.env["XDG_RUNTIME_DIR"]!, "token-tally");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "explorer.json"), "{ not valid json !!!", "utf-8");

      const result = readRuntime();
      assert.equal(result, null);
    });
  });
});

// ---------------------------------------------------------------------------
// writeRuntime + readRuntime + removeRuntime (round-trip)
// ---------------------------------------------------------------------------

describe("writeRuntime / readRuntime / removeRuntime", () => {
  it("round-trips metadata: write → read → exact match", () => {
    withTempRuntime(() => {
      writeRuntime(SAMPLE_META);
      const result = readRuntime();

      assert.ok(result !== null, "readRuntime should return the written metadata");
      assert.equal(result.pid, SAMPLE_META.pid);
      assert.equal(result.port, SAMPLE_META.port);
      assert.equal(result.host, SAMPLE_META.host);
      assert.equal(result.url, SAMPLE_META.url);
      assert.equal(result.apiBaseUrl, SAMPLE_META.apiBaseUrl);
      assert.equal(result.dbPath, SAMPLE_META.dbPath);
      assert.equal(result.startedAt, SAMPLE_META.startedAt);
      assert.equal(result.lastSeenAt, SAMPLE_META.lastSeenAt);
    });
  });

  it("removeRuntime makes the file unreadable (readRuntime returns null after remove)", () => {
    withTempRuntime(() => {
      writeRuntime(SAMPLE_META);
      assert.ok(readRuntime() !== null, "file should exist before remove");

      removeRuntime();
      assert.equal(readRuntime(), null, "readRuntime should return null after remove");
    });
  });

  it("removeRuntime is idempotent: calling twice does not throw", () => {
    withTempRuntime(() => {
      writeRuntime(SAMPLE_META);
      removeRuntime();
      // Second call on an already-removed file should not throw (ENOENT suppressed).
      assert.doesNotThrow(() => removeRuntime());
    });
  });
});
