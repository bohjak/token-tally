/**
 * bash-detect.ts — Pure bash command classifier for git/gh operations.
 *
 * Given a raw bash command string, classifies which git / gh operations it
 * performs and returns them in order.
 *
 * Design: pure function, no I/O, no async, no module-level mutable state.
 * Adapted from ~/.pi/agent/extensions/analytics/src/git/bash-detect.ts.
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
// Tokenizer — splits a command into whitespace-separated tokens, respecting
// single-quoted and double-quoted strings.
// ---------------------------------------------------------------------------

function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let i = 0;

  while (i < segment.length) {
    const ch = segment[i];
    if (ch === "'") {
      i++;
      while (i < segment.length && segment[i] !== "'") {
        current += segment[i++];
      }
      i++;
    } else if (ch === '"') {
      i++;
      while (i < segment.length && segment[i] !== '"') {
        if (segment[i] === "\\" && i + 1 < segment.length) {
          const next = segment[i + 1];
          if (next === '"' || next === "\\") {
            current += next;
            i += 2;
            continue;
          }
        }
        current += segment[i++];
      }
      i++;
    } else if (ch === "\\" && i + 1 < segment.length) {
      current += segment[i + 1];
      i += 2;
    } else if (ch === " " || ch === "\t") {
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
// Splitter — breaks a raw command into logical segments on &&, ||, ;, |.
// ---------------------------------------------------------------------------

function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let i = 0;

  while (i < command.length) {
    const ch = command[i];

    if (ch === "'") {
      current += ch;
      i++;
      while (i < command.length && command[i] !== "'") {
        current += command[i++];
      }
      if (i < command.length) current += command[i++];
      continue;
    }

    if (ch === '"') {
      current += ch;
      i++;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === "\\" && i + 1 < command.length) {
          current += command[i++];
        }
        current += command[i++];
      }
      if (i < command.length) current += command[i++];
      continue;
    }

    if (
      (ch === "&" || ch === "|") &&
      i + 1 < command.length &&
      command[i + 1] === ch
    ) {
      segments.push(current.trim());
      current = "";
      i += 2;
      continue;
    }

    if (ch === ";" || ch === "|") {
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
// Per-segment matcher
// ---------------------------------------------------------------------------

function stripEnvAssignments(tokens: string[]): string[] {
  let start = 0;
  while (
    start < tokens.length &&
    /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start])
  ) {
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

  if (cmd === "git") {
    const sub = tokens[1];
    if (!sub) return null;

    if (sub === "commit") {
      return { kind: "git-commit" };
    }

    if (sub === "checkout") {
      const rest = tokens.slice(2);
      const bIdx = rest.indexOf("-b");
      if (bIdx !== -1) {
        const branch =
          rest.find((t, i) => i > bIdx && !t.startsWith("-")) ??
          rest[bIdx + 1];
        if (branch) return { kind: "git-checkout", toBranch: branch, created: true };
      }
      const branch = rest.find((t) => !t.startsWith("-"));
      if (branch) return { kind: "git-checkout", toBranch: branch, created: false };
      return null;
    }

    if (sub === "switch") {
      const rest = tokens.slice(2);
      const cIdx = rest.indexOf("-c");
      if (cIdx !== -1) {
        const branch =
          rest.find((t, i) => i > cIdx && !t.startsWith("-")) ??
          rest[cIdx + 1];
        if (branch) return { kind: "git-switch", toBranch: branch, created: true };
      }
      const branch = rest.find((t) => !t.startsWith("-"));
      if (branch) return { kind: "git-switch", toBranch: branch, created: false };
      return null;
    }

    if (sub === "push") {
      const rest = tokens.slice(2);
      const positional = rest.filter((t) => !t.startsWith("-"));
      const remote = positional[0];
      const rawBranch = positional[1];
      const branch = rawBranch?.includes(":")
        ? rawBranch.split(":")[0]
        : rawBranch;
      return { kind: "git-push", remote, branch };
    }

    return null;
  }

  if (cmd === "gh") {
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
 * Parse a raw bash command string and return all detected git/gh operations.
 */
export function detectGitOps(command: string): DetectedOp[] {
  const ops: DetectedOp[] = [];
  for (const segment of splitSegments(command)) {
    const op = matchSegment(segment);
    if (op !== null) ops.push(op);
  }
  return ops;
}
