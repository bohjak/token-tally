/**
 * transcript/reader.ts — Incremental JSONL transcript reader.
 *
 * Reads the Claude Code transcript file from a byte/line offset forward,
 * returning parsed entries and the new offset for the next call. Designed
 * to be called repeatedly as hook invocations fire throughout a session.
 */

import { readFile } from "node:fs/promises";

// Track which (path, lineIndex) pairs have already warned so we don't spam
// the console for long-lived sessions.
const warnedLines = new Set<string>();

/**
 * Read transcript entries starting from `fromLine`.
 *
 * @param path      Path to the JSONL transcript file.
 * @param fromLine  Zero-based line index to start reading from.
 *                  Pass 0 to read from the beginning.
 * @returns         Parsed entry objects and the next line offset to use on the
 *                  next call (= total line count of the file, including blanks).
 */
export async function readTranscriptFrom(
  path: string,
  fromLine: number,
): Promise<{ entries: unknown[]; nextLine: number }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    // File doesn't exist yet (session just started) or is unreadable.
    return { entries: [], nextLine: 0 };
  }

  const lines = raw.split("\n");
  const totalLines = lines.length;

  // If the offset is past the end of the file the transcript was likely
  // rotated or truncated — reset to the beginning so we don't miss entries.
  const startLine = fromLine >= totalLines ? 0 : fromLine;

  const entries: unknown[] = [];
  for (let i = startLine; i < totalLines; i++) {
    const line = lines[i];
    if (!line || line.trim() === "") continue;
    try {
      entries.push(JSON.parse(line) as unknown);
    } catch {
      const key = `${path}:${i}`;
      if (!warnedLines.has(key)) {
        warnedLines.add(key);
        console.warn(
          `[claude-code-writer] transcript: malformed JSON at ${path}:${i} — skipping`,
        );
      }
    }
  }

  return { entries, nextLine: totalLines };
}
