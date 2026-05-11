#!/usr/bin/env bash
# scripts/install-store.sh — Build and install the token-tally CLI and central database.
#
# Responsibilities:
#   1. Install npm dependencies (pnpm install, idempotent).
#   2. Build the store TypeScript package.
#   3. Link the token-tally binary globally via pnpm.
#   4. Create or migrate the central SQLite database.
#
# Arguments:
#   $1  REPO_ROOT   — absolute path to the repository root
#   $2  DATA_DIR    — absolute path to the token-tally data dir (for the DB)
#
# Exit codes:
#   0   success
#   1   hard failure (dependency missing, build failed, migration failed)
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
  local repo_root="${1:?REPO_ROOT is required}"
  local data_dir="${2:?DATA_DIR is required}"

  # ---- Verify Node and pnpm are available ----
  if ! command -v node &>/dev/null; then
    err "node not found. Install Node.js >= 20 to continue."
    err "  See: https://nodejs.org or use 'n' (n lts)"
    return 1
  fi

  if ! command -v pnpm &>/dev/null; then
    err "pnpm not found. Install it with: npm install -g pnpm"
    return 1
  fi

  local node_major
  node_major=$(node -e "process.stdout.write(process.version.replace(/^v/,'').split('.')[0])")
  if (( node_major < 20 )); then
    err "Node.js >= 20 required; found v${node_major}. Use 'n lts' to upgrade."
    return 1
  fi

  # ---- Install pnpm workspace dependencies ----
  # pnpm install is idempotent; it's a no-op when the lockfile matches.
  echo "  Installing npm dependencies…"
  pnpm install --dir "${repo_root}" --silent 2>&1 | sed 's/^/    /' || {
    err "pnpm install failed"
    return 1
  }
  info "npm dependencies up to date"

  # ---- Build the store package ----
  # tsc compiles store/src/** and store/cli/** → store/dist/
  echo "  Building @token-tally/store…"
  pnpm --filter @token-tally/store --dir "${repo_root}" build 2>&1 | sed 's/^/    /' || {
    err "@token-tally/store build failed"
    return 1
  }
  info "@token-tally/store built"

  # ---- Link the token-tally binary globally ----
  # pnpm link --global, run from the store package directory, makes
  # `token-tally` available in $PATH via pnpm's global bin dir.
  # This is idempotent: relinking updates the symlink to the current package.
  echo "  Linking token-tally CLI globally…"
  (cd "${repo_root}/store" && pnpm link --global --silent) 2>&1 | sed 's/^/    /' || {
    err "pnpm link --global failed"
    err "  If using a managed node version, ensure pnpm's global bin is in PATH."
    return 1
  }
  info "token-tally CLI linked"

  # ---- Verify the CLI is reachable ----
  if ! command -v token-tally &>/dev/null; then
    warn "token-tally not found in PATH after linking."
    warn "Add '$(pnpm bin -g)' to your PATH in ~/.zshrc or ~/.bash_profile."
    warn "Continuing — 'make doctor' will recheck this."
    # Not fatal: the user can add it to PATH later; migration below uses the node path.
  fi

  # ---- Create or migrate the central database ----
  local db_path="${data_dir}/events.db"
  mkdir -p "${data_dir}"
  echo "  Migrating database at ${db_path}…"

  # Invoke via node directly in case token-tally isn't in PATH yet.
  if node "${repo_root}/store/bin/token-tally.js" migrate --db "${db_path}"; then
    info "Database ready at ${db_path}"
  else
    err "Database migration failed"
    return 1
  fi
}

main "$@"
