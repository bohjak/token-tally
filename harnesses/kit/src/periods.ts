/**
 * periods.ts — Monthly billing period boundary computation.
 *
 * Replaces two verbatim copies in harnesses/claude-code and harnesses/cursor.
 *
 * All calculations use the local timezone (Date's local methods) and return
 * Unix milliseconds. The `startDay` is clamped to the last day of the month
 * when shorter (e.g. startDay=31 in February → 28/29).
 */

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Return the number of days in a given month (1-based month, full year). */
function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of `month`.
  return new Date(year, month, 0).getDate();
}

/**
 * Clamp `startDay` to the actual last day of the month and return a Date
 * at 00:00:00 local time for that day.
 */
function periodStartDate(year: number, month: number, startDay: number): Date {
  const clamped = Math.min(startDay, daysInMonth(year, month));
  return new Date(year, month - 1, clamped, 0, 0, 0, 0);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the current monthly billing period boundaries for a subscription
 * that renews on `startDay` of each month.
 *
 * @param now      - The reference date (typically `new Date()`).
 * @param startDay - Day-of-month when the billing period starts (1–31).
 *                   Values > the month length are clamped to the last day.
 * @returns        - `periodStartMs` and `periodEndMs` as Unix milliseconds.
 *                   `periodEndMs` is one millisecond before the next period
 *                   starts, so two consecutive periods are non-overlapping.
 *
 * @example
 * // Subscription renews on the 15th; today is 2026-05-20.
 * computeMonthlyPeriod(new Date("2026-05-20"), 15)
 * // → { periodStartMs: 2026-05-15T00:00:00 local, periodEndMs: 2026-06-14T23:59:59.999 local }
 */
export function computeMonthlyPeriod(
  now: Date,
  startDay: number,
): { periodStartMs: number; periodEndMs: number } {
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // 1-based
  const todayDay = now.getDate();

  // Candidate: start of the period in the current month (clamped to month length).
  const currentMonthStart = periodStartDate(year, month, startDay);

  let start: Date;
  if (todayDay >= currentMonthStart.getDate()) {
    // Today is on or after the start day → we're in this month's period.
    start = currentMonthStart;
  } else {
    // Today is before the start day → we're still in last month's period.
    let prevMonth = month - 1;
    let prevYear = year;
    if (prevMonth < 1) {
      prevMonth = 12;
      prevYear -= 1;
    }
    start = periodStartDate(prevYear, prevMonth, startDay);
  }

  // End = same clamped day next month at 00:00:00, minus 1 ms.
  const startMonth = start.getMonth() + 1; // 1-based
  let nextMonth = startMonth + 1;
  let nextYear = start.getFullYear();
  if (nextMonth > 12) {
    nextMonth = 1;
    nextYear += 1;
  }

  const nextPeriodStart = periodStartDate(nextYear, nextMonth, startDay);
  return {
    periodStartMs: start.getTime(),
    periodEndMs: nextPeriodStart.getTime() - 1,
  };
}
