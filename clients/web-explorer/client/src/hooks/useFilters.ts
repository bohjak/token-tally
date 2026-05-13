import { useSearchParams } from "react-router";
import { useMemo, useCallback, useRef } from "react";
import type { Filters } from "../api.ts";

export type Preset = "1d" | "today" | "7d" | "30d" | "90d" | "all";
export type CompareMode = "off" | "previous-period" | "previous-week" | "previous-month" | "custom";

export type CompareRange = {
  from: number;
  to: number;
  label: string;
};

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function endOfToday(): number {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

function isCalendarDayRange(from: number, to: number): boolean {
  const start = new Date(from);
  const end = new Date(to);
  return start.getHours() === 0 && start.getMinutes() === 0 &&
    start.getSeconds() === 0 && start.getMilliseconds() === 0 &&
    end.getHours() === 23 && end.getMinutes() === 59 &&
    end.getSeconds() === 59 && end.getMilliseconds() === 999;
}

function canShiftToNextPeriod(from: number, to: number): boolean {
  if (from === 0) return false;
  const length = Math.max(1, to - from);
  const nextFrom = from + length;
  const nextTo = to + length;
  const now = Date.now();
  if (nextTo <= now) return true;
  return isCalendarDayRange(from, to) && nextFrom <= now;
}

export function presetToRange(preset: Preset): { from: number; to: number } {
  const now = Date.now();
  switch (preset) {
    case "1d":
    case "today": return { from: startOfToday(), to: endOfToday() };
    case "7d":    return { from: now - 7  * 86_400_000, to: now };
    case "30d":   return { from: now - 30 * 86_400_000, to: now };
    case "90d":   return { from: now - 90 * 86_400_000, to: now };
    case "all":   return { from: 0, to: now };
  }
}

function shiftMonths(ms: number, months: number): number {
  const date = new Date(ms);
  date.setMonth(date.getMonth() + months);
  return date.getTime();
}

function resolveCompareRange(
  mode: CompareMode,
  from: number,
  to: number,
  compareFrom: number | null,
  compareTo: number | null
): CompareRange | null {
  if (mode === "off" || from === 0 || to <= from) return null;

  if (mode === "custom") {
    if (compareFrom == null || compareTo == null || compareTo <= compareFrom) return null;
    return { from: compareFrom, to: compareTo, label: "custom range" };
  }

  if (mode === "previous-period") {
    const length = to - from;
    return { from: from - length, to: from - 1, label: "previous period" };
  }

  if (mode === "previous-week") {
    return { from: from - 7 * 86_400_000, to: to - 7 * 86_400_000, label: "same period last week" };
  }

  return { from: shiftMonths(from, -1), to: shiftMonths(to, -1), label: "same period last month" };
}

export type UseFiltersResult = {
  filters: Filters;
  setPreset: (preset: Preset) => void;
  setCustomRange: (from: Date, to: Date) => void;
  shiftPeriod: (direction: -1 | 1) => void;
  canShiftNext: boolean;
  setHarnesses: (names: string[]) => void;
  setModel: (model: string) => void;
  setRepo: (repo: string) => void;
  setCompareMode: (mode: CompareMode) => void;
  setCustomCompareRange: (from: Date, to: Date) => void;
  resetFilters: () => void;
  activePreset: Preset | null;
  compareMode: CompareMode;
  compareRange: CompareRange | null;
  defaultPreset: Preset;
};

export function useFilters(defaultPreset: Preset = "30d"): UseFiltersResult {
  const [params, setParams] = useSearchParams();

  const defaultRangeRef = useRef(presetToRange(defaultPreset));
  const urlPreset = params.get("preset") as Preset | null;
  const hasExplicitRange = params.has("from") || params.has("to");
  const defaultRange = useMemo(
    () => hasExplicitRange ? defaultRangeRef.current : presetToRange(urlPreset ?? defaultPreset),
    [defaultPreset, hasExplicitRange, urlPreset]
  );
  const from = parseInt(params.get("from") ?? String(defaultRange.from)) || 0;
  const to   = parseInt(params.get("to")   ?? String(defaultRange.to)) || defaultRange.to;
  const harnesses = params.getAll("harness").filter(Boolean);
  const model = params.get("model") ?? undefined;
  const repo  = params.get("repo")  ?? undefined;
  const compareMode = (params.get("compare") as CompareMode | null) ?? "off";
  const compareFrom = params.get("compareFrom") ? parseInt(params.get("compareFrom")!, 10) : null;
  const compareTo = params.get("compareTo") ? parseInt(params.get("compareTo")!, 10) : null;

  const filters: Filters = useMemo(
    () => ({ from, to, harnesses: harnesses.length ? harnesses : undefined, model, repo }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [from, to, harnesses.join(","), model, repo]
  );

  const setPreset = useCallback(
    (preset: Preset) => {
      const { from: f, to: t } = presetToRange(preset);
      setParams((p) => {
        const next = new URLSearchParams(p);
        next.set("from", String(f));
        next.set("to", String(t));
        next.set("preset", preset);
        return next;
      });
    },
    [setParams]
  );

  const setCustomRange = useCallback(
    (fromDate: Date, toDate: Date) => {
      setParams((p) => {
        const next = new URLSearchParams(p);
        next.set("from", String(fromDate.getTime()));
        next.set("to", String(toDate.getTime()));
        next.delete("preset");
        return next;
      });
    },
    [setParams]
  );

  const shiftPeriod = useCallback(
    (direction: -1 | 1) => {
      if (from === 0) return;
      const length = Math.max(1, to - from);
      const nextFrom = from + direction * length;
      const nextTo = to + direction * length;
      if (direction > 0 && !canShiftToNextPeriod(from, to)) return;
      setParams((p) => {
        const next = new URLSearchParams(p);
        next.set("from", String(nextFrom));
        next.set("to", String(nextTo));
        next.delete("preset");
        return next;
      });
    },
    [from, setParams, to]
  );

  const setHarnesses = useCallback(
    (names: string[]) => {
      setParams((p) => {
        const next = new URLSearchParams(p);
        next.delete("harness");
        for (const n of names) next.append("harness", n);
        return next;
      });
    },
    [setParams]
  );

  const setModel = useCallback(
    (m: string) => {
      setParams((p) => {
        const next = new URLSearchParams(p);
        if (m) next.set("model", m); else next.delete("model");
        return next;
      });
    },
    [setParams]
  );

  const setRepo = useCallback(
    (r: string) => {
      setParams((p) => {
        const next = new URLSearchParams(p);
        if (r) next.set("repo", r); else next.delete("repo");
        return next;
      });
    },
    [setParams]
  );

  const setCompareMode = useCallback(
    (mode: CompareMode) => {
      setParams((p) => {
        const next = new URLSearchParams(p);
        if (mode === "off") {
          next.delete("compare");
          next.delete("compareFrom");
          next.delete("compareTo");
        } else {
          next.set("compare", mode);
          if (mode === "custom") {
            const fallback = resolveCompareRange("previous-period", from, to, null, null);
            if (fallback && (!next.has("compareFrom") || !next.has("compareTo"))) {
              next.set("compareFrom", String(fallback.from));
              next.set("compareTo", String(fallback.to));
            }
          } else {
            next.delete("compareFrom");
            next.delete("compareTo");
          }
        }
        return next;
      });
    },
    [from, setParams, to]
  );

  const setCustomCompareRange = useCallback(
    (fromDate: Date, toDate: Date) => {
      setParams((p) => {
        const next = new URLSearchParams(p);
        next.set("compare", "custom");
        next.set("compareFrom", String(fromDate.getTime()));
        next.set("compareTo", String(toDate.getTime()));
        return next;
      });
    },
    [setParams]
  );

  const resetFilters = useCallback(() => {
    const range = presetToRange(defaultPreset);
    setParams({ from: String(range.from), to: String(range.to), preset: defaultPreset });
  }, [defaultPreset, setParams]);

  const activePreset = urlPreset ?? (hasExplicitRange ? null : defaultPreset);
  const validCompareMode: CompareMode =
    compareMode === "previous-period" || compareMode === "previous-week" ||
    compareMode === "previous-month" || compareMode === "custom" ? compareMode : "off";
  const compareRange = resolveCompareRange(validCompareMode, from, to, compareFrom, compareTo);
  const canShiftNext = canShiftToNextPeriod(from, to);

  return {
    filters,
    setPreset,
    setCustomRange,
    shiftPeriod,
    canShiftNext,
    setHarnesses,
    setModel,
    setRepo,
    setCompareMode,
    setCustomCompareRange,
    resetFilters,
    activePreset,
    compareMode: validCompareMode,
    compareRange,
    defaultPreset,
  };
}
