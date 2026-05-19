/**
 * store/cli/tests/explore-args.test.ts
 *
 * Unit tests for the `explore` command argument helpers in cli/index.ts.
 * Runs from compiled CommonJS output at dist/cli/tests/explore-args.test.js.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDurationMs } from "../index";

// ---------------------------------------------------------------------------
// parseDurationMs
// ---------------------------------------------------------------------------

describe("parseDurationMs", () => {
  // --- valid inputs ---

  it("parses seconds: '30s' → 30 000 ms", () => {
    assert.equal(parseDurationMs("30s"), 30_000);
  });

  it("parses minutes: '5m' → 300 000 ms", () => {
    assert.equal(parseDurationMs("5m"), 300_000);
  });

  it("parses hours: '1h' → 3 600 000 ms", () => {
    assert.equal(parseDurationMs("1h"), 3_600_000);
  });

  it("parses bare zero: '0' → 0 ms", () => {
    // The caller converts 0 → null (no timeout); parseDurationMs itself
    // just returns the raw millisecond value.
    assert.equal(parseDurationMs("0"), 0);
  });

  it("parses bare integer as seconds: '120' → 120 000 ms", () => {
    assert.equal(parseDurationMs("120"), 120_000);
  });

  it("trims whitespace before parsing: ' 5m ' → 300 000 ms", () => {
    assert.equal(parseDurationMs(" 5m "), 300_000);
  });

  it("accepts uppercase unit suffix: '10M' → 600 000 ms", () => {
    assert.equal(parseDurationMs("10M"), 600_000);
  });

  // --- invalid inputs — must throw ---

  it("throws on empty string", () => {
    assert.throws(
      () => parseDurationMs(""),
      (err: unknown) => {
        assert.ok(err instanceof Error, "must be an Error");
        assert.ok(
          err.message.toLowerCase().includes("invalid duration"),
          `unexpected message: ${err.message}`,
        );
        return true;
      },
    );
  });

  it("throws on alphabetic string 'abc'", () => {
    assert.throws(() => parseDurationMs("abc"), Error);
  });

  it("throws on unknown unit suffix '5x'", () => {
    assert.throws(() => parseDurationMs("5x"), Error);
  });

  it("throws on mixed non-unit suffix '1ms'", () => {
    // 'ms' is two chars — does not match single-char unit patterns.
    assert.throws(() => parseDurationMs("1ms"), Error);
  });
});
