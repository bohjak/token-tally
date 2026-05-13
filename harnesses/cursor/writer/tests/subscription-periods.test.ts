/**
 * subscription-periods.test.ts — Unit tests for subscription/periods.ts
 * and subscription/config.ts.
 *
 * Uses Node's built-in test runner (node:test + node:assert).
 * All Date inputs are fixed to ensure deterministic period-boundary results.
 *
 * Config tests drive the XDG_CONFIG_HOME environment variable to a
 * temporary directory so the real ~/.config/token-tally/config.json is
 * never touched.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { computeMonthlyPeriod } from "../src/subscription/periods.js";
import {
  loadCursorSubscriptionConfig,
  loadCaptureRawFlag,
} from "../src/subscription/config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a local-timezone date "YYYY-MM-DD" into a Date at 00:00:00 local. */
function localDate(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): Date {
  return new Date(year, month - 1, day, hour, minute, second, 0);
}

/** Format a ms timestamp as "YYYY-MM-DD HH:MM:SS.mmm" in local time. */
function fmt(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
    `${String(d.getMilliseconds()).padStart(3, "0")}`
  );
}

// ---------------------------------------------------------------------------
// computeMonthlyPeriod
// ---------------------------------------------------------------------------

describe("computeMonthlyPeriod", () => {
  it("standard case: startDay=1, mid-month → period covers the whole calendar month", () => {
    const now = localDate(2026, 5, 15); // 2026-05-15
    const { periodStartMs, periodEndMs } = computeMonthlyPeriod(now, 1);

    const start = new Date(periodStartMs);
    const end = new Date(periodEndMs);

    assert.equal(
      start.getTime(),
      localDate(2026, 5, 1).getTime(),
      `Expected start 2026-05-01 00:00:00, got ${fmt(periodStartMs)}`,
    );
    // End = 2026-06-01 00:00:00 − 1 ms = 2026-05-31 23:59:59.999
    assert.equal(
      end.getTime(),
      localDate(2026, 6, 1).getTime() - 1,
      `Expected end 2026-05-31 23:59:59.999, got ${fmt(periodEndMs)}`,
    );
  });

  it("startDay=31 in February (non-leap) → clamped to 28; today before clamped day → previous period", () => {
    // today = 2026-02-10; clamped Feb start = Feb 28; 10 < 28 → in previous period.
    // Previous period started Jan 31 (Jan has 31 days).
    const now = localDate(2026, 2, 10);
    const { periodStartMs, periodEndMs } = computeMonthlyPeriod(now, 31);

    const start = new Date(periodStartMs);
    const end = new Date(periodEndMs);

    assert.equal(start.getFullYear(), 2026, "start year");
    assert.equal(start.getMonth() + 1, 1, "start month should be January");
    assert.equal(start.getDate(), 31, "start day = 31 (Jan has 31 days)");

    // Next period starts Feb 28 (clamped(31) in Feb 2026).
    // End = Feb 28 00:00:00 − 1 ms = Feb 27 23:59:59.999
    assert.equal(end.getMonth() + 1, 2, "end month = February");
    assert.equal(end.getDate(), 27, "end day = 27 (Feb 28 00:00 − 1 ms = Feb 27 23:59:59.999)");
    assert.equal(end.getHours(), 23);
    assert.equal(end.getMinutes(), 59);
    assert.equal(end.getSeconds(), 59);
    assert.equal(end.getMilliseconds(), 999);
  });

  it("startDay=31 in April → clamped to 30; today IS the clamped day → period starts today", () => {
    // April has 30 days; today = Apr 30; clamped start = 30; 30 >= 30 → in this period.
    const now = localDate(2026, 4, 30);
    const { periodStartMs, periodEndMs } = computeMonthlyPeriod(now, 31);

    const start = new Date(periodStartMs);
    const end = new Date(periodEndMs);

    assert.equal(start.getMonth() + 1, 4, "start month = April");
    assert.equal(start.getDate(), 30, "start day clamped to 30");

    // Next period starts May 31 (May has 31 days; clamped(31) = 31).
    // End = May 31 00:00:00 − 1 ms = May 30 23:59:59.999
    assert.equal(end.getMonth() + 1, 5, "end month = May");
    assert.equal(end.getDate(), 30, "end day = 30");
    assert.equal(end.getMilliseconds(), 999);
  });

  it("today is the start day → period starts exactly today at midnight", () => {
    const now = localDate(2026, 5, 15); // startDay = 15
    const { periodStartMs } = computeMonthlyPeriod(now, 15);

    const start = new Date(periodStartMs);
    assert.equal(start.getFullYear(), 2026);
    assert.equal(start.getMonth() + 1, 5);
    assert.equal(start.getDate(), 15);
    assert.equal(start.getHours(), 0);
    assert.equal(start.getMinutes(), 0);
    assert.equal(start.getSeconds(), 0);
    assert.equal(start.getMilliseconds(), 0);
  });

  it("today < start day → period started last month", () => {
    // today = 2026-05-10, startDay = 15 → period started 2026-04-15
    const now = localDate(2026, 5, 10);
    const { periodStartMs, periodEndMs } = computeMonthlyPeriod(now, 15);

    const start = new Date(periodStartMs);
    const end = new Date(periodEndMs);

    assert.equal(start.getMonth() + 1, 4, "period started in April");
    assert.equal(start.getDate(), 15);

    // End = May 15 00:00:00 − 1 ms = May 14 23:59:59.999
    assert.equal(end.getMonth() + 1, 5, "period ends in May");
    assert.equal(end.getDate(), 14);
    assert.equal(end.getHours(), 23);
    assert.equal(end.getMinutes(), 59);
    assert.equal(end.getSeconds(), 59);
    assert.equal(end.getMilliseconds(), 999);
  });

  it("January (startDay=1): period ends Dec 31 of the same year", () => {
    const now = localDate(2026, 1, 5);
    const { periodStartMs, periodEndMs } = computeMonthlyPeriod(now, 1);

    const start = new Date(periodStartMs);
    const end = new Date(periodEndMs);

    assert.equal(start.getFullYear(), 2026);
    assert.equal(start.getMonth() + 1, 1);
    assert.equal(start.getDate(), 1);

    // End = Feb 1 00:00:00 − 1 ms = Jan 31 23:59:59.999
    assert.equal(end.getMonth() + 1, 1, "end should still be in January");
    assert.equal(end.getDate(), 31);
    assert.equal(end.getMilliseconds(), 999);
  });

  it("December → year rollover: period end is Dec 31, next period Jan 1 next year", () => {
    const now = localDate(2026, 12, 20); // Dec 20, startDay=1
    const { periodStartMs, periodEndMs } = computeMonthlyPeriod(now, 1);

    const start = new Date(periodStartMs);
    const end = new Date(periodEndMs);

    assert.equal(start.getFullYear(), 2026);
    assert.equal(start.getMonth() + 1, 12);
    assert.equal(start.getDate(), 1);

    // End = Jan 1 2027 00:00:00 − 1 ms = Dec 31 2026 23:59:59.999
    assert.equal(end.getFullYear(), 2026);
    assert.equal(end.getMonth() + 1, 12);
    assert.equal(end.getDate(), 31);
    assert.equal(end.getMilliseconds(), 999);
  });

  it("today = Feb 28, startDay=31 → clamped to 28; today >= 28 → period starts Feb 28", () => {
    const now = localDate(2026, 2, 28); // non-leap year
    const { periodStartMs, periodEndMs } = computeMonthlyPeriod(now, 31);

    const start = new Date(periodStartMs);
    const end = new Date(periodEndMs);

    assert.equal(start.getMonth() + 1, 2, "start month = February");
    assert.equal(start.getDate(), 28, "start day = 28 (clamped from 31)");

    // Next month = March; clamped(31 in March) = 31.
    // End = Mar 31 00:00:00 − 1 ms = Mar 30 23:59:59.999
    assert.equal(end.getMonth() + 1, 3, "end month = March");
    assert.equal(end.getDate(), 30, "end day = 30");
    assert.equal(end.getMilliseconds(), 999);
  });

  it("period start + period end are non-overlapping (end + 1 ms = next start)", () => {
    const now = localDate(2026, 3, 20);
    const { periodStartMs, periodEndMs } = computeMonthlyPeriod(now, 1);

    // Compute next period start using the same function at period end + 1 ms
    const nextNow = new Date(periodEndMs + 1);
    const { periodStartMs: nextStart } = computeMonthlyPeriod(nextNow, 1);

    assert.equal(
      periodEndMs + 1,
      nextStart,
      "end + 1 ms should equal the start of the next period",
    );
  });
});

