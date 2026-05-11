/**
 * rules.test.ts — Tests for DEFAULT_RULES.
 *
 * For every default rule, we verify:
 *   1. At least one positive fixture is matched and replaced.
 *   2. At least one negative fixture is NOT matched.
 *   3. Rules with `replace` callbacks preserve structural signal.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RULES } from "./rules.ts";
import { applyRules } from "./engine.ts";

// Helper: apply a single named rule to a string.
function applyRule(name: string, text: string): string {
  const rule = DEFAULT_RULES.find((r) => r.name === name);
  assert(rule, `Rule "${name}" not found in DEFAULT_RULES`);
  return applyRules(text, [rule]).text;
}

function matchesRule(name: string, text: string): boolean {
  const rule = DEFAULT_RULES.find((r) => r.name === name);
  assert(rule, `Rule "${name}" not found`);
  const result = applyRules(text, [rule]);
  return Object.keys(result.hits).length > 0;
}

// ---------------------------------------------------------------------------
// github-token
// ---------------------------------------------------------------------------

describe("github-token", () => {
  it("redacts a ghp_ token", () => {
    const token = "ghp_" + "A".repeat(36);
    const result = applyRule("github-token", `My token: ${token}`);
    assert(!result.includes(token));
    assert(result.includes("[REDACTED:github-token]"));
  });

  it("redacts a gho_ token", () => {
    const token = "gho_" + "B".repeat(40);
    const result = applyRule("github-token", token);
    assert(!result.includes(token));
  });

  it("redacts a ghs_ token", () => {
    const token = "ghs_" + "C".repeat(36);
    assert(matchesRule("github-token", token));
  });

  it("does not redact a short gh prefix that is not a token", () => {
    // "ghx_" is not a valid prefix
    assert(!matchesRule("github-token", "ghx_shorttoken"));
  });

  it("does not redact a URL with gh in it", () => {
    assert(!matchesRule("github-token", "https://github.com/owner/repo"));
  });
});

// ---------------------------------------------------------------------------
// gitlab-pat
// ---------------------------------------------------------------------------

describe("gitlab-pat", () => {
  it("redacts a GitLab PAT", () => {
    const token = "glpat-" + "x".repeat(20);
    assert(matchesRule("gitlab-pat", token));
  });

  it("does not redact a short glpat-like string", () => {
    assert(!matchesRule("gitlab-pat", "glpat-short"));
  });
});

// ---------------------------------------------------------------------------
// openai-key
// ---------------------------------------------------------------------------

describe("openai-key", () => {
  it("redacts a classic sk- key", () => {
    const key = "sk-" + "A".repeat(32);
    assert(matchesRule("openai-key", key));
  });

  it("does not match a short sk-", () => {
    assert(!matchesRule("openai-key", "sk-short"));
  });
});

// ---------------------------------------------------------------------------
// anthropic-key
// ---------------------------------------------------------------------------

describe("anthropic-key", () => {
  it("redacts sk-ant- key", () => {
    const key = "sk-ant-" + "A".repeat(40);
    assert(matchesRule("anthropic-key", key));
  });

  it("does not match short sk-ant-", () => {
    assert(!matchesRule("anthropic-key", "sk-ant-short"));
  });
});

// ---------------------------------------------------------------------------
// aws-access-key
// ---------------------------------------------------------------------------

describe("aws-access-key", () => {
  it("redacts a valid AKIA key", () => {
    // Exactly 20 chars: AKIA + 16 uppercase alphanum
    const key = "AKIA" + "0123456789ABCDEF";
    assert(matchesRule("aws-access-key", `AWS_ACCESS_KEY_ID=${key}`));
  });

  it("does not match lowercase akia", () => {
    // All lowercase — not a valid AWS access key format
    assert(!matchesRule("aws-access-key", "akia0123456789abcdef"));
  });

  it("does not match a string of all 'a' chars (aaaa...)", () => {
    // A common false-positive canary: long runs of a single char
    assert(!matchesRule("aws-access-key", "a".repeat(100)));
  });

  it("does not match AKIA with wrong length", () => {
    // AKIA + only 15 chars is too short
    assert(!matchesRule("aws-access-key", "AKIA012345678901"));
  });
});

// ---------------------------------------------------------------------------
// gcp-api-key
// ---------------------------------------------------------------------------

describe("gcp-api-key", () => {
  it("redacts AIza key", () => {
    const key = "AIza" + "A".repeat(35);
    assert(matchesRule("gcp-api-key", key));
  });

  it("does not match AIza with wrong length", () => {
    assert(!matchesRule("gcp-api-key", "AIza" + "A".repeat(10)));
  });
});

// ---------------------------------------------------------------------------
// slack-token
// ---------------------------------------------------------------------------

describe("slack-token", () => {
  it("redacts a xoxb- bot token", () => {
    const token = "xoxb-12345678-12345678-" + "A".repeat(24);
    assert(matchesRule("slack-token", token));
  });

  it("does not match xoxz- (invalid type)", () => {
    const token = "xoxz-12345678-12345678-" + "A".repeat(24);
    assert(!matchesRule("slack-token", token));
  });
});

// ---------------------------------------------------------------------------
// stripe-key
// ---------------------------------------------------------------------------

describe("stripe-key", () => {
  it("redacts sk_test_ key", () => {
    const key = "sk_test_" + "A".repeat(24);
    assert(matchesRule("stripe-key", key));
  });

  it("redacts pk_live_ key", () => {
    const key = "pk_live_" + "B".repeat(20);
    assert(matchesRule("stripe-key", key));
  });

  it("does not match sk_staging_ (unknown environment)", () => {
    assert(!matchesRule("stripe-key", "sk_staging_" + "A".repeat(20)));
  });
});

// ---------------------------------------------------------------------------
// jwt
// ---------------------------------------------------------------------------

describe("jwt", () => {
  it("redacts a well-formed JWT", () => {
    // Real-ish JWT structure (base64url-encoded JSON header + payload)
    const header = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9";
    const payload = "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0";
    const sig = "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const jwt = `${header}.${payload}.${sig}`;
    assert(matchesRule("jwt", jwt));
    const redacted = applyRule("jwt", `Token: ${jwt}`);
    assert(!redacted.includes(sig));
  });

  it("does not match a plain dotted word", () => {
    assert(!matchesRule("jwt", "hello.world.foo"));
  });

  it("does not match when payload does not start with eyJ", () => {
    // Second segment must start with eyJ — not a JWT if it doesn't
    const fake = "eyJheader.notJSON.signature";
    assert(!matchesRule("jwt", fake));
  });
});

// ---------------------------------------------------------------------------
// private-key-block
// ---------------------------------------------------------------------------

describe("private-key-block", () => {
  it("redacts a PEM private key block", () => {
    const key = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq...\n-----END PRIVATE KEY-----";
    assert(matchesRule("private-key-block", key));
    const redacted = applyRule("private-key-block", key);
    assert(!redacted.includes("MIIEvQIBADANBgkq"));
  });

  it("redacts an RSA PRIVATE KEY block", () => {
    const key = "-----BEGIN RSA PRIVATE KEY-----\nfakedata\n-----END RSA PRIVATE KEY-----";
    assert(matchesRule("private-key-block", key));
  });

  it("does not match a PUBLIC KEY block", () => {
    const pub = "-----BEGIN PUBLIC KEY-----\nfakedata\n-----END PUBLIC KEY-----";
    assert(!matchesRule("private-key-block", pub));
  });
});

// ---------------------------------------------------------------------------
// bearer-header
// ---------------------------------------------------------------------------

describe("bearer-header", () => {
  it("redacts bearer token and preserves header name", () => {
    const input = "Authorization: Bearer eyJtoken123abc";
    const result = applyRule("bearer-header", input);
    assert(result.includes("Authorization"), "should preserve header name");
    assert(result.includes("Bearer [REDACTED]"), "should redact token");
    assert(!result.includes("eyJtoken123abc"), "should not leak token");
  });

  it("handles case-insensitive Authorization header", () => {
    const input = "authorization: Bearer secrettoken999";
    const result = applyRule("bearer-header", input);
    assert(!result.includes("secrettoken999"));
    assert(result.includes("Bearer [REDACTED]"));
  });

  it("does not match a non-bearer auth scheme", () => {
    assert(!matchesRule("bearer-header", "Authorization: Basic dXNlcjpwYXNz"));
  });
});

// ---------------------------------------------------------------------------
// db-conn-string
// ---------------------------------------------------------------------------

describe("db-conn-string", () => {
  it("redacts postgres credentials and preserves host", () => {
    const conn = "postgres://admin:s3cret@db.prod.example.com:5432/orders";
    const result = applyRule("db-conn-string", conn);
    assert(result.includes("[REDACTED]"), "should redact credentials");
    assert(result.includes("db.prod.example.com"), "should preserve host");
    assert(!result.includes("s3cret"), "should not leak password");
    assert(!result.includes("admin"), "should not leak username");
  });

  it("redacts mongodb+srv credentials", () => {
    const conn = "mongodb+srv://user:pass@cluster0.mongodb.net/db";
    const result = applyRule("db-conn-string", conn);
    assert(result.includes("[REDACTED]"));
    assert(result.includes("cluster0.mongodb.net"));
  });

  it("does not match a URL without credentials", () => {
    // No user:pass@ segment
    assert(!matchesRule("db-conn-string", "https://example.com/path"));
  });
});

// ---------------------------------------------------------------------------
// cli-password-flag
// ---------------------------------------------------------------------------

describe("cli-password-flag", () => {
  it("redacts --password=value and preserves flag name", () => {
    const result = applyRule("cli-password-flag", "mysql --password=mypassword123");
    assert(result.includes("--password"));
    assert(!result.includes("mypassword123"));
    assert(result.includes("[REDACTED]"));
  });

  it("redacts --token with space separator", () => {
    const result = applyRule("cli-password-flag", "curl --token mytoken123");
    assert(!result.includes("mytoken123"));
  });

  it("does not match --verbose or unrelated flags", () => {
    assert(!matchesRule("cli-password-flag", "command --verbose --debug"));
  });
});

// ---------------------------------------------------------------------------
// env-assignment
// ---------------------------------------------------------------------------

describe("env-assignment", () => {
  it("redacts API_KEY=... assignment", () => {
    const result = applyRule("env-assignment", "export API_KEY=abc12345678");
    assert(!result.includes("abc12345678"), "should redact value");
    assert(result.includes("API_KEY"), "should preserve key name");
    assert(result.includes("[REDACTED]"));
  });

  it("redacts MY_SECRET_TOKEN=... with quoted value", () => {
    const result = applyRule("env-assignment", 'MY_SECRET_TOKEN="ghp_xxxxxxxxxxxxxxxxxxxx"');
    assert(!result.includes("ghp_xxxxxxxxxxxxxxxxxxxx"));
  });

  it("does not redact MY_FOO=hello (non-secret key + short value)", () => {
    // MY_FOO does not end with a secret suffix, and value is short
    assert(!matchesRule("env-assignment", "MY_FOO=hello"));
  });

  it("does not redact MY_TOKEN=hi (value too short)", () => {
    // MY_TOKEN matches the key pattern but "hi" is only 2 chars
    assert(!matchesRule("env-assignment", "MY_TOKEN=hi"));
  });

  it("is tagged for prompts and bash-args contexts only", () => {
    const rule = DEFAULT_RULES.find((r) => r.name === "env-assignment");
    assert(rule?.contexts?.includes("prompts"), "should include prompts context");
    assert(rule?.contexts?.includes("bash-args"), "should include bash-args context");
  });
});
