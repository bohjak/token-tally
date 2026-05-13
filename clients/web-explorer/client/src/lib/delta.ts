import { formatCost, formatDuration, formatPercent, formatTokens } from "./format.ts";

export type DeltaTone = "good" | "bad" | "neutral";

export function deltaPercent(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return (current - previous) / previous;
}

export function formatDeltaPercent(current: number, previous: number): string {
  const percent = deltaPercent(current, previous);
  const absolute = current - previous;
  const sign = absolute >= 0 ? "+" : "−";
  if (percent == null) return `${sign}${formatTokens(Math.abs(absolute))}`;
  return `${sign}${formatPercent(Math.abs(percent))}`;
}

export function formatCostDelta(current: number, previous: number): string {
  const absolute = current - previous;
  const sign = absolute >= 0 ? "+" : "−";
  return `${sign}${formatCost(Math.abs(absolute))}`;
}

export function formatNumberDelta(current: number, previous: number): string {
  const absolute = current - previous;
  const sign = absolute >= 0 ? "+" : "−";
  return `${sign}${formatTokens(Math.abs(absolute))}`;
}

export function formatDurationDelta(current: number, previous: number): string {
  const absolute = current - previous;
  const sign = absolute >= 0 ? "+" : "−";
  return `${sign}${formatDuration(Math.abs(absolute))}`;
}

export function deltaTone(current: number, previous: number, lowerIsBetter = false): DeltaTone {
  if (current === previous) return "neutral";
  return (current < previous) === lowerIsBetter ? "good" : "bad";
}

export function deltaClass(tone: DeltaTone): string {
  if (tone === "good") return "text-green-600";
  if (tone === "bad") return "text-red-600";
  return "text-gray-500";
}
