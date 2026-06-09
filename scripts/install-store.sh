#!/usr/bin/env bash
# scripts/install-store.sh — Build and install the token-tally CLI and central database.
#
# Responsibilities:
#   1. Install npm dependencies (pnpm install, idempotent).
#   2. Build the SEA (Single Executable Application) binary.
#   3. Install the binary to ~/.local/share/token-tally/bin/ and symlink it
#      into ~/.local/bin/ so it is reachable on PATH.
#   4. Create or migrate the central SQLite database.
#
# The SEA binary bundles a specific Node.js version, so the CLI is immune to
# Node version changes in the user's environment.  The native SQLite addon
# (better_sqlite3.node) cannot be embedded in the SEA blob and is distributed
# alongside the binary in the same directory.
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

  # ---- Build the SEA binary ----
  # build:sea runs tsc then esbuild + Node SEA tooling, producing:
  #   store/dist/sea/token-tally          — self-contained executable
  #   store/dist/sea/better_sqlite3.node  — native SQLite addon
  echo "  Building @token-tally/store SEA binary…"
  pnpm --filter @token-tally/store --dir "${repo_root}" build:sea 2>&1 | sed 's/^/    /' || {
    err "@token-tally/store build:sea failed"
    return 1
  }
  info "@token-tally/store SEA binary built"

  # ---- Install the SEA binary ----
  # Both the binary and the native addon must live in the same directory so
  # the bindings shim can locate the addon via path.dirname(process.execPath).
  local sea_dir
  sea_dir="${XDG_DATA_HOME:-${HOME}/.local/share}/token-tally/bin"
  mkdir -p "${sea_dir}"
  cp "${repo_root}/store/dist/sea/token-tally" "${sea_dir}/token-tally"
  cp "${repo_root}/store/dist/sea/better_sqlite3.node" "${sea_dir}/better_sqlite3.node"
  chmod +x "${sea_dir}/token-tally"
  info "SEA binary installed to ${sea_dir}/"

  # ---- Symlink into ~/.local/bin ----
  local local_bin="${HOME}/.local/bin"
  mkdir -p "${local_bin}"
  ln -sf "${sea_dir}/token-tally" "${local_bin}/token-tally"
  info "token-tally symlinked at ${local_bin}/token-tally"

  # ---- Verify the CLI is reachable ----
  if ! command -v token-tally &>/dev/null; then
    warn "token-tally not found in PATH."
    warn "Add '${local_bin}' to your PATH in ~/.zshrc or ~/.bash_profile:"
    warn "  export PATH=\"\${HOME}/.local/bin:\${PATH}\""
    warn "Continuing — 'make doctor' will recheck this."
    # Not fatal: the user can add it to PATH later; migration below uses the full path.
  fi

  # ---- Create or migrate the central database ----
  local db_path="${data_dir}/events.db"
  mkdir -p "${data_dir}"
  echo "  Migrating database at ${db_path}…"

  # Invoke via full path in case token-tally isn't in PATH yet.
  if "${sea_dir}/token-tally" migrate --db "${db_path}"; then
    info "Database ready at ${db_path}"
  else
    err "Database migration failed"
    return 1
  fi
}

main "$@"
