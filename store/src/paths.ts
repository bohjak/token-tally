/**
 * Path helpers for the ToTally central store.
 *
 * Honors the XDG Base Directory Specification when the relevant environment
 * variables are set, and falls back to the conventional defaults on macOS/Linux:
 *
 *   XDG_DATA_HOME   → ~/.local/share   (database, spool)
 *   XDG_CONFIG_HOME → ~/.config        (config.json, install.json)
 *   XDG_STATE_HOME  → ~/.local/state   (logs)
 *
 * All paths are rooted under a "token-tally" sub-directory of the
 * corresponding XDG base so the app's files don't scatter across the user's
 * home directory.
 *
 * These functions read environment variables at call time rather than at
 * module load time so that tests can override XDG vars before calling.
 */

import { homedir } from "os";
import { join } from "path";

// Stable subdirectory name shared by every ToTally component.
// Using the hyphenated form per project naming conventions.
const APP_DIR_NAME = "token-tally";

/**
 * Base data directory: `$XDG_DATA_HOME/token-tally`
 * Fallback: `~/.local/share/token-tally`
 *
 * Contains the central SQLite database and the NDJSON spool sub-directory.
 */
export function defaultDataDir(): string {
  const xdgDataHome = process.env["XDG_DATA_HOME"];
  const base = xdgDataHome != null && xdgDataHome !== ""
    ? xdgDataHome
    : join(homedir(), ".local", "share");
  return join(base, APP_DIR_NAME);
}

/**
 * Base config directory: `$XDG_CONFIG_HOME/token-tally`
 * Fallback: `~/.config/token-tally`
 *
 * Contains `config.json`, `install.json`, and future per-component configs.
 */
export function defaultConfigDir(): string {
  const xdgConfigHome = process.env["XDG_CONFIG_HOME"];
  const base = xdgConfigHome != null && xdgConfigHome !== ""
    ? xdgConfigHome
    : join(homedir(), ".config");
  return join(base, APP_DIR_NAME);
}

/**
 * Base state directory: `$XDG_STATE_HOME/token-tally`
 * Fallback: `~/.local/state/token-tally`
 *
 * Contains logs and other non-essential persistent state (not user data).
 */
export function defaultStateDir(): string {
  const xdgStateHome = process.env["XDG_STATE_HOME"];
  const base = xdgStateHome != null && xdgStateHome !== ""
    ? xdgStateHome
    : join(homedir(), ".local", "state");
  return join(base, APP_DIR_NAME);
}

/**
 * Full path to the central SQLite database.
 * Default: `~/.local/share/token-tally/events.db`
 *
 * This path is the stable local data contract shared by all harness writers
 * and read clients. Components that need a different path should accept it
 * as an explicit option rather than hard-coding an alternative default.
 */
export function defaultDatabasePath(): string {
  return join(defaultDataDir(), "events.db");
}

/**
 * Directory for NDJSON spool files written when the SQLite DB is busy or
 * unreachable.
 * Default: `~/.local/share/token-tally/spool`
 *
 * File naming inside this directory:
 *   Active (writer holds open):  `<harness>-<pid>.ndjson`
 *   Closed (ready to drain):     `<harness>-<pid>-<ts>.ndjson.closed`
 *
 * Ingestion must never touch active files; only `.ndjson.closed` files are
 * safe to drain.
 */
export function defaultSpoolDir(): string {
  return join(defaultDataDir(), "spool");
}
