#!/usr/bin/env bash
# scripts/install.sh — ToTally idempotent installer orchestrator.
#
# Calls each component script in order. A failure in install-store.sh aborts
# the run (the store is the foundation every other component depends on).
# Failures in install-tray.sh, install-pi.sh, and install-claude-code.sh are
# reported but do NOT abort — the other components should still complete.
#
# This script is designed to be safe for `git pull && make install`.
# When run from a terminal, it opens a small interactive component picker. Use
# --all/--no-tui or set TOKEN_TALLY_INSTALL_NO_TUI=1 for unattended installs.
# Optional harness integrations are only offered when their harness is detected.
set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve repo root (the directory containing this script's parent)
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

for arg in "$@"; do
  case "${arg}" in
    --help|-h)
      cat <<'EOF'
Usage: scripts/install.sh [--all|--no-tui] [--help]

By default, an interactive component picker is shown when stdin/stdout are a
terminal. Non-interactive runs install the default component set; harness
integrations are skipped unless their harness is detected.

Options:
  --all, --no-tui   Skip the picker and use the default component set
  --help            Show this help

Environment:
  TOKEN_TALLY_INSTALL_NO_TUI=1   Skip the picker and use the default component set
EOF
      exit 0
      ;;
  esac
done

if ! command -v node &> /dev/null; then
  echo "✗  node not found. Install Node.js >= 24 to continue." >&2
  echo "   See: https://nodejs.org or use 'n lts'" >&2
  exit 1
fi

node_major="$(node -e "process.stdout.write(process.version.replace(/^v/,'').split('.')[0])")"
if (( node_major < 24 )); then
  echo "✗  Node.js >= 24 required; found v${node_major}. Use 'n lts' to upgrade." >&2
  exit 1
fi

# The TypeScript orchestrator only uses Node built-ins. Component installers
# verify and install their own dependencies when the selected install runs.
exec node "${REPO_ROOT}/scripts/install.mts" "$@"
