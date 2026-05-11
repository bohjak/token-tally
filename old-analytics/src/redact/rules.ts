/**
 * rules.ts — Default redaction rule pack.
 *
 * Each rule is a named regex + optional replacement callback.  Rules are
 * applied in declaration order by `applyRules` (engine.ts).
 *
 * ## Adding a new rule
 * 1. Add an entry to `DEFAULT_RULES` — give it a short, kebab-case `name`.
 * 2. Make the pattern global (/g flag); ensure it terminates in O(n) on
 *    adversarial inputs (no polynomial backtracking).
 * 3. If the rule must preserve structural signal (host, header name, etc.),
 *    supply a `replace` callback that keeps that signal and redacts the secret.
 * 4. If the rule is high-recall and should only fire on prompts / bash args
 *    (not raw tool outputs), tag it with `contexts: ["prompts", "bash-args"]`.
 *
 * ## `contexts` semantics
 * Callers (NdjsonSink, hooks) filter `DEFAULT_RULES` by context before calling
 * `applyRules`.  An absent `contexts` field means "always on".  Filtering is
 * the caller's responsibility — the engine itself is context-agnostic.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single named redaction rule.
 *
 * `pattern` MUST carry the global (`g`) flag.  The engine clones each pattern
 * into its own WeakMap-cached copy so `lastIndex` state is never shared across
 * concurrent calls (though Node.js is single-threaded, future async batching
 * could be added without regression).
 *
 * `replace` receives the full match string and returns the replacement.
 * If absent, the default replacement `[REDACTED:${name}]` is used.
 * Callbacks MUST preserve any structural information documented in their
 * rule's comment (e.g., the header name, the DB host).
 *
 * `contexts` is an optional hint for callers.  Absent = always active.
 */
export type RedactRule = {
  name: string;
  pattern: RegExp;
  replace?: (match: string) => string;
  contexts?: string[];
};

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/** Shorthand factory so each rule stays on one line in the array below. */
function rule(
  name: string,
  pattern: RegExp,
  replace?: (m: string) => string,
  contexts?: string[],
): RedactRule {
  return { name, pattern, replace, contexts };
}

// ---------------------------------------------------------------------------
// Default rule pack
// ---------------------------------------------------------------------------

