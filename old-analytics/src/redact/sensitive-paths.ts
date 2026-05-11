/**
 * sensitive-paths.ts — File-path sensitivity classification.
 *
 * Hooks (T10) consult `pathIsSensitive` before applying privacy modes to
 * file content.  A sensitive path causes content to be dropped entirely —
 * only the path itself and the byte count are recorded.
 *
 * Orthogonal to the pattern-redaction layer: redaction scrubs text that
 * accidentally contains secrets; sensitive-path detection handles files that
 * are *structurally* sensitive (SSH keys, kubeconfig, .env files, etc.).
 *
 * All exports are pure — no I/O, no module-level mutable state.
 */

// ---------------------------------------------------------------------------
// Default sensitive path patterns
// ---------------------------------------------------------------------------

/**
 * Default set of regex patterns that identify sensitive file paths.
 * Checked against the full path string (not just the basename).
 *
 * Design goals:
 *   - High recall for common secret-file conventions.
 *   - Low false-positive rate on normal source files
 *     (e.g., `environment.ts` should not match the `.env` rule).
 *   - Case-sensitive by default (file systems that matter are case-sensitive).
 *
 * These patterns are checked with RegExp.test() against the full file path.
 */
export const DEFAULT_SENSITIVE_PATTERNS: RegExp[] = [
  // .env, .env.local, .env.production, etc. — but NOT "environment.ts" or
  // "dotenv.js".  The pattern requires `.env` followed by `.` or end-of-string,
  // or `.env` at the start of the basename (after the last `/`).
  /(?:^|\/)\.env(?:\.|$)/,

  // AWS credentials and config (~/.aws/)
  /\/\.aws\//,

  // SSH keys and config (~/.ssh/)
  /\/\.ssh\//,

  // Kubernetes config (~/.kube/)
  /\/\.kube\//,

  // PEM certificates and keys
  /\.pem$/i,

  // Generic key files — but be careful: ".monkey" has "key" at the end.
  // Require word boundary by matching `.key` only at end-of-string or `.key.`
  /\.key$/i,

  // PKCS#12 archives (contain private key + certificate)
  /\.p12$/i,
  /\.pfx$/i,

  // Standard SSH private key filenames (no extension or common names)
  /\bid_(?:rsa|ed25519|ecdsa|dsa)(?:\.|$)/,

  // GCP service account credential files
  /credentials(?:\.json)?$/i,

  // macOS Keychain database
  /\.keychain(?:-db)?$/i,

  // netrc — can contain passwords for git remotes, FTP, etc.
  /(?:^|\/)\.netrc$/,

  // Docker config with auth tokens
  /\/\.docker\/config\.json$/,

  // npm auth token config
  /\/\.npmrc$/,

  // pip / pypi credentials
  /\/\.pypirc$/,

  // Git credential storage
  /\/\.git-credentials$/,

  // GPG private key export
  /\.gpg$/i,
  /\.asc$/i,
];

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the file at `path` should be treated as sensitive.
 *
 * Checks against `DEFAULT_SENSITIVE_PATTERNS` plus any caller-supplied
 * `extra` patterns.  All patterns are tested against the **full path string**
 * so directory components (e.g., `/.ssh/`) are matched correctly.
 *
 * @param path   Full or relative path to the file.
 * @param extra  Additional caller-supplied patterns (e.g., from config).
 */
export function pathIsSensitive(path: string, extra?: RegExp[]): boolean {
  for (const pattern of DEFAULT_SENSITIVE_PATTERNS) {
    if (pattern.test(path)) return true;
  }
  if (extra) {
    for (const pattern of extra) {
      if (pattern.test(path)) return true;
    }
  }
  return false;
}