// ---------------------------------------------------------------------------
// Config loading tests — use an isolated temp XDG_CONFIG_HOME
// ---------------------------------------------------------------------------

describe("loadCursorSubscriptionConfig", () => {
  let tmpDir: string;
  let configDir: string;
  let savedXdg: string | undefined;

  before(() => {
    tmpDir = join(tmpdir(), `tt-cursor-config-test-${process.pid}`);
    configDir = join(tmpDir, "token-tally");
    mkdirSync(configDir, { recursive: true });
    savedXdg = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = tmpDir;
  });

  after(() => {
    if (savedXdg === undefined) {
      delete process.env["XDG_CONFIG_HOME"];
    } else {
      process.env["XDG_CONFIG_HOME"] = savedXdg;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Remove config.json before each test so tests start clean.
    try {
      rmSync(join(configDir, "config.json"), { force: true });
    } catch {
      // ignore
    }
  });

  it("returns null when config.json is absent", async () => {
    const result = await loadCursorSubscriptionConfig();
    assert.equal(result, null);
  });

  it("returns null when harnesses.cursor block is absent", async () => {
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ harnesses: { "claude-code": { subscription: "claude-pro" } } }),
    );
    const result = await loadCursorSubscriptionConfig();
    assert.equal(result, null);
  });

  it("returns null when subscription key is absent from cursor block", async () => {
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ harnesses: { cursor: { captureRaw: true } } }),
    );
    const result = await loadCursorSubscriptionConfig();
    assert.equal(result, null);
  });

  it("returns null when config.json contains malformed JSON", async () => {
    writeFileSync(join(configDir, "config.json"), "{ not: valid }");
    const result = await loadCursorSubscriptionConfig();
    assert.equal(result, null);
  });

  it("parses a full cursor-pro config correctly", async () => {
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        harnesses: {
          cursor: {
            subscription: "cursor-pro",
            subscriptionFixedCostUSD: 20,
            subscriptionStartDay: 1,
            captureRaw: false,
          },
        },
      }),
    );
    const result = await loadCursorSubscriptionConfig();

    assert.ok(result !== null, "expected a non-null result");
    assert.equal(result.plan, "cursor-pro");
    assert.equal(result.fixedCostUSD, 20);
    assert.equal(result.startDay, 1);
    assert.equal(result.captureRaw, false);
  });

  it("defaults fixedCostUSD to 0 when omitted", async () => {
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        harnesses: { cursor: { subscription: "cursor-pro" } },
      }),
    );
    const result = await loadCursorSubscriptionConfig();

    assert.ok(result !== null);
    assert.equal(result.fixedCostUSD, 0);
  });

  it("defaults startDay to 1 when omitted", async () => {
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        harnesses: { cursor: { subscription: "cursor-pro" } },
      }),
    );
    const result = await loadCursorSubscriptionConfig();

    assert.ok(result !== null);
    assert.equal(result.startDay, 1);
  });

  it("defaults startDay to 1 when value is out of range (0)", async () => {
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        harnesses: {
          cursor: { subscription: "cursor-pro", subscriptionStartDay: 0 },
        },
      }),
    );
    const result = await loadCursorSubscriptionConfig();
    assert.ok(result !== null);
    assert.equal(result.startDay, 1);
  });

  it("defaults startDay to 1 when value is out of range (32)", async () => {
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        harnesses: {
          cursor: { subscription: "cursor-pro", subscriptionStartDay: 32 },
        },
      }),
    );
    const result = await loadCursorSubscriptionConfig();
    assert.ok(result !== null);
    assert.equal(result.startDay, 1);
  });

  it("floors a fractional startDay (e.g. 15.9 → 15)", async () => {
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        harnesses: {
          cursor: {
            subscription: "cursor-pro",
            subscriptionStartDay: 15.9,
          },
        },
      }),
    );
    const result = await loadCursorSubscriptionConfig();
    assert.ok(result !== null);
    assert.equal(result.startDay, 15);
  });

  it("captureRaw defaults to false when not set", async () => {
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        harnesses: { cursor: { subscription: "cursor-pro" } },
      }),
    );
    const result = await loadCursorSubscriptionConfig();
    assert.ok(result !== null);
    assert.equal(result.captureRaw, false);
  });

  it("captureRaw is true when set to true", async () => {
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        harnesses: { cursor: { subscription: "cursor-pro", captureRaw: true } },
      }),
    );
    const result = await loadCursorSubscriptionConfig();
    assert.ok(result !== null);
    assert.equal(result.captureRaw, true);
  });

  it("ignores other harness blocks (e.g. claude-code)", async () => {
    // Both harnesses configured — Cursor should read only its own block.
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        harnesses: {
          "claude-code": {
            subscription: "claude-pro",
            subscriptionFixedCostUSD: 20,
            subscriptionStartDay: 5,
          },
          cursor: {
            subscription: "cursor-pro",
            subscriptionFixedCostUSD: 30,
            subscriptionStartDay: 10,
          },
        },
      }),
    );
    const result = await loadCursorSubscriptionConfig();

    assert.ok(result !== null);
    assert.equal(result.plan, "cursor-pro");
    assert.equal(result.fixedCostUSD, 30);
    assert.equal(result.startDay, 10);
  });
});