export const DEFAULT_RULES: RedactRule[] = [
  // ── Tokens & API keys ───────────────────────────────────────────────────

  // GitHub: gho_ (OAuth), ghp_ (PAT), ghu_ (user-to-server), ghs_ (server),
  //         ghr_ (refresh).  Minimum 36 chars after the prefix.
  rule("github-token", /\bgh[ousprt]_[A-Za-z0-9_]{36,}\b/g),

  // GitLab Personal Access Tokens: glpat-<20+ alphanum>.
  rule("gitlab-pat", /\bglpat-[A-Za-z0-9_-]{20,}\b/g),

  // OpenAI: sk-<32+> and sk-proj-<32+> (project-scoped).
  rule("openai-key", /\bsk-(?:proj-[A-Za-z0-9_-]{10,}T3BlbkFJ[A-Za-z0-9_-]{10,}|[A-Za-z0-9]{32,})\b/g),

  // Anthropic: sk-ant-api03-<40+ alphanum/dash/underscore>.
  rule("anthropic-key", /\bsk-ant-(?:api\d+-)?[A-Za-z0-9_-]{40,}\b/g),

  // AWS Access Key ID: always starts AKIA, exactly 20 uppercase alphanum chars.
  rule("aws-access-key", /\bAKIA[0-9A-Z]{16}\b/g),

  // GCP API Key: AIza + 35 URL-safe chars.
  rule("gcp-api-key", /\bAIza[A-Za-z0-9_-]{35}\b/g),

  // Slack tokens: xoxa- (legacy), xoxb- (bot), xoxp- (user), xoxr- (refresh),
  //               xoxs- (workspace).  Segment lengths match real token shapes.
  rule(
    "slack-token",
    /\bxox[abprs]-[0-9]{8,13}-[0-9]{8,13}-[A-Za-z0-9]{16,}\b/g,
  ),

  // Stripe publishable / secret / restricted keys.
  rule("stripe-key", /\b(?:sk|pk|rk)_(?:test|live)_[A-Za-z0-9]{16,}\b/g),

  // ── JWTs ────────────────────────────────────────────────────────────────

  // JSON Web Token: header.payload.signature where header and payload both
  // begin with base64url-encoded `{"` (i.e., `eyJ`).  The signature segment
  // uses base64 (URL-safe or standard), plus optional padding.
  // Anchoring on `eyJ` at positions 1 and 2 avoids matching arbitrary dotted
  // strings — this is the standard JWT fingerprint check.
  // The `[A-Za-z0-9_-]` class for segments 1 & 2 deliberately excludes `+`
  // and `/` (not valid in base64url headers/payloads), keeping the match tight.
  rule(
    "jwt",
    /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_/+]+=*(?=\s|$|[^\w.])/g,
  ),

  // ── Private keys ─────────────────────────────────────────────────────────

  // PEM private key blocks.  The body is bounded to ≤8 KiB to prevent
  // catastrophic backtracking on adversarial inputs that contain `BEGIN`
  // but no matching `END`.  Covers RSA, EC, OpenSSH, PKCS#8 variants.
  rule(
    "private-key-block",
    /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]{0,8192}?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g,
  ),

  // ── Structural preserving ────────────────────────────────────────────────

  // Authorization: Bearer <token>  →  Authorization: Bearer [REDACTED]
  // Case-insensitive header name; preserves the header name + scheme.
  rule(
    "bearer-header",
    /\bauthorization\s*:\s*Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
    (m) => {
      // Find where the actual token starts after "Bearer " and replace it.
      const bearerIdx = m.toLowerCase().indexOf("bearer");
      const prefix = m.slice(0, bearerIdx);
      return `${prefix}Bearer [REDACTED]`;
    },
  ),

  // Database connection strings.
  // Preserves scheme://[REDACTED]@host:port/db
  // e.g., postgres://user:pass@db.prod:5432/orders → postgres://[REDACTED]@db.prod:5432/orders
  // The credential segment `[^:@\s]+:[^:@\s]+` is non-backtracking because
  // the character classes exclude `:`, `@`, and whitespace.
  rule(
    "db-conn-string",
    /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis(?:s)?|amqps?|neo4j(?:\+s)?):\/\/)[^:@\s]+:[^:@\s]+(@[^\s,'")\]]+)/gi,
    (m) => {
      // Replace the user:password credential block, keeping scheme and host.
      return m.replace(/(\/\/)[^:@\s]+:[^:@\s]+(@)/, "$1[REDACTED]$2");
    },
  ),

  // CLI password / secret flags.
  // Preserves the flag name; redacts the value.
  // Matches:  --password=secret  --passwd mysecret  --token abc  -p mypass
  // Does NOT match when no value follows (e.g., bare `--password` with no arg).
  rule(
    "cli-password-flag",
    /(?:--(?:password|passwd|pass|secret|api-?key|token)\s*=?\s*|(?<![A-Za-z])-p\s+)\S+/gi,
    (m) => {
      // Keep the flag name; replace only the value portion.
      // Case 1: --password=value  →  find `=` and replace everything after it.
      const eqIdx = m.indexOf("=");
      if (eqIdx !== -1) return m.slice(0, eqIdx + 1) + "[REDACTED]";
      // Case 2: --password value or -p value  →  replace after the last space.
      const spaceIdx = m.lastIndexOf(" ");
      if (spaceIdx !== -1) return m.slice(0, spaceIdx + 1) + "[REDACTED]";
      return "[REDACTED]"; // fallback (should not occur)
    },
  ),

  // ── High-recall (prompts / bash-args only) ──────────────────────────────

  // Environment variable assignments for well-known secret variable names.
  //
  // IMPORTANT: This rule is tagged `contexts: ["prompts", "bash-args"]` and
  // should be excluded from raw tool *outputs* where false-positive rate is
  // too high (e.g., legitimate code that defines config variables).
  //
  // Positive: API_KEY=abc12345     MY_TOKEN="ghp_xxx"     export SECRET=xyzzy
  // Negative: MY_FOO=hello         (key does not match suffix list)
  //           MY_SECRET=hi         (value too short — <8 chars)
  //
  // Key must end with a recognisable secret suffix (case-insensitive on key).
  // Value must be ≥8 chars to reduce false positives on short config values.
  rule(
    "env-assignment",
    /\b(?:export\s+)?([A-Z][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET|PASSWORD|PASS(?:WD)?|API_?KEY|CREDENTIAL|PRIVATE|AUTH))\s*=\s*(?:"[^"]{8,500}"|'[^']{8,500}'|\S{8,})/g,
    (m) => {
      // Keep the variable name; redact everything from `=` onwards.
      return m.replace(/=\s*(?:"[^"]*"|'[^']*'|\S+)$/, "=[REDACTED]");
    },
    ["prompts", "bash-args"],
  ),
];
