/**
 * subscription/config.ts — Read optional subscription config for the Cursor harness.
 *
 * When configured, the writer records a subscription period and links covered
 * messages with cost_source = "subscription_covered". Otherwise messages are
 * recorded with cost_source = "writer" (list-price) or "unknown" (no pricing).
 *
 * Reads the `harnesses.cursor` block from ~/.config/token-tally/config.json:
 *
 * ```json
 * {
 *   "harnesses": {
 *     "cursor": {
 *       "subscription": "cursor-pro",
 *       "subscriptionFixedCostUSD": 20,
 *       "subscriptionStartDay": 1,
 *       "captureRaw": false
 *     }
 *   }
 * }
 * ```
 *
 * T6 owns this file and may extend it; the implementation here is intentionally
 * complete so the package compiles before T6 runs.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CursorSubConfig {
  /** Plan slug, e.g. "cursor-pro". */
  plan: string;
  /** Flat monthly fee in USD. */
  fixedCostUSD: number;
  /** Day-of-month the billing period starts (1–31). */
  startDay: number;
  /**
   * When true, the preCompact handler emits a minimal raw_event containing
   * context_tokens and context_window_size. Off by default.
   */
  captureRaw: boolean;
}

// ---------------------------------------------------------------------------
// Config file path
// ---------------------------------------------------------------------------

function configDir(): string {
  const xdgConfigHome = process.env["XDG_CONFIG_HOME"];
  const base =
    xdgConfigHome != null && xdgConfigHome !== ""
      ? xdgConfigHome
      : join(homedir(), ".config");
  return join(base, "token-tally");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load the Cursor subscription config from config.json.
 *
 * Returns null when:
 * - The config file does not exist (ENOENT).
 * - The `harnesses.cursor.subscription` key is absent.
 * - The file contains malformed JSON (a warning is logged).
 */
export async function loadCursorSubscriptionConfig(): Promise<CursorSubConfig | null> {
  const configPath = join(configDir(), "config.json");

  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") return null;
    console.warn("[cursor-writer] Failed to read config file:", err);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    console.warn("[cursor-writer] config.json is malformed JSON — ignoring:", err);
    return null;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("harnesses" in parsed)
  ) {
    return null;
  }

  const harnesses = (parsed as Record<string, unknown>)["harnesses"];
  if (typeof harnesses !== "object" || harnesses === null) return null;

  const cursor = (harnesses as Record<string, unknown>)["cursor"];
  if (typeof cursor !== "object" || cursor === null) return null;

  const cfg = cursor as Record<string, unknown>;
  const plan = cfg["subscription"];
  if (typeof plan !== "string" || plan === "") return null;

  const fixedCostUSD =
    typeof cfg["subscriptionFixedCostUSD"] === "number"
      ? cfg["subscriptionFixedCostUSD"]
      : 0;

  const startDay =
    typeof cfg["subscriptionStartDay"] === "number" &&
    cfg["subscriptionStartDay"] >= 1 &&
    cfg["subscriptionStartDay"] <= 31
      ? Math.floor(cfg["subscriptionStartDay"])
      : 1;

  const captureRaw = cfg["captureRaw"] === true;

  return { plan, fixedCostUSD, startDay, captureRaw };
}

/**
 * Load only the captureRaw flag, without requiring a subscription plan.
 * Returns false when the config is absent or malformed.
 */
export async function loadCaptureRawFlag(): Promise<boolean> {
  const configPath = join(configDir(), "config.json");

  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    return false;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }

  if (typeof parsed !== "object" || parsed === null) return false;
  const harnesses = (parsed as Record<string, unknown>)["harnesses"];
  if (typeof harnesses !== "object" || harnesses === null) return false;
  const cursor = (harnesses as Record<string, unknown>)["cursor"];
  if (typeof cursor !== "object" || cursor === null) return false;
  return (cursor as Record<string, unknown>)["captureRaw"] === true;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
