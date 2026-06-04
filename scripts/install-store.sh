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

pnpm_home_ownership_root() {
  local bin_dir="${1:?bin_dir is required}"
  local rel top
  rel="${bin_dir#"${HOME}/"}"
  top="${rel%%/*}"
  printf '%s/%s' "${HOME}" "${top}"
}

ensure_pnpm_global_bin_writable() {
  local bin_dir
  bin_dir=$(pnpm bin -g 2>/dev/null || true)

  # pnpm will print its own detailed setup error during global installs if
  # the global bin has not been configured. When it is configured, fail early
  # with a clearer permissions diagnosis than pnpm's raw EACCES stack trace.
  if [[ -z "${bin_dir}" ]]; then
    return 0
  fi

  if ! mkdir -p "${bin_dir}" 2>/dev/null; then
    err "Cannot create pnpm global bin directory: ${bin_dir}"
    if [[ "${bin_dir}" == "${HOME}/"* ]]; then
      local ownership_root
      ownership_root=$(pnpm_home_ownership_root "${bin_dir}")
      err "  A parent directory under your home is not writable by $(id -un)."
      err "  Fix ownership, then re-run make install:"
      err "    sudo chown -R \"$(id -un):$(id -gn)\" \"${ownership_root}\""
    else
      err "  Make this directory writable, or reconfigure pnpm's global bin."
    fi
    return 1
  fi

  if [[ ! -w "${bin_dir}" ]]; then
    err "pnpm global bin directory is not writable: ${bin_dir}"
    if [[ "${bin_dir}" == "${HOME}/"* ]]; then
      local ownership_root
      ownership_root=$(pnpm_home_ownership_root "${bin_dir}")
      err "  Fix ownership, then re-run make install:"
      err "    sudo chown -R \"$(id -un):$(id -gn)\" \"${ownership_root}\""
    else
      err "  Make this directory writable, or reconfigure pnpm's global bin."
    fi
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  local repo_root="${1:?REPO_ROOT is required}"
  local data_dir="${2:?DATA_DIR is required}"

  # ---- Verify Node and pnpm are available ----
  if ! command -v node &>/dev/null; then
    err "node not found. Install Node.js >= 24 to continue."
    err "  See: https://nodejs.org or use 'n' (n lts)"
    return 1
  fi

  if ! command -v pnpm &>/dev/null; then
    err "pnpm not found. Install it with: npm install -g pnpm"
    return 1
  fi

  local node_major
  node_major=$(node -e "process.stdout.write(process.version.replace(/^v/,'').split('.')[0])")
  if (( node_major < 24 )); then
    err "Node.js >= 24 required; found v${node_major}. Use 'n lts' to upgrade."
    return 1
  fi

  ensure_pnpm_global_bin_writable || return 1

  # ---- Install pnpm workspace dependencies ----
  # --frozen-lockfile ensures no accidental lockfile mutation during install.
  # We do NOT pipe through sed so that native-addon postinstall output reaches
  # the terminal unfiltered (hidden output can mask build failures).
  echo "  Installing npm dependencies…"
  pnpm install --dir "${repo_root}" --frozen-lockfile || {
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
  # pnpm 11 requires `pnpm link` to receive a target directory, so install the
  # local package globally instead. This makes `token-tally` available in $PATH
  # via pnpm's global bin dir and is idempotent for local development installs.
  echo "  Linking token-tally CLI globally…"
  pnpm add --global "${repo_root}/store" --silent 2>&1 | sed 's/^/    /' || {
    err "pnpm add --global failed"
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
