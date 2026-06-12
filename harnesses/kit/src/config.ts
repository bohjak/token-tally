/**
 * config.ts — Central config.json loader for ToTally hook-process writers.
 *
 * Replaces two near-identical loaders:
 *   harnesses/claude-code/writer/src/subscription/config.ts
 *   harnesses/cursor/writer/src/subscription/config.ts
 *
 * Config file location: $XDG_CONFIG_HOME/token-tally/config.json
 * (defaults to ~/.config/token-tally/config.json)
 *
 * Expected config.json shape:
 * ```json
 * {
 *   "harnesses": {
 *     "<harnessName>": {
 *       "subscription": "<plan-slug>",
 *       "subscriptionFixedCostUSD": 20,
 *       "subscriptionStartDay": 1,
 *       "captureRaw": false
 *     }
 *   }
 * }
 * ```
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Subscription configuration extracted from config.json for a given harness.
 * Populated only when the harness block contains a `subscription` key.
 */
export type SubConfig = {
  /** Plan slug, e.g. "claude-pro", "cursor-pro". */
  plan: string;
  /** Flat monthly fee in USD (default: 0). */
  fixedCostUSD: number;
  /** Day-of-month the billing period starts (1–31, default: 1). */
  startDay: number;
};

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

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/**
 * Load and parse config.json, returning the raw parsed object.
 * Returns null when the file is absent or malformed.
 */
async function loadRawConfig(tag: string): Promise<Record<string, unknown> | null> {
  const configPath = join(configDir(), "config.json");
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") return null;
    console.warn(`${tag} Failed to read config file:`, err);
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch (err: unknown) {
    console.warn(`${tag} config.json is malformed JSON — ignoring:`, err);
    return null;
  }
}

/**
 * Extract the harness-specific config block from the parsed config.
 * Returns null when the block is absent.
 */
function getHarnessBlock(
  config: Record<string, unknown>,
  harnessName: string,
): Record<string, unknown> | null {
  const harnesses = config["harnesses"];
  if (typeof harnesses !== "object" || harnesses === null) return null;
  const block = (harnesses as Record<string, unknown>)[harnessName];
  if (typeof block !== "object" || block === null) return null;
  return block as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load the subscription config for the given harness from config.json.
 *
 * Returns null when:
 * - The config file does not exist (no subscription configured).
 * - The `harnesses[harnessName].subscription` key is absent.
 * - The file is present but contains malformed JSON (warning logged).
 *
 * @param harnessName - Key in the `harnesses` block, e.g. "claude-code" or "cursor".
 * @param tag         - Log prefix for warnings, e.g. "[claude-code-writer]".
 */
export async function loadSubscriptionConfig(
  harnessName: string,
  tag: string,
): Promise<SubConfig | null> {
  const config = await loadRawConfig(tag);
  if (config === null) return null;

  const block = getHarnessBlock(config, harnessName);
  if (block === null) return null;

  const plan = block["subscription"];
  if (typeof plan !== "string" || plan === "") return null;

  const fixedCostUSD =
    typeof block["subscriptionFixedCostUSD"] === "number"
      ? block["subscriptionFixedCostUSD"]
      : 0;

  const startDay =
    typeof block["subscriptionStartDay"] === "number" &&
    block["subscriptionStartDay"] >= 1 &&
    block["subscriptionStartDay"] <= 31
      ? Math.floor(block["subscriptionStartDay"])
      : 1;

  return { plan, fixedCostUSD, startDay };
}

/**
 * Load only the `captureRaw` flag for the given harness.
 *
 * Returns false when the config is absent, malformed, or the flag is not set.
 * Does not require a subscription plan to be present.
 *
 * @param harnessName - Key in the `harnesses` block, e.g. "cursor".
 */
export async function loadCaptureRawFlag(harnessName: string): Promise<boolean> {
  // Errors are not logged for captureRaw — absence is the common case.
  const config = await loadRawConfig("[token-tally/config]");
  if (config === null) return false;

  const block = getHarnessBlock(config, harnessName);
  if (block === null) return false;

  return block["captureRaw"] === true;
}
