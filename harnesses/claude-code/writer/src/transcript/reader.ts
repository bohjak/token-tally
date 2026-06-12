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
 * @returns         Parsed entry objects, the next line offset to use on the
 *                  next call, and a flag indicating whether the offset was
 *                  reset to 0 due to the file being shorter than expected
 *                  (rotation / truncation). Callers can use `wasReset` to
 *                  avoid re-attributing rescanned historical entries to the
 *                  current turn.
 */
export async function readTranscriptFrom(
  path: string,
  fromLine: number,
): Promise<{ entries: unknown[]; nextLine: number; wasReset: boolean }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    // File doesn't exist yet (session just started) or is unreadable.
    return { entries: [], nextLine: 0, wasReset: false };
  }

  const lines = raw.split("\n");
  // Drop the phantom empty element that trailing-newline files produce.
  // "L1\nL2\n".split("\n") yields ["L1","L2",""] — pop the trailing empty
  // string so totalLines counts real content lines only.
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const totalLines = lines.length;

  // If the offset OVERSHOOTS the file length the transcript was likely rotated
  // or truncated — reset to the beginning so we don't miss entries.
  // Use strict > (not >=): offset == totalLines is the normal no-growth case
  // (nothing new to read) and must NOT trigger a full rescan.
  const wasReset = fromLine > totalLines;
  const startLine = wasReset ? 0 : fromLine;

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

  return { entries, nextLine: totalLines, wasReset };
}
