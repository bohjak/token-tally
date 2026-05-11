/**
 * subscription-periods.test.ts — Unit tests for computeMonthlyPeriod.
 *
 * Uses Node's built-in test runner (node:test + node:assert).
 * All Date inputs are fixed to ensure deterministic results.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeMonthlyPeriod } from "../src/subscription/periods.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a local-timezone date string "YYYY-MM-DD" into a Date at 00:00:00 local. */
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

/** Format a Date as "YYYY-MM-DD HH:MM:SS" in local time for assertion messages. */
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
    // now = 2026-05-15 (mid-May)
    const now = localDate(2026, 5, 15);
    const { periodStartMs, periodEndMs } = computeMonthlyPeriod(now, 1);

    const start = new Date(periodStartMs);
    const end = new Date(periodEndMs);

    assert.equal(
      start.getTime(),
      localDate(2026, 5, 1).getTime(),
      `Expected start 2026-05-01 00:00:00, got ${fmt(periodStartMs)}`,
    );
    // End should be 2026-06-01 00:00:00 minus 1ms = 2026-05-31 23:59:59.999
    assert.equal(
      end.getTime(),
      localDate(2026, 6, 1).getTime() - 1,
      `Expected end 2026-05-31 23:59:59.999, got ${fmt(periodEndMs)}`,
    );
  });

  it("startDay=31 in February (non-leap year) → clamped to 28", () => {
    // now = 2026-02-10 (10th Feb; non-leap year: Feb has 28 days).
    // Clamped start for Feb = 28. Today (10) < 28, so we're still in the
    // *previous* month's period: Jan 31 (Jan has 31 days) → Feb 28 23:59:59.999.
    const now = localDate(2026, 2, 10);
    const { periodStartMs, periodEndMs } = computeMonthlyPeriod(now, 31);

    const start = new Date(periodStartMs);
    const end = new Date(periodEndMs);

    // Period started on January 31 (Jan has 31 days; clamped(31)=31).
    assert.equal(start.getFullYear(), 2026, `start year`);
    assert.equal(
      start.getMonth() + 1,
      1,
      `Expected period to start in January (today < clamped Feb start), got month ${start.getMonth() + 1}`,
    );
    assert.equal(
      start.getDate(),
      31,
      `Expected start day 31 (Jan 31), got ${start.getDate()} — ${fmt(periodStartMs)}`,
    );

    // Period ends on Feb 28 23:59:59.999 (next period starts Feb 28, which is
    // clamped(31) in February; Feb 28 00:00:00 − 1ms = Feb 27 23:59:59.999 …
    // wait: nextPeriodStart = periodStartDate(2026, 2, 31) = Feb 28;
    // end = Feb 28 00:00:00 − 1ms = Feb 27 23:59:59.999).
    //
    // Actually: start=Jan 31, nextMonth=Feb, clamped(31 in Feb 2026)=28.
    // nextPeriodStart = 2026-02-28 00:00:00; endMs = that − 1ms = 2026-02-27 23:59:59.999.
    assert.equal(
      end.getMonth() + 1,
      2,
      `Expected end month February, got ${end.getMonth() + 1}`,
    );
    assert.equal(
      end.getDate(),
      27,
      `Expected end date 27 (Feb 28 00:00 − 1ms = Feb 27 23:59:59.999), got ${end.getDate()} — ${fmt(periodEndMs)}`,
    );
    assert.equal(end.getHours(), 23);
    assert.equal(end.getMinutes(), 59);
    assert.equal(end.getSeconds(), 59);
    assert.equal(end.getMilliseconds(), 999);
  });

  it("startDay=31 in April → clamped to 30", () => {
    // now = 2026-04-30 (today IS the 30th; clamped start for April is 30)
    const now = localDate(2026, 4, 30);
    const { periodStartMs, periodEndMs } = computeMonthlyPeriod(now, 31);

    const start = new Date(periodStartMs);
    const end = new Date(periodEndMs);

    // Clamped start for April (30 days) = 30. today (30) >= 30 → in this month's period.
    assert.equal(start.getFullYear(), 2026);
    assert.equal(start.getMonth() + 1, 4, `start month should be April`);
    assert.equal(start.getDate(), 30, `start day clamped to 30`);

    // Next period starts May 31 (May has 31 days; clamped(31)=31).
    // End = May 31 00:00:00 − 1ms = May 30 23:59:59.999.
    assert.equal(end.getMonth() + 1, 5, `end month should be May`);
    assert.equal(end.getDate(), 30, `end day should be 30 (May 31 00:00 − 1ms = May 30 23:59)`);
    assert.equal(end.getMilliseconds(), 999);
  });

  it("year rollover: startDay=1, now=Jan 5 → period is Jan 1–Jan 31 (end)", () => {
    const now = localDate(2026, 1, 5); // Jan 5
    const { periodStartMs, periodEndMs } = computeMonthlyPeriod(now, 1);

    const start = new Date(periodStartMs);
    const end = new Date(periodEndMs);

    assert.equal(start.getFullYear(), 2026);
    assert.equal(start.getMonth() + 1, 1);
    assert.equal(start.getDate(), 1);

    // End = Feb 1 00:00:00 - 1ms = Jan 31 23:59:59.999
    assert.equal(end.getFullYear(), 2026);
    assert.equal(end.getMonth() + 1, 1, `end should still be in January`);
    assert.equal(end.getDate(), 31);
    assert.equal(end.getMilliseconds(), 999);
  });

  it("today IS the start day → period starts today", () => {
    // now = 2026-05-15, startDay = 15
    const now = localDate(2026, 5, 15);
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

  it("today < start day → period starts last month", () => {
    // now = 2026-05-10, startDay = 15 → today (10) < 15 → period started Apr 15
    const now = localDate(2026, 5, 10);
    const { periodStartMs, periodEndMs } = computeMonthlyPeriod(now, 15);

    const start = new Date(periodStartMs);
    const end = new Date(periodEndMs);

    assert.equal(start.getFullYear(), 2026);
    assert.equal(start.getMonth() + 1, 4, `period should start in April`);
    assert.equal(start.getDate(), 15);

    // End = May 15 00:00:00 - 1ms = May 14 23:59:59.999
    assert.equal(end.getMonth() + 1, 5, `period should end in May`);
    assert.equal(end.getDate(), 14);
    assert.equal(end.getHours(), 23);
    assert.equal(end.getMinutes(), 59);
    assert.equal(end.getSeconds(), 59);
    assert.equal(end.getMilliseconds(), 999);
  });

  it("December → January year rollover for period end", () => {
    // now = 2026-12-20, startDay = 1 → period is Dec 1–Dec 31 end
    const now = localDate(2026, 12, 20);
    const { periodStartMs, periodEndMs } = computeMonthlyPeriod(now, 1);

    const start = new Date(periodStartMs);
    const end = new Date(periodEndMs);

    assert.equal(start.getFullYear(), 2026);
    assert.equal(start.getMonth() + 1, 12);
    assert.equal(start.getDate(), 1);

    // End = Jan 1 2027 00:00:00 - 1ms = Dec 31 2026 23:59:59.999
    assert.equal(end.getFullYear(), 2026);
    assert.equal(end.getMonth() + 1, 12);
    assert.equal(end.getDate(), 31);
    assert.equal(end.getMilliseconds(), 999);
  });
});

// ---------------------------------------------------------------------------
// Re-run the Feb-clamp test with clearer expected values
// ---------------------------------------------------------------------------

describe("computeMonthlyPeriod — Feb 28 clamped start, today after clamped day", () => {
  it("today=Feb 28, startDay=31 → today >= clamped(28), period starts Feb 28", () => {
    const now = localDate(2026, 2, 28); // today IS the clamped start
    const { periodStartMs, periodEndMs } = computeMonthlyPeriod(now, 31);

    const start = new Date(periodStartMs);
    const end = new Date(periodEndMs);

    assert.equal(start.getMonth() + 1, 2, "start month = February");
    assert.equal(start.getDate(), 28, "start day = 28 (clamped from 31)");

    // Next month is March; Mar has 31 days → clamped(31) = 31
    // End = Mar 31 00:00:00 - 1ms = Mar 30 23:59:59.999
    assert.equal(end.getMonth() + 1, 3, "end month = March");
    assert.equal(end.getDate(), 30, "end day = 30");
    assert.equal(end.getMilliseconds(), 999);
  });
});
