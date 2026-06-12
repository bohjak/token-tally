#!/usr/bin/env bash
# scripts/install-web-explorer.sh — Build and verify the web explorer server and client.
#
# Responsibilities:
#   1. Build the @token-tally/web-explorer package (server + React client).
#   2. Verify the expected dist outputs exist.
#   3. Verify that `token-tally explore --help` works via the store CLI.
#
# Arguments:
#   $1  REPO_ROOT — absolute path to the repository root (optional;
#                   defaults to the directory containing this script's parent)
#
# Environment:
#   REPO_ROOT — alternative to the positional argument; positional takes precedence.
#
# Exit codes:
#   0   success
#   1   build or verification failure
set -euo pipefail

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

if [[ -t 1 ]]; then
  GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; RESET='\033[0m'
else
  GREEN=''; YELLOW=''; RED=''; RESET=''
fi

info()  { echo -e "  ${GREEN}✓${RESET}  $*"; }
warn()  { echo -e "  ${YELLOW}!${RESET}  $*"; }
err()   { echo -e "  ${RED}✗${RESET}  $*"; }

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  # Resolve REPO_ROOT: positional arg > env var > relative to script location.
  local repo_root
  if [[ -n "${1:-}" ]]; then
    repo_root="$1"
  elif [[ -n "${REPO_ROOT:-}" ]]; then
    repo_root="$REPO_ROOT"
  else
    # This script lives at <repo_root>/scripts/install-web-explorer.sh,
    # so one dirname up from the script is the repo root.
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    repo_root="$(dirname "$script_dir")"
  fi

  echo "  Building @token-tally/web-explorer…"
  pnpm --filter @token-tally/web-explorer --dir "${repo_root}" build 2>&1 | sed 's/^/    /' || {
    err "@token-tally/web-explorer build failed"
    return 1
  }

  # ---- Verify dist/server/index.js ----
  local server_dist="${repo_root}/clients/web-explorer/dist/server/index.js"
  if [[ ! -f "${server_dist}" ]]; then
    err "dist/server/index.js not found after build"
    return 1
  fi
  info "dist/server/index.js present"

  # ---- Verify dist/client/index.html ----
  local client_dist="${repo_root}/clients/web-explorer/dist/client/index.html"
  if [[ ! -f "${client_dist}" ]]; then
    err "dist/client/index.html not found after build"
    return 1
  fi
  info "dist/client/index.html present"

  # ---- Verify `token-tally explore --help` works ----
  # Use the store binary path directly so this works before any PATH refresh.
  # On a fresh checkout, store/bin/token-tally.js requires store/dist/cli/index.js;
  # build the store package here if that output is not present yet.
  local store_bin="${repo_root}/store/bin/token-tally.js"
  local store_cli_dist="${repo_root}/store/dist/cli/index.js"
  if [[ ! -f "${store_bin}" ]]; then
    warn "store/bin/token-tally.js not found — skipping explore --help check."
    warn "  Run the store install step first, then re-run this script."
  else
    if [[ ! -f "${store_cli_dist}" ]]; then
      echo "  Building @token-tally/store CLI for explore verification…"
      pnpm --filter @token-tally/store --dir "${repo_root}" build 2>&1 | sed 's/^/    /' || {
        err "@token-tally/store build failed"
        return 1
      }
    fi

    echo "  Verifying token-tally explore --help…"
    local help_output
    if help_output="$(node "${store_bin}" explore --help 2>&1)"; then
      info "token-tally explore --help works"
    else
      err "token-tally explore --help failed"
      printf '%s\n' "${help_output}" | sed 's/^/    /' >&2
      err "  Ensure the store CLI is built and supports the 'explore' subcommand (T1)."
      return 1
    fi
  fi

  info "Web Explorer built and verified"
}

main "$@"
