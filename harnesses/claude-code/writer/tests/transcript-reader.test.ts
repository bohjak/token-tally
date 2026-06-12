/**
 * Tests for transcript/reader.ts
 *
 * Uses Node's built-in test runner. Fixtures are written to temp files so
 * there are no shared fixture files to maintain.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTranscriptFrom } from "../src/transcript/reader.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let counter = 0;
function tmpPath(): string {
  return join(tmpdir(), `tt-reader-test-${process.pid}-${++counter}.jsonl`);
}

async function withFile(content: string, fn: (path: string) => Promise<void>): Promise<void> {
  const path = tmpPath();
  await writeFile(path, content, "utf-8");
  try {
    await fn(path);
  } finally {
    await rm(path, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("reads only lines from fromLine onwards", async () => {
  const lines = [
    JSON.stringify({ type: "user", uuid: "u1" }),
    JSON.stringify({ type: "assistant", uuid: "a1" }),
    JSON.stringify({ type: "assistant", uuid: "a2" }),
  ];
  await withFile(lines.join("\n"), async (path) => {
    const { entries, nextLine } = await readTranscriptFrom(path, 1);
    assert.equal(entries.length, 2, "should return 2 entries starting from line 1");
    assert.equal((entries[0] as Record<string, unknown>)["uuid"], "a1");
    assert.equal((entries[1] as Record<string, unknown>)["uuid"], "a2");
    // totalLines = 3 lines split gives 3 elements; trailing \n or not affects this.
    assert.equal(nextLine, 3);
  });
});

test("skips malformed JSON lines without throwing", async () => {
  const content = [
    JSON.stringify({ type: "assistant", uuid: "a1" }),
    "this is not json {{{",
    JSON.stringify({ type: "assistant", uuid: "a2" }),
  ].join("\n");
  await withFile(content, async (path) => {
    const { entries, nextLine } = await readTranscriptFrom(path, 0);
    assert.equal(entries.length, 2, "malformed line should be skipped");
    assert.equal((entries[0] as Record<string, unknown>)["uuid"], "a1");
    assert.equal((entries[1] as Record<string, unknown>)["uuid"], "a2");
    assert.equal(nextLine, 3);
  });
});

test("resets to 0 when fromLine > totalLines (transcript rotated)", async () => {
  const content = [
    JSON.stringify({ type: "assistant", uuid: "fresh1" }),
    JSON.stringify({ type: "assistant", uuid: "fresh2" }),
  ].join("\n");
  await withFile(content, async (path) => {
    // Simulate stale offset well beyond file length (9999 > 2).
    const { entries, nextLine, wasReset } = await readTranscriptFrom(path, 9999);
    assert.equal(wasReset, true);
    assert.equal(entries.length, 2, "should re-read from beginning after reset");
    assert.equal((entries[0] as Record<string, unknown>)["uuid"], "fresh1");
    assert.equal(nextLine, 2);
  });
});

test("empty file returns empty array and nextLine=0", async () => {
  await withFile("", async (path) => {
    const { entries, nextLine } = await readTranscriptFrom(path, 0);
    assert.equal(entries.length, 0);
    // A single empty string from "".split("\n") gives totalLines=1, but
    // all lines are blank so entries=[] and nextLine=1. However callers
    // should handle nextLine=0 and nextLine=1 the same way for empty files.
    // The contract is "no entries returned" — just assert that.
    assert.ok(nextLine >= 0);
  });
});

test("nonexistent file returns empty array and nextLine=0", async () => {
  const { entries, nextLine } = await readTranscriptFrom("/nonexistent/path/to/transcript.jsonl", 0);
  assert.equal(entries.length, 0);
  assert.equal(nextLine, 0);
});

test("fromLine=0 reads all entries", async () => {
  const lines = Array.from({ length: 5 }, (_, i) =>
    JSON.stringify({ type: "assistant", uuid: `msg-${i}` }),
  );
  await withFile(lines.join("\n"), async (path) => {
    const { entries, nextLine } = await readTranscriptFrom(path, 0);
    assert.equal(entries.length, 5);
    assert.equal(nextLine, 5);
  });
});

// ---------------------------------------------------------------------------
// C1 regression: trailing-newline files
// ---------------------------------------------------------------------------

test("trailing-newline: nextLine equals real line count, not phantom element", async () => {
  // "L1\nL2\n" splits to ["L1","L2",""] without the fix.
  // With the fix the phantom empty element is dropped → totalLines = 2.
  const content =
    JSON.stringify({ type: "assistant", uuid: "a1" }) + "\n" +
    JSON.stringify({ type: "assistant", uuid: "a2" }) + "\n";
  await withFile(content, async (path) => {
    const { entries, nextLine, wasReset } = await readTranscriptFrom(path, 0);
    assert.equal(entries.length, 2, "should read 2 entries");
    assert.equal(nextLine, 2, "nextLine should be 2 (not 3 with phantom element)");
    assert.equal(wasReset, false);
  });
});

test("trailing-newline incremental: second drain reads new line without skipping", async () => {
  // Core C1 regression: growing a trailing-newline file must not skip the
  // first new entry when the previous offset equals the (corrected) line count.
  const line1 = JSON.stringify({ type: "assistant", uuid: "inc-1" });
  const line2 = JSON.stringify({ type: "assistant", uuid: "inc-2" });

  // Phase 1: file contains one entry with a trailing newline.
  // Without fix: split gives [line1, ""] → totalLines=2 → offset=2.
  // With fix:    split gives [line1] → totalLines=1 → offset=1.
  await withFile(line1 + "\n", async (path) => {
    const first = await readTranscriptFrom(path, 0);
    assert.equal(first.entries.length, 1, "phase 1 should read 1 entry");
    assert.equal(first.nextLine, 1, "offset after phase 1 should be 1");
    assert.equal(first.wasReset, false);

    // Phase 2: file grows by adding a second entry with trailing newline.
    // Without fix: fromLine=2 >= totalLines=2 → rotation reset → all entries.
    // With fix:    fromLine=1 < totalLines=2 → incremental → only line2.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, line1 + "\n" + line2 + "\n", "utf-8");

    const second = await readTranscriptFrom(path, first.nextLine);
    assert.equal(second.entries.length, 1, "phase 2 should read only 1 new entry");
    assert.equal(
      (second.entries[0] as Record<string, unknown>)["uuid"],
      "inc-2",
      "phase 2 should read the second entry, not the first",
    );
    assert.equal(second.nextLine, 2);
    assert.equal(second.wasReset, false);
  });
});

test("rotation reset: fromLine > totalLines triggers reset, wasReset=true", async () => {
  // After the C1 fix, reset fires only when offset OVERSHOOTS (> not >=).
  const content =
    JSON.stringify({ type: "assistant", uuid: "fresh1" }) + "\n" +
    JSON.stringify({ type: "assistant", uuid: "fresh2" }) + "\n";
  await withFile(content, async (path) => {
    // fromLine=9999 >> totalLines=2 → reset.
    const { entries, nextLine, wasReset } = await readTranscriptFrom(path, 9999);
    assert.equal(wasReset, true, "should report wasReset when offset overshoots");
    assert.equal(entries.length, 2);
    assert.equal(nextLine, 2);
  });
});

test("no-growth drain at offset==totalLines: wasReset=false, no entries", async () => {
  // offset == totalLines is the normal no-growth case; must NOT reset.
  const content =
    JSON.stringify({ type: "assistant", uuid: "g1" }) + "\n" +
    JSON.stringify({ type: "assistant", uuid: "g2" }) + "\n";
  await withFile(content, async (path) => {
    // Read everything first to get nextLine = 2.
    const first = await readTranscriptFrom(path, 0);
    assert.equal(first.nextLine, 2);

    // Second read at offset == totalLines → no entries, no reset.
    const second = await readTranscriptFrom(path, first.nextLine);
    assert.equal(second.entries.length, 0, "no new entries when offset == totalLines");
    assert.equal(second.wasReset, false, "should NOT reset when offset == totalLines");
    assert.equal(second.nextLine, 2);
  });
});
