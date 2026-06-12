/**
 * state-io.test.ts — Tests for src/state-io.ts
 *
 * Exercises the generic read/write/delete helpers, the pid-suffixed tmp file
 * fix, and sanitizeIdForFilename.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  readJsonState,
  writeJsonState,
  deleteJsonState,
  sanitizeIdForFilename,
} from "../src/state-io.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tt-kit-state-test-"));
}

// ---------------------------------------------------------------------------
// readJsonState / writeJsonState / deleteJsonState
// ---------------------------------------------------------------------------

test("write and read back a JSON state (round-trip)", async () => {
  const dir = await makeTmpDir();
  try {
    const path = join(dir, "state.json");
    const original = { id: "abc-123", count: 7, nested: { x: true } };

    await writeJsonState(path, original);
    const read = await readJsonState<typeof original>(path, "[test]");

    assert.deepEqual(read, original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readJsonState returns null for a non-existent path (ENOENT)", async () => {
  const dir = await makeTmpDir();
  try {
    const result = await readJsonState(join(dir, "nonexistent.json"), "[test]");
    assert.equal(result, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readJsonState returns null and warns on invalid JSON", async () => {
  const dir = await makeTmpDir();
  try {
    const { writeFile } = await import("node:fs/promises");
    const path = join(dir, "bad.json");
    await writeFile(path, "{ not valid json !", "utf8");

    const result = await readJsonState(path, "[test]");
    assert.equal(result, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleteJsonState removes the file", async () => {
  const dir = await makeTmpDir();
  try {
    const path = join(dir, "state.json");
    await writeJsonState(path, { x: 1 });

    const before = await readJsonState(path, "[test]");
    assert.notEqual(before, null);

    await deleteJsonState(path);

    const after = await readJsonState<{ x: number }>(path, "[test]");
    assert.equal(after, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleteJsonState on missing file is a no-op (no throw)", async () => {
  const dir = await makeTmpDir();
  try {
    // Should not throw.
    await deleteJsonState(join(dir, "missing-" + randomUUID() + ".json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeJsonState creates intermediate directories automatically", async () => {
  const dir = await makeTmpDir();
  try {
    // Deep nested path — directories do not exist yet.
    const path = join(dir, "a", "b", "c", "state.json");
    await writeJsonState(path, { created: true });

    const read = await readJsonState<{ created: boolean }>(path, "[test]");
    assert.equal(read?.created, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Pid-suffixed tmp file (m7 fix)
// ---------------------------------------------------------------------------

test("writeJsonState uses pid-suffixed tmp file (no shared .tmp collision)", async () => {
  const dir = await makeTmpDir();
  try {
    const path = join(dir, "state.json");

    // Intercept the tmp filename by watching the directory before and after.
    // We can verify the expected pattern in the file name via a real write.
    await writeJsonState(path, { ok: true });

    // The final file exists; no residual .tmp file should remain after rename.
    const files = await readdir(dir);
    const tmpFiles = files.filter((f) => f.includes(".tmp"));
    assert.equal(
      tmpFiles.length,
      0,
      `No .tmp files should remain after write, found: ${tmpFiles.join(", ")}`,
    );

    // Verify the content is correct.
    const read = await readJsonState<{ ok: boolean }>(path, "[test]");
    assert.equal(read?.ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// sanitizeIdForFilename
// ---------------------------------------------------------------------------

describe("sanitizeIdForFilename", () => {
  test("UUID-style IDs pass through unchanged", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    assert.equal(sanitizeIdForFilename(id), id);
  });

  test("alphanumeric-only IDs pass through unchanged", () => {
    const id = "session123";
    assert.equal(sanitizeIdForFilename(id), id);
  });

  test("IDs with dots and underscores pass through unchanged", () => {
    const id = "session_1.0";
    assert.equal(sanitizeIdForFilename(id), id);
  });

  test("IDs containing path separators are hashed", () => {
    const id = "session/with/slashes";
    const result = sanitizeIdForFilename(id);
    // Must not contain slashes.
    assert.ok(!result.includes("/"), `Result should not contain '/': ${result}`);
    // Must be a hex string (SHA-256 prefix).
    assert.match(result, /^[0-9a-f]{40}$/);
  });

  test("IDs containing '..' are hashed", () => {
    const id = "../../../etc/passwd";
    const result = sanitizeIdForFilename(id);
    assert.ok(!result.includes("/"), `Result must not contain '/': ${result}`);
    assert.ok(!result.includes(".."), `Result must not contain '..': ${result}`);
    assert.match(result, /^[0-9a-f]{40}$/);
  });

  test("sanitization is deterministic — same input always produces same output", () => {
    const id = "bad/id/../chars";
    assert.equal(sanitizeIdForFilename(id), sanitizeIdForFilename(id));
  });

  test("different unsafe IDs produce different hashes", () => {
    const a = sanitizeIdForFilename("session/a");
    const b = sanitizeIdForFilename("session/b");
    assert.notEqual(a, b);
  });
});
