/**
 * subscription/periods.ts — Monthly billing period boundary computation.
 *
 * Identical in logic to harnesses/claude-code/writer/src/subscription/periods.ts.
 * All calculations are done in the local timezone and return Unix milliseconds.
 *
 * T6 owns this file; the implementation here is copied from the Claude Code
 * writer so the package compiles before T6 runs.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function periodStartDate(year: number, month: number, startDay: number): Date {
  const clamped = Math.min(startDay, daysInMonth(year, month));
  return new Date(year, month - 1, clamped, 0, 0, 0, 0);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the current monthly billing period for a subscription that renews
 * on `startDay` of each month.
 *
 * @param now      - The reference date (typically `new Date()`).
 * @param startDay - Day-of-month when the billing period starts (1–31).
 *                   Values > the month length are clamped to the last day.
 * @returns        - `periodStartMs` and `periodEndMs` as Unix milliseconds.
 */
export function computeMonthlyPeriod(
  now: Date,
  startDay: number,
): { periodStartMs: number; periodEndMs: number } {
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // 1-based
  const todayDay = now.getDate();

  const currentMonthStart = periodStartDate(year, month, startDay);

  let start: Date;
  if (todayDay >= currentMonthStart.getDate()) {
    start = currentMonthStart;
  } else {
    let prevMonth = month - 1;
    let prevYear = year;
    if (prevMonth < 1) {
      prevMonth = 12;
      prevYear -= 1;
    }
    start = periodStartDate(prevYear, prevMonth, startDay);
  }

  const startYear = start.getFullYear();
  const startMonth = start.getMonth() + 1;

  let nextMonth = startMonth + 1;
  let nextYear = startYear;
  if (nextMonth > 12) {
    nextMonth = 1;
    nextYear += 1;
  }

  const nextPeriodStart = periodStartDate(nextYear, nextMonth, startDay);
  const endMs = nextPeriodStart.getTime() - 1;

  return {
    periodStartMs: start.getTime(),
    periodEndMs: endMs,
  };
}
