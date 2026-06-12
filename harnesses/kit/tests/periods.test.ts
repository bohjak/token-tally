/**
 * periods.test.ts — Unit tests for computeMonthlyPeriod.
 *
 * Moved from harnesses/claude-code/writer/tests/subscription-periods.test.ts
 * (periods portion). All Date inputs are fixed for deterministic results.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeMonthlyPeriod } from "../src/periods.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function fmt(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computeMonthlyPeriod", () => {
  it("standard case: startDay=1, mid-month → period covers the whole month", () => {
    const now = localDate(2026, 5, 15);
    const { periodStartMs, periodEndMs } = computeMonthlyPeriod(now, 1);
    const start = new Date(periodStartMs);
    const end = new Date(periodEndMs);

    assert.equal(start.getTime(), localDate(2026, 5, 1).getTime(), fmt(periodStartMs));
    assert.equal(end.getTime(), localDate(2026, 6, 1).getTime() - 1, fmt(periodEndMs));
  });

  it("startDay=31 in February (non-leap year) → clamped to 28", () => {
    const now = localDate(2026, 2, 10);
    const { periodStartMs } = computeMonthlyPeriod(now, 31);
    const start = new Date(periodStartMs);

    // today (10) < clamped Feb 28 → period started Jan 31
    assert.equal(start.getMonth() + 1, 1, "start month = January");
    assert.equal(start.getDate(), 31);
  });

  it("startDay=31 in April → clamped to 30", () => {
    const now = localDate(2026, 4, 30);
    const { periodStartMs, periodEndMs } = computeMonthlyPeriod(now, 31);
    const start = new Date(periodStartMs);
    const end = new Date(periodEndMs);

    assert.equal(start.getMonth() + 1, 4, "start month = April");
    assert.equal(start.getDate(), 30, "clamped to 30");
    assert.equal(end.getMonth() + 1, 5, "end month = May");
    assert.equal(end.getDate(), 30);
    assert.equal(end.getMilliseconds(), 999);
  });

  it("year rollover: startDay=1, now=Jan 5 → period is Jan 1–Jan 31 (end)", () => {
    const now = localDate(2026, 1, 5);
    const { periodStartMs, periodEndMs } = computeMonthlyPeriod(now, 1);
    const start = new Date(periodStartMs);
    const end = new Date(periodEndMs);

    assert.equal(start.getDate(), 1);
    assert.equal(start.getMonth() + 1, 1);
    assert.equal(end.getDate(), 31);
    assert.equal(end.getMonth() + 1, 1);
    assert.equal(end.getMilliseconds(), 999);
  });

  it("today IS the start day → period starts today", () => {
    const now = localDate(2026, 5, 15);
    const { periodStartMs } = computeMonthlyPeriod(now, 15);
    const start = new Date(periodStartMs);

    assert.equal(start.getDate(), 15);
    assert.equal(start.getHours(), 0);
    assert.equal(start.getMinutes(), 0);
    assert.equal(start.getSeconds(), 0);
    assert.equal(start.getMilliseconds(), 0);
  });

  it("today < start day → period starts last month", () => {
    const now = localDate(2026, 5, 10);
    const { periodStartMs, periodEndMs } = computeMonthlyPeriod(now, 15);
    const start = new Date(periodStartMs);
    const end = new Date(periodEndMs);

    assert.equal(start.getMonth() + 1, 4, "start in April");
    assert.equal(start.getDate(), 15);
    assert.equal(end.getMonth() + 1, 5, "end in May");
    assert.equal(end.getDate(), 14);
    assert.equal(end.getMilliseconds(), 999);
  });

  it("December → January year rollover for period end", () => {
    const now = localDate(2026, 12, 20);
    const { periodStartMs, periodEndMs } = computeMonthlyPeriod(now, 1);
    const start = new Date(periodStartMs);
    const end = new Date(periodEndMs);

    assert.equal(start.getMonth() + 1, 12);
    assert.equal(end.getFullYear(), 2026);
    assert.equal(end.getMonth() + 1, 12);
    assert.equal(end.getDate(), 31);
  });
});

describe("computeMonthlyPeriod — Feb 28 clamped start, today after clamped day", () => {
  it("today=Feb 28, startDay=31 → today >= clamped(28), period starts Feb 28", () => {
    const now = localDate(2026, 2, 28);
    const { periodStartMs, periodEndMs } = computeMonthlyPeriod(now, 31);
    const start = new Date(periodStartMs);
    const end = new Date(periodEndMs);

    assert.equal(start.getMonth() + 1, 2, "start = February");
    assert.equal(start.getDate(), 28);
    assert.equal(end.getMonth() + 1, 3, "end = March");
    assert.equal(end.getDate(), 30);
    assert.equal(end.getMilliseconds(), 999);
  });
});
