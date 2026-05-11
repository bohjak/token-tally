/**
 * Small utilities shared across store/src modules.
 */

/**
 * Strips embedded credentials (user:password@) from HTTP/HTTPS git remote URLs
 * before storage. SSH remotes (git@host:path) and other schemes are returned
 * unchanged because they do not embed credentials in the URL.
 *
 * Examples:
 *   "https://user:token@github.com/owner/repo.git"
 *     → "https://github.com/owner/repo.git"
 *   "https://token@github.com/owner/repo.git"
 *     → "https://github.com/owner/repo.git"
 *   "git@github.com:owner/repo.git"     → unchanged (SSH)
 *   "https://github.com/owner/repo.git" → unchanged (no credentials)
 */
export function redactRemoteUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      (parsed.username !== "" || parsed.password !== "")
    ) {
      parsed.username = "";
      parsed.password = "";
      return parsed.toString();
    }
  } catch {
    // Not a parseable URL (e.g. SSH short form); return as-is.
  }
  return url;
}
