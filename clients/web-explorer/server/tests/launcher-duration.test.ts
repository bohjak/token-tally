/**
 * server/tests/launcher-duration.test.ts
 *
 * Unit tests for `parseDuration()` exported from server/launcher.ts.
 * Runs from compiled ESM output at dist/server/tests/launcher-duration.test.js.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDuration } from "../launcher.js";

// ---------------------------------------------------------------------------
// parseDuration
// ---------------------------------------------------------------------------

describe("parseDuration", () => {
  // --- valid inputs ---

  it("parses seconds: '30s' → 30 000 ms", () => {
    assert.equal(parseDuration("30s"), 30_000);
  });

  it("parses minutes: '5m' → 300 000 ms", () => {
    assert.equal(parseDuration("5m"), 300_000);
  });

  it("parses hours: '1h' → 3 600 000 ms", () => {
    assert.equal(parseDuration("1h"), 3_600_000);
  });

  it("parses bare zero: '0' → 0 ms", () => {
    assert.equal(parseDuration("0"), 0);
  });

  it("parses bare integer as seconds: '120' → 120 000 ms", () => {
    assert.equal(parseDuration("120"), 120_000);
  });

  it("accepts uppercase suffix: '10S' → 10 000 ms", () => {
    assert.equal(parseDuration("10S"), 10_000);
  });

  it("trims surrounding whitespace: ' 2m ' → 120 000 ms", () => {
    assert.equal(parseDuration(" 2m "), 120_000);
  });

  // --- invalid inputs — must throw ---

  it("throws on empty string", () => {
    assert.throws(
      () => parseDuration(""),
      (err: unknown) => {
        assert.ok(err instanceof Error, "must throw an Error");
        return true;
      },
    );
  });

  it("throws on purely alphabetic string 'abc'", () => {
    assert.throws(() => parseDuration("abc"), Error);
  });

  it("throws on unrecognised unit suffix '5x'", () => {
    assert.throws(() => parseDuration("5x"), Error);
  });

  it("throws on multi-char suffix '1ms'", () => {
    // 'ms' is two characters; only single-char units (s/m/h) are accepted.
    assert.throws(() => parseDuration("1ms"), Error);
  });
});