// ---------------------------------------------------------------------------
// loadCaptureRawFlag
// ---------------------------------------------------------------------------

describe("loadCaptureRawFlag", () => {
  let tmpDir: string;
  let configDir: string;
  let savedXdg: string | undefined;

  before(() => {
    tmpDir = join(tmpdir(), `tt-cursor-capture-raw-test-${process.pid}`);
    configDir = join(tmpDir, "token-tally");
    mkdirSync(configDir, { recursive: true });
    savedXdg = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = tmpDir;
  });

  after(() => {
    if (savedXdg === undefined) {
      delete process.env["XDG_CONFIG_HOME"];
    } else {
      process.env["XDG_CONFIG_HOME"] = savedXdg;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    try {
      rmSync(join(configDir, "config.json"), { force: true });
    } catch {
      // ignore
    }
  });

  it("returns false when config.json is absent", async () => {
    assert.equal(await loadCaptureRawFlag(), false);
  });

  it("returns false when captureRaw is absent", async () => {
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ harnesses: { cursor: { subscription: "cursor-pro" } } }),
    );
    assert.equal(await loadCaptureRawFlag(), false);
  });

  it("returns false when captureRaw is false", async () => {
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        harnesses: { cursor: { captureRaw: false } },
      }),
    );
    assert.equal(await loadCaptureRawFlag(), false);
  });

  it("returns true when captureRaw is true", async () => {
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        harnesses: { cursor: { captureRaw: true } },
      }),
    );
    assert.equal(await loadCaptureRawFlag(), true);
  });

  it("returns false for malformed JSON", async () => {
    writeFileSync(join(configDir, "config.json"), "{ bad json }");
    assert.equal(await loadCaptureRawFlag(), false);
  });

  it("works without a subscription plan present — captureRaw is independent", async () => {
    // captureRaw can be set even when no subscription is configured.
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ harnesses: { cursor: { captureRaw: true } } }),
    );
    assert.equal(await loadCaptureRawFlag(), true);
  });

  it("returns false when harnesses.cursor block is absent", async () => {
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ harnesses: { "claude-code": { captureRaw: true } } }),
    );
    assert.equal(await loadCaptureRawFlag(), false);
  });
});
