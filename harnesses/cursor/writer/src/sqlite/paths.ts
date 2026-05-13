/**
 * sqlite/paths.ts — Platform-specific path resolution for Cursor's state.vscdb.
 *
 * Cursor stores private session metadata in a SQLite database (`state.vscdb`)
 * inside its application data directory. The location is platform-specific and
 * follows VS Code's extension storage conventions.
 *
 * IMPORTANT CAVEATS
 * ─────────────────
 * - This path is a private Cursor implementation detail, not a public API.
 * - It may change across Cursor versions without notice.
 * - Missing, relocated, or inaccessible paths are expected and should be
 *   treated as "no data available" rather than errors.
 * - The file is actively written by Cursor. Always open it read-only.
 *
 * Plan reference:
 *   macOS: ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
 *   Linux: ~/.config/Cursor/User/globalStorage/state.vscdb
 *   Windows: %APPDATA%/Cursor/User/globalStorage/state.vscdb
 */

import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the expected path to Cursor's `state.vscdb` for the current platform.
 *
 * Returns `undefined` when:
 *   - The platform is not recognised (not macOS / Linux / Windows).
 *   - The required environment variable (`APPDATA` on Windows) is absent.
 *
 * Does NOT verify that the file exists — callers must handle missing files.
 */
export function getCursorStateDbPath(): string | undefined {
  const home = os.homedir();

  switch (process.platform) {
    case "darwin":
      // macOS: ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
      return path.join(
        home,
        "Library",
        "Application Support",
        "Cursor",
        "User",
        "globalStorage",
        "state.vscdb",
      );

    case "linux":
      // Linux (including WSL): ~/.config/Cursor/User/globalStorage/state.vscdb
      // XDG_CONFIG_HOME override is respected if set, but Cursor itself
      // hard-codes ~/.config, so we match that behaviour.
      return path.join(
        home,
        ".config",
        "Cursor",
        "User",
        "globalStorage",
        "state.vscdb",
      );

    case "win32": {
      // Windows: %APPDATA%\Cursor\User\globalStorage\state.vscdb
      // APPDATA should always be set on Windows, but guard defensively.
      const appData = process.env["APPDATA"];
      if (!appData) {
        console.warn(
          "[cursor-writer] sqlite/paths: APPDATA env var not set on Windows — cannot locate state.vscdb",
        );
        return undefined;
      }
      return path.join(
        appData,
        "Cursor",
        "User",
        "globalStorage",
        "state.vscdb",
      );
    }

    default:
      // Unknown platform (e.g. FreeBSD) — skip silently.
      return undefined;
  }
}
