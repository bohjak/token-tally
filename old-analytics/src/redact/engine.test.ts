/**
 * engine.test.ts — Tests for applyRules, walkAndRedact, compileUserPatterns,
 * mergeHits, and the 1 MiB oversize guard.
 *
 * Also includes a lightweight ReDoS benchmark: each default rule is applied
 * to a 100 KB "pathological" string and must complete in <50 ms.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyRules,
  walkAndRedact,
  compileUserPatterns,
  mergeHits,
  type RedactionHits,
} from "./engine.ts";
import type { RedactRule } from "./rules.ts";
import { DEFAULT_RULES } from "./rules.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRule(pattern: RegExp, replace?: (m: string) => string): RedactRule {
  return { name: "test", pattern, replace };
}

// ---------------------------------------------------------------------------
// applyRules — basic behaviour
// ---------------------------------------------------------------------------

describe("applyRules", () => {
  it("returns text unchanged and empty hits when no rules match", () => {
    const result = applyRules("hello world", [makeRule(/NOMATCH/g)]);
    assert.equal(result.text, "hello world");
    assert.deepEqual(result.hits, {});
  });

  it("replaces matching text with default placeholder", () => {
    const rule: RedactRule = { name: "secret", pattern: /SECRET/g };
    const result = applyRules("my SECRET key", [rule]);
    assert.equal(result.text, "my [REDACTED:secret] key");
    assert.equal(result.hits["secret"], 1);
  });

  it("counts multiple matches correctly", () => {
    const rule: RedactRule = { name: "x", pattern: /TOKEN/g };
    const result = applyRules("TOKEN TOKEN TOKEN", [rule]);
    assert.equal(result.hits["x"], 3);
    assert(!result.text.includes("TOKEN"));
  });

  it("uses custom replace callback", () => {
    const rule: RedactRule = {
      name: "header",
      pattern: /Authorization: Bearer \S+/g,
      replace: () => "Authorization: Bearer [REDACTED]",
    };
    const result = applyRules("Authorization: Bearer secrettoken", [rule]);
    assert.equal(result.text, "Authorization: Bearer [REDACTED]");
  });

  it("accumulates hits across multiple rules", () => {
    const r1: RedactRule = { name: "a", pattern: /AAA/g };
    const r2: RedactRule = { name: "b", pattern: /BBB/g };
    const result = applyRules("AAA BBB AAA", [r1, r2]);
    assert.equal(result.hits["a"], 2);
    assert.equal(result.hits["b"], 1);
  });

  it("rules run in order (earlier rule replacement not re-matched by later)", () => {
    // Rule 1 replaces "SECRET" with "[REDACTED:r1]"
    // Rule 2 tries to match "REDACTED" — but REDACTED is not in its pattern target
    const r1: RedactRule = { name: "r1", pattern: /SECRET/g };
    const r2: RedactRule = { name: "r2", pattern: /SECRET/g };
    const result = applyRules("SECRET", [r1, r2]);
    // After r1, text is "[REDACTED:r1]" — r2 won't match because "SECRET" is gone
    assert.equal(result.hits["r1"], 1);
    assert.equal(result.hits["r2"] ?? 0, 0);
  });
});

// ---------------------------------------------------------------------------
// Oversize guard
// ---------------------------------------------------------------------------

describe("applyRules oversize guard", () => {
  it("skips text >1 MiB and returns it unchanged with oversize hit", () => {
    const bigText = "a".repeat(1_048_577); // 1 MiB + 1 byte
    const rule: RedactRule = { name: "any", pattern: /a/g };
    const result = applyRules(bigText, [rule]);
    // Text returned unchanged
    assert.equal(result.text.length, bigText.length);
    // No rule-specific hits — just the oversize sentinel
    assert.equal(result.hits["oversize"], 1);
    assert.equal(result.hits["any"] ?? 0, 0);
  });

  it("processes text exactly at 1 MiB without triggering oversize", () => {
    // 1 MiB = 1,048,576 bytes.  "a" is 1 byte UTF-8, so 1,048,576 "a"s is exactly 1 MiB.
    const exactMib = "a".repeat(1_048_576);
    const rule: RedactRule = { name: "any", pattern: /NOMATCH/g };
    const result = applyRules(exactMib, [rule]);
    assert.equal(result.hits["oversize"] ?? 0, 0);
  });
});

// ---------------------------------------------------------------------------
// walkAndRedact
// ---------------------------------------------------------------------------

describe("walkAndRedact", () => {
  const secretRule: RedactRule = { name: "secret", pattern: /TOPSECRET/g };

  it("redacts strings in a plain object", () => {
    const obj = { key: "my TOPSECRET value", num: 42, flag: true };
    const { value, hits } = walkAndRedact(obj, [secretRule]);
    assert(!value.key.includes("TOPSECRET"));
    assert.equal(value.num, 42);
    assert.equal(value.flag, true);
    assert.equal(hits["secret"], 1);
  });

  it("redacts strings in a nested object", () => {
    const obj = { a: { b: { c: "TOPSECRET" } } };
    const { value, hits } = walkAndRedact(obj, [secretRule]);
    assert(!(value as any).a.b.c.includes("TOPSECRET"));
    assert.equal(hits["secret"], 1);
  });

  it("redacts strings in an array", () => {
    const arr = ["TOPSECRET", "safe", "also TOPSECRET"];
    const { value, hits } = walkAndRedact(arr, [secretRule]);
    assert(!value[0].includes("TOPSECRET"));
    assert.equal(value[1], "safe");
    assert(!value[2].includes("TOPSECRET"));
    assert.equal(hits["secret"], 2);
  });

  it("passes Date through unchanged", () => {
    const d = new Date("2024-01-01");
    const { value } = walkAndRedact({ date: d }, [secretRule]);
    assert(value.date instanceof Date);
  });

  it("passes numbers, booleans, null through unchanged", () => {
    const { value } = walkAndRedact({ n: 1, b: false, nil: null }, [secretRule]);
    assert.equal(value.n, 1);
    assert.equal(value.b, false);
    assert.equal(value.nil, null);
  });

  it("accumulates hits across deep leaves", () => {
    const obj = { a: "TOPSECRET", b: ["TOPSECRET", "TOPSECRET"] };
    const { hits } = walkAndRedact(obj, [secretRule]);
    assert.equal(hits["secret"], 3);
  });
});

// ---------------------------------------------------------------------------
// compileUserPatterns
// ---------------------------------------------------------------------------

describe("compileUserPatterns", () => {
  it("compiles valid patterns into rules", () => {
    const rules = compileUserPatterns(["api[_-]?key", "bearer\\s+\\S+"]);
    assert.equal(rules.length, 2);
    // First rule should match on positive fixture
    const result = applyRules("api_key=secret123", rules);
    // api[_-]?key matches "api_key" (but the whole value isn't captured by default)
    // The rule just matches "api_key" not "api_key=secret123"
    assert.ok(result.hits[`user:api[_-]?key`] >= 1);
  });

  it("skips invalid regex patterns with a warn-once warning", () => {
    const logs: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { logs.push(args.join(" ")); };

    try {
      const rules = compileUserPatterns(["[invalid(regex"]);
      assert.equal(rules.length, 0, "invalid pattern produces no rule");
      assert.equal(logs.length, 1, "warns once");
      assert(logs[0].includes("invalid"), "warning mentions the pattern");

      // Second call with same bad pattern should NOT produce another warning
      const logs2: string[] = [];
      console.warn = (...args: unknown[]) => { logs2.push(args.join(" ")); };
      compileUserPatterns(["[invalid(regex"]);
      assert.equal(logs2.length, 0, "warn-once: no second warning");
    } finally {
      console.warn = originalWarn;
    }
  });

  it("compiles rules with global flag", () => {
    const [rule] = compileUserPatterns(["TOKEN"]);
    assert(rule.pattern.flags.includes("g"), "must have global flag");
  });
});

// ---------------------------------------------------------------------------
// mergeHits
// ---------------------------------------------------------------------------

describe("mergeHits", () => {
  it("sums counts across multiple sets", () => {
    const a: RedactionHits = { "github-token": 2, "jwt": 1 };
    const b: RedactionHits = { "github-token": 1, "openai-key": 3 };
    const merged = mergeHits(a, b);
    assert.equal(merged["github-token"], 3);
    assert.equal(merged["jwt"], 1);
    assert.equal(merged["openai-key"], 3);
  });

  it("handles empty input", () => {
    assert.deepEqual(mergeHits(), {});
  });

  it("handles single set", () => {
    const a: RedactionHits = { "x": 5 };
    assert.deepEqual(mergeHits(a), { "x": 5 });
  });
});

// ---------------------------------------------------------------------------
// ReDoS benchmark — each default rule must finish <50 ms on a 100 KB input
// ---------------------------------------------------------------------------

describe("ReDoS benchmark (100 KB pathological input per rule)", () => {
  const SIZE = 100_000; // 100 KB

  // For each rule, construct a pathological string that partially matches the
  // pattern prefix (maximising attempted matches without completing them).
  // Then assert the call completes within 50 ms.
  for (const rule of DEFAULT_RULES) {
    it(`${rule.name} finishes in <50 ms on 100 KB near-miss input`, () => {
      // Generic pathological: repeat the first few chars of the pattern source.
      // This is a best-effort; the key property is that it terminates fast.
      let pathological: string;
      switch (rule.name) {
        case "github-token":
          pathological = "ghp_".repeat(SIZE / 4);
          break;
        case "gitlab-pat":
          pathological = "glpat-".repeat(SIZE / 6);
          break;
        case "openai-key":
          pathological = "sk-".repeat(SIZE / 3);
          break;
        case "anthropic-key":
          pathological = "sk-ant-".repeat(SIZE / 7);
          break;
        case "aws-access-key":
          pathological = "AKIA".repeat(SIZE / 4);
          break;
        case "gcp-api-key":
          pathological = "AIza".repeat(SIZE / 4);
          break;
        case "slack-token":
          pathological = "xoxb-12345678-".repeat(Math.floor(SIZE / 14));
          break;
        case "stripe-key":
          pathological = "sk_test_".repeat(SIZE / 8);
          break;
        case "jwt":
          // Worst case: many "eyJ" prefixes but never a complete JWT
          pathological = "eyJhbGciOiJSUzI1NiJ9".repeat(Math.floor(SIZE / 20));
          break;
        case "private-key-block":
          // Many "-----BEGIN" markers without matching "END"
          pathological = "-----BEGIN PRIVATE KEY-----\n" + "A".repeat(SIZE - 30);
          break;
        case "bearer-header":
          pathological = "Authorization: Bearer ".repeat(Math.floor(SIZE / 22));
          break;
        case "db-conn-string":
          pathological = "postgres://user:".repeat(Math.floor(SIZE / 16));
          break;
        case "cli-password-flag":
          pathological = "--password ".repeat(Math.floor(SIZE / 11));
          break;
        case "env-assignment":
          pathological = "MY_SECRET_TOKEN=".repeat(Math.floor(SIZE / 16));
          break;
        default:
          pathological = "x".repeat(SIZE);
      }
      // Pad/trim to exactly SIZE bytes
      pathological = pathological.slice(0, SIZE).padEnd(SIZE, "x");

      const start = performance.now();
      applyRules(pathological, [rule]);
      const elapsed = performance.now() - start;

      assert(
        elapsed < 50,
        `Rule "${rule.name}" took ${elapsed.toFixed(1)} ms on 100 KB input (limit: 50 ms)`,
      );
    });
  }
});
