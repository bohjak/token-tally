import { randomUUID } from "node:crypto";

/**
 * Synthesize a stable harness-scoped turn ID.
 * Format: `${sessionId}:t${turnIndex}`
 * Same inputs always produce the same string (deterministic).
 */
export function synthesizeTurnId(
  sessionId: string,
  turnIndex: number,
): string {
  return `${sessionId}:t${turnIndex}`;
}

/**
 * Mint a new random UUID for ToTally-internal primary keys.
 * Thin wrapper over crypto.randomUUID() so callers don't need to import crypto.
 */
export function centralUuid(): string {
  return randomUUID();
}
