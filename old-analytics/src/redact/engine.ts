/**
 * engine.ts — Pattern-redaction engine.
 *
 * Applies a list of `RedactRule` objects to strings (or arbitrarily nested
 * objects) in a single pass, accumulating per-rule hit counts.
 *
 * ## Thread safety / lastIndex
 * Node.js is single-threaded, but to guard against future async batching and
 * to keep `lastIndex` state isolated, the engine clones each rule's regex into
 * a WeakMap-keyed cache.  `lastIndex` is always reset before use.
 *
 * ## 1 MiB oversize guard
 * Strings whose UTF-8 byte length exceeds `INPUT_SIZE_LIMIT` (1,048,576 bytes)
 * are returned unchanged with `hits.oversize = 1`.  This prevents a single
 * enormous tool output from triggering catastrophic backtracking on any regex.
 * The limit is intentionally generous — real prompts and tool outputs are almost
 * always well below 1 MiB.
 *
 * All exports are pure functions.  Module-level state is limited to the two
 * WeakMap caches (compiled regex cache; warn-once set for invalid user patterns).
 */

import { byteLengthUtf8 } from "./util.ts";
import type { RedactRule } from "./rules.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Maps rule name → match count.  Always a plain object; missing keys mean 0.
 * T2 (`sinks/types.ts`) imports this type from `redact/index.ts`.
 */
export type RedactionHits = Record<string, number>;

// ---------------------------------------------------------------------------
// Internal regex cache
// ---------------------------------------------------------------------------

/**
 * Per-rule cached RegExp clone so we control `lastIndex` without mutating
 * the caller's rule object.
 */
const regexCache = new WeakMap<RedactRule, RegExp>();

function getRegex(rule: RedactRule): RegExp {
  let re = regexCache.get(rule);
  if (re === undefined) {
    // Clone using source+flags to get an independent lastIndex counter.
    re = new RegExp(rule.pattern.source, rule.pattern.flags);
    regexCache.set(rule, re);
  }
  // Always reset before each use — String.prototype.replace resets it too,
  // but being explicit is cheap and defensive.
  re.lastIndex = 0;
  return re;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Strings larger than this are skipped with an `oversize` hit. */
const INPUT_SIZE_LIMIT = 1_048_576; // 1 MiB

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Apply `rules` to `text` in order, replacing each match and accumulating
 * counts in `hits`.
 *
 * Rules run sequentially so earlier rules can interact with later ones
 * (e.g., a bearer-header rule runs before a generic token rule to capture
 * context-aware replacements first).
 *
 * Strings >1 MiB are returned unchanged with `{ hits: { oversize: 1 } }`.
 */
export function applyRules(
  text: string,
  rules: RedactRule[],
): { text: string; hits: RedactionHits } {
  const hits: RedactionHits = {};

  if (byteLengthUtf8(text) > INPUT_SIZE_LIMIT) {
    hits["oversize"] = 1;
    return { text, hits };
  }

  let result = text;
  for (const rule of rules) {
    const re = getRegex(rule);
    re.lastIndex = 0;

    const defaultReplacement = `[REDACTED:${rule.name}]`;
    let matchCount = 0;

    result = result.replace(re, (match) => {
      matchCount++;
      return rule.replace ? rule.replace(match) : defaultReplacement;
    });

    if (matchCount > 0) {
      hits[rule.name] = (hits[rule.name] ?? 0) + matchCount;
    }
  }

  return { text: result, hits };
}

/**
 * Merge any number of `RedactionHits` maps by summing counts for each key.
 */
export function mergeHits(...sets: RedactionHits[]): RedactionHits {
  const result: RedactionHits = {};
  for (const set of sets) {
    for (const [key, count] of Object.entries(set)) {
      result[key] = (result[key] ?? 0) + count;
    }
  }
  return result;
}

/**
 * Deep-walk `value`, applying `applyRules` to every string leaf.
 *
 * - Plain objects: walk values recursively, return a new object with the
 *   same shape and redacted string values.
 * - Arrays: walk elements, return a new array.
 * - `string`: redact in place.
 * - `number`, `boolean`, `null`, `undefined`, `Date`, and any other
 *   non-plain-object type: returned as-is.
 *
 * The returned `hits` map is the union (summed) of all leaf hits.
 */
export function walkAndRedact<T>(
  value: T,
  rules: RedactRule[],
): { value: T; hits: RedactionHits } {
  const allHits: RedactionHits = {};

  function accumulate(h: RedactionHits): void {
    for (const [k, c] of Object.entries(h)) {
      allHits[k] = (allHits[k] ?? 0) + c;
    }
  }

  function walk(v: unknown): unknown {
    if (typeof v === "string") {
      const { text, hits } = applyRules(v, rules);
      accumulate(hits);
      return text;
    }
    if (Array.isArray(v)) {
      return v.map(walk);
    }
    // Walk plain objects.  Skip Date instances and other built-ins that would
    // be mangled if we iterated their enumerable properties.
    if (v !== null && typeof v === "object" && !(v instanceof Date)) {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(
        v as Record<string, unknown>,
      )) {
        out[k] = walk(val);
      }
      return out as T;
    }
    // Primitives (number, boolean, null, undefined, Symbol, BigInt) pass through.
    return v;
  }

  return { value: walk(value) as T, hits: allHits };
}

// ---------------------------------------------------------------------------
// User-pattern compilation
// ---------------------------------------------------------------------------

/** Set of pattern strings we've already warned about (warn-once). */
const warnedPatterns = new Set<string>();

/**
 * Compile user-supplied regex pattern strings (from `config.privacy.redactPatterns`)
 * into `RedactRule` objects.  Invalid regex syntax is skipped with a single
 * `console.warn` per bad pattern.  Call this once at extension startup and
 * reuse the resulting rules — compilation is not free.
 *
 * User rules carry no `replace` callback and use the default
 * `[REDACTED:user:<pattern>]` replacement format, which includes the pattern
 * for debuggability.
 */
export function compileUserPatterns(patterns: string[]): RedactRule[] {
  const rules: RedactRule[] = [];
  for (const pattern of patterns) {
    try {
      // Always compile with the global flag so `applyRules` can count matches.
      const re = new RegExp(pattern, "g");
      rules.push({ name: `user:${pattern}`, pattern: re });
    } catch (err) {
      if (!warnedPatterns.has(pattern)) {
        warnedPatterns.add(pattern);
        console.warn(
          `[analytics/redact] Skipping invalid user redact pattern: ${JSON.stringify(pattern)} — ${(err as Error).message}`,
        );
      }
    }
  }
  return rules;
}
