/**
 * Discovery of Pi session JSONL files.
 *
 * Layout (relative to sessionsRoot):
 *   <cwd-slug>/<timestamp>_<uuid>.jsonl                     — parent session
 *   <cwd-slug>/<timestamp>_<uuid>/<runHash>/run-N/session.jsonl — subagent session
 *
 * Rules per plan rev 2 §3:
 *   - Parents: flat *.jsonl directly inside a <cwd-slug> directory.
 *   - Subagents: depth-5 session.jsonl files; date-filtered by their own
 *     session event timestamp (which can differ from the parent session's day).
 *   - All discovered files are sorted by sessionStartIso ascending (import
 *     order is part of the first-occurrence-wins replay dedup contract).
 *   - `--from` / `--to` are applied as UTC day bounds (inclusive/exclusive).
 */

import { existsSync, readdirSync, statSync, readFileSync } from "fs";
import { join } from "path";
import type { DiscoveredFile } from "./types";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discovers all Pi session JSONL files under `sessionsRoot`, applying optional
 * UTC date bounds. Returns files sorted by sessionStartIso ascending.
 */
export function discoverPiSessions(
  sessionsRoot: string,
  opts?: { from?: string; to?: string },
): DiscoveredFile[] {
  if (!existsSync(sessionsRoot)) return [];

  const results: DiscoveredFile[] = [];

  let cwdSlugs: string[];
  try {
    cwdSlugs = readdirSync(sessionsRoot).filter((name) => {
      try {
        return statSync(join(sessionsRoot, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }

  for (const slug of cwdSlugs) {
    const slugDir = join(sessionsRoot, slug);
    let entries: string[];
    try {
      entries = readdirSync(slugDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = join(slugDir, entry);
      let entryStat: ReturnType<typeof statSync> | undefined;
      try {
        entryStat = statSync(entryPath);
      } catch {
        continue;
      }

      if (entryStat.isFile() && entry.endsWith(".jsonl")) {
        // Parent session: flat *.jsonl directly in cwd-slug directory.
        const sessionStartIso = readFirstSessionTimestamp(entryPath)
          ?? extractTimestampFromFilename(entry);
        if (sessionStartIso == null) continue;
        if (!isInDateRange(sessionStartIso, opts?.from, opts?.to)) continue;
        results.push({ filePath: entryPath, isSubagent: false, sessionStartIso });
      } else if (entryStat.isDirectory()) {
        // Potential parent session directory: look for subagent sessions.
        collectSubagentSessions(entryPath, results, opts?.from, opts?.to);
      }
    }
  }

  // Sort ascending by session start timestamp (lexicographic on ISO strings is correct).
  results.sort((a, b) => (a.sessionStartIso < b.sessionStartIso ? -1 : a.sessionStartIso > b.sessionStartIso ? 1 : 0));

  return results;
}

// ---------------------------------------------------------------------------
// Subagent discovery
// ---------------------------------------------------------------------------

/**
 * Walks `parentDir` (<cwd-slug>/<timestamp>_<uuid>) to find nested
 * <runHash>/run-N/session.jsonl files.
 */
function collectSubagentSessions(
  parentDir: string,
  results: DiscoveredFile[],
  from: string | undefined,
  to: string | undefined,
): void {
  let runHashes: string[];
  try {
    runHashes = readdirSync(parentDir).filter((name) => {
      try { return statSync(join(parentDir, name)).isDirectory(); }
      catch { return false; }
    });
  } catch {
    return;
  }

  for (const hash of runHashes) {
    const hashDir = join(parentDir, hash);
    let runDirs: string[];
    try {
      runDirs = readdirSync(hashDir).filter((name) => {
        if (!/^run-\d+$/.test(name)) return false;
        try { return statSync(join(hashDir, name)).isDirectory(); }
        catch { return false; }
      });
    } catch {
      continue;
    }

    for (const runDir of runDirs) {
      const sessionPath = join(hashDir, runDir, "session.jsonl");
      if (!existsSync(sessionPath)) continue;

      // Subagent date filtering uses the subagent's own session event timestamp.
      const sessionStartIso = readFirstSessionTimestamp(sessionPath);
      if (sessionStartIso == null) continue;
      if (!isInDateRange(sessionStartIso, from, to)) continue;
      results.push({ filePath: sessionPath, isSubagent: true, sessionStartIso });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reads the first `session` event from a JSONL file and returns its
 * ISO-8601 timestamp. Returns null if not found or file is unreadable.
 *
 * Reads up to MAX_LINES_TO_SCAN lines to avoid reading huge files entirely.
 */
const MAX_LINES_TO_SCAN = 100;

function readFirstSessionTimestamp(filePath: string): string | null {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const lines = content.split("\n");
  for (let i = 0; i < Math.min(lines.length, MAX_LINES_TO_SCAN); i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj["type"] === "session" && typeof obj["timestamp"] === "string") {
        const ts = Date.parse(obj["timestamp"] as string);
        if (!isNaN(ts)) return new Date(ts).toISOString();
      }
    } catch {
      // malformed line — keep scanning
    }
  }
  return null;
}

/**
 * Tries to extract a parseable ISO timestamp from the filename stem.
 * Pi uses "<timestamp>_<uuid>.jsonl" where timestamp is an ISO string.
 * Returns the ISO string, or null if it cannot be parsed.
 */
function extractTimestampFromFilename(filename: string): string | null {
  const withoutExt = filename.replace(/\.jsonl$/, "");
  // UUID portion is after the last underscore. The timestamp itself may
  // contain underscores (e.g. seconds-precision variant), so find the last
  // underscore that is preceded by a digit or 'Z' (end of ISO timestamp).
  const uuidSepIdx = withoutExt.lastIndexOf("_");
  if (uuidSepIdx <= 0) return null;

  const tsPart = withoutExt.substring(0, uuidSepIdx);

  // Direct ISO parse.
  let ms = Date.parse(tsPart);
  if (!isNaN(ms)) return new Date(ms).toISOString();

  // Filesystem-safe variant: colons replaced with dashes (Windows / URLs).
  // e.g. "2026-06-09T14-05-17.405Z" → "2026-06-09T14:05:17.405Z"
  const normalized = tsPart.replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3");
  ms = Date.parse(normalized);
  if (!isNaN(ms)) return new Date(ms).toISOString();

  return null;
}

/**
 * Returns true when sessionStartIso falls within [from, to) (UTC day bounds).
 * Both bounds are optional; absent = no limit in that direction.
 */
export function isInDateRange(
  sessionStartIso: string,
  from: string | undefined,
  to: string | undefined,
): boolean {
  const sessionMs = Date.parse(sessionStartIso);
  if (isNaN(sessionMs)) return false;

  if (from != null) {
    const fromMs = Date.parse(from + "T00:00:00Z");
    if (!isNaN(fromMs) && sessionMs < fromMs) return false;
  }
  if (to != null) {
    const toMs = Date.parse(to + "T00:00:00Z");
    if (!isNaN(toMs) && sessionMs >= toMs) return false;
  }
  return true;
}
