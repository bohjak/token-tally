/**
 * subscription/config.ts — Read optional subscription config for the
 * claude-code harness from the central ToTally config file.
 *
 * Config is optional: if the user does not configure a subscription, all
 * llm_messages are recorded with cost_source = "writer" (list-price PAYG).
 * When configured, the writer records a subscription period and links
 * covered messages with cost_source = "subscription_covered".
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Parsed subscription configuration for the claude-code harness.
 * Populated from harnesses["claude-code"].subscription* keys in config.json.
 */
export interface SubConfig {
  /** Plan slug. Well-known values: "claude-pro", "claude-max-5x", "claude-max-20x". */
  plan: "claude-pro" | "claude-max-5x" | "claude-max-20x" | string;
  /** Flat monthly fee in USD. */
  fixedCostUSD: number;
  /** Day-of-month the billing period starts (1–31, clamped per month). */
  startDay: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
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
 * Load the Claude Code subscription config from
 * `$XDG_CONFIG_HOME/token-tally/config.json`.
 *
 * Returns `null` when:
 * - The config file does not exist (ENOENT).
 * - The `harnesses["claude-code"].subscription` key is absent.
 * - The file is present but contains malformed JSON (a warning is logged).
 *
 * Field mapping from config.json:
 * ```json
 * {
 *   "harnesses": {
 *     "claude-code": {
 *       "subscription": "claude-pro",
 *       "subscriptionFixedCostUSD": 20,
 *       "subscriptionStartDay": 1
 *     }
 *   }
 * }
 * ```
 */
export async function loadClaudeCodeSubscriptionConfig(): Promise<SubConfig | null> {
  const configPath = join(configDir(), "config.json");

  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (err: unknown) {
    // File absent is expected (no subscription configured).
    if (isNodeError(err) && err.code === "ENOENT") return null;
    // Any other read error: warn and bail.
    console.warn("[claude-code-writer] Failed to read config file:", err);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    console.warn(
      "[claude-code-writer] config.json is malformed JSON — ignoring subscription config:",
      err,
    );
    return null;
  }

  // Navigate harnesses["claude-code"]
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("harnesses" in parsed)
  ) {
    return null;
  }

  const harnesses = (parsed as Record<string, unknown>)["harnesses"];
  if (typeof harnesses !== "object" || harnesses === null) return null;

  const cc = (harnesses as Record<string, unknown>)["claude-code"];
  if (typeof cc !== "object" || cc === null) return null;

  const ccConfig = cc as Record<string, unknown>;
  const plan = ccConfig["subscription"];
  if (typeof plan !== "string" || plan === "") return null;

  const fixedCostUSD =
    typeof ccConfig["subscriptionFixedCostUSD"] === "number"
      ? ccConfig["subscriptionFixedCostUSD"]
      : 0;

  const startDay =
    typeof ccConfig["subscriptionStartDay"] === "number" &&
    ccConfig["subscriptionStartDay"] >= 1 &&
    ccConfig["subscriptionStartDay"] <= 31
      ? Math.floor(ccConfig["subscriptionStartDay"])
      : 1;

  return { plan, fixedCostUSD, startDay };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
