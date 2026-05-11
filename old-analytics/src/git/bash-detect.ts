/**
 * bash-detect.ts — Pure bash command classifier for git/gh operations.
 *
 * Given a raw bash command string (as passed to the `bash` tool), classifies
 * which git / gh operations it performs and returns them in order.
 *
 * Design constraints:
 * - Pure function — no I/O, no async, no module-level mutable state.
 * - Not a full bash parser.  We tokenize quoted strings just well enough to
 *   avoid false splits on `&&` / `;` / `||` / `|` that appear inside quotes,
 *   then do straightforward per-segment matching.
 * - Operator precedence is intentionally ignored — we want to capture intent,
 *   not model conditional execution.  A `git push` after `||` still counts.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DetectedOp =
  | { kind: "git-commit" }
  | { kind: "git-checkout"; toBranch: string; created: boolean }
  | { kind: "git-switch"; toBranch: string; created: boolean }
  | { kind: "git-push"; remote?: string; branch?: string }
  | { kind: "gh-pr-create" };

// ---------------------------------------------------------------------------
// Tokenizer — splits a command string into whitespace-separated tokens while
// respecting single-quoted and double-quoted strings.  Backslash escapes
// inside double quotes are honoured for `\"` and `\\`; single quotes are
// treated as fully opaque (no escapes, per POSIX).
// ---------------------------------------------------------------------------

function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let i = 0;

  while (i < segment.length) {
    const ch = segment[i];

    if (ch === "'" ) {
      // Single-quoted string — consume until closing single quote, no escapes.
      i++;
      while (i < segment.length && segment[i] !== "'") {
        current += segment[i++];
      }
      i++; // skip closing quote
    } else if (ch === '"') {
      // Double-quoted string — honour `\"` and `\\` only.
      i++;
      while (i < segment.length && segment[i] !== '"') {
        if (segment[i] === '\\' && i + 1 < segment.length) {
          const next = segment[i + 1];
          if (next === '"' || next === '\\') {
            current += next;
            i += 2;
            continue;
          }
        }
        current += segment[i++];
      }
      i++; // skip closing quote
    } else if (ch === '\\' && i + 1 < segment.length) {
      // Bare backslash outside quotes — escape next character.
      current += segment[i + 1];
      i += 2;
    } else if (ch === ' ' || ch === '\t') {
      // Whitespace — flush current token.
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      i++;
    } else {
      current += ch;
      i++;
    }
  }

  if (current.length > 0) tokens.push(current);
  return tokens;
}

// ---------------------------------------------------------------------------
// Splitter — breaks a raw command into logical segments on `&&`, `||`, `;`,
// and `|`.  Quoted regions are skipped so `git commit -m "a && b"` is one
// segment, not two.
// ---------------------------------------------------------------------------

function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let i = 0;

  while (i < command.length) {
    const ch = command[i];

    // Skip over single-quoted regions.
    if (ch === "'") {
      current += ch;
      i++;
      while (i < command.length && command[i] !== "'") {
        current += command[i++];
      }
      if (i < command.length) { current += command[i++]; } // closing quote
      continue;
    }

    // Skip over double-quoted regions.
    if (ch === '"') {
      current += ch;
      i++;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === '\\' && i + 1 < command.length) {
          current += command[i++]; // backslash
        }
        current += command[i++];
      }
      if (i < command.length) { current += command[i++]; } // closing quote
      continue;
    }

    // Detect `&&` and `||` (two-char operators).
    if ((ch === '&' || ch === '|') && i + 1 < command.length && command[i + 1] === ch) {
      segments.push(current.trim());
      current = "";
      i += 2; // skip both chars
      continue;
    }

    // Detect `;` (single-char separator).
    if (ch === ';') {
      segments.push(current.trim());
      current = "";
      i++;
      continue;
    }

    // Detect single `|` (pipe).
    if (ch === '|') {
      segments.push(current.trim());
      current = "";
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  const tail = current.trim();
  if (tail.length > 0) segments.push(tail);

  return segments.filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Per-segment matchers
// ---------------------------------------------------------------------------

/**
 * Strip common shell variable assignments and command-environment prefixes
 * from the front of a token list (e.g. `GIT_DIR=/x git commit` → starts at
 * `git`).  We only strip simple `KEY=VALUE` tokens before the first
 * non-assignment word.
 */
function stripEnvAssignments(tokens: string[]): string[] {
  let start = 0;
  while (start < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start])) {
    start++;
  }
  return tokens.slice(start);
}

function matchSegment(segment: string): DetectedOp | null {
  const rawTokens = tokenize(segment);
  if (rawTokens.length === 0) return null;

  const tokens = stripEnvAssignments(rawTokens);
  if (tokens.length === 0) return null;

  const cmd = tokens[0];

  // ── git ──────────────────────────────────────────────────────────────────
  if (cmd === "git") {
    const sub = tokens[1];
    if (!sub) return null;

    // git commit [-a] [-m <msg>] [--amend] [...]
    if (sub === "commit") {
      return { kind: "git-commit" };
    }

    // git checkout [-b] <branch>
    if (sub === "checkout") {
      const rest = tokens.slice(2);
      const bIdx = rest.indexOf("-b");
      if (bIdx !== -1) {
        // `-b <branch>` — pick the token after `-b`, skip other flags
        const branch = rest.find((t, i) => i > bIdx && !t.startsWith("-")) ?? rest[bIdx + 1];
        if (branch) return { kind: "git-checkout", toBranch: branch, created: true };
      }
      // No `-b` — find the first non-flag token as the branch name.
      const branch = rest.find((t) => !t.startsWith("-"));
      if (branch) return { kind: "git-checkout", toBranch: branch, created: false };
      return null;
    }

    // git switch [-c] <branch>
    if (sub === "switch") {
      const rest = tokens.slice(2);
      const cIdx = rest.indexOf("-c");
      if (cIdx !== -1) {
        const branch = rest.find((t, i) => i > cIdx && !t.startsWith("-")) ?? rest[cIdx + 1];
        if (branch) return { kind: "git-switch", toBranch: branch, created: true };
      }
      const branch = rest.find((t) => !t.startsWith("-"));
      if (branch) return { kind: "git-switch", toBranch: branch, created: false };
      return null;
    }

    // git push [<remote> [<refspec>]]
    // Handles: git push, git push origin, git push origin main,
    //          git push -u origin feat/x, git push --force origin main, etc.
    if (sub === "push") {
      const rest = tokens.slice(2);
      // Filter out flags (tokens starting with `-`)
      const positional = rest.filter((t) => !t.startsWith("-"));
      const remote = positional[0];
      // refspec may be `local:remote` — take the local part as the branch name.
      const rawBranch = positional[1];
      const branch = rawBranch?.includes(":") ? rawBranch.split(":")[0] : rawBranch;
      return { kind: "git-push", remote, branch };
    }

    return null;
  }

  // ── gh ───────────────────────────────────────────────────────────────────
  if (cmd === "gh") {
    // gh pr create [flags...]
    if (tokens[1] === "pr" && tokens[2] === "create") {
      return { kind: "gh-pr-create" };
    }
    return null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a raw bash command string and return all detected git/gh operations
 * in the order they appear.
 *
 * @param command - The raw command string passed to the bash tool.
 * @returns An array of detected operations (may be empty).
 */
export function detectGitOps(command: string): DetectedOp[] {
  const segments = splitSegments(command);
  const ops: DetectedOp[] = [];

  for (const segment of segments) {
    const op = matchSegment(segment);
    if (op !== null) ops.push(op);
  }

  return ops;
}
