#!/usr/bin/env bash
# Thin shell wrapper for `token-tally import legacy-pi`.
#
# All arguments are forwarded to the CLI unchanged. Run with --help for
# the full argument reference.
#
# This script is a convenience alias. It is intentionally never called by
# the installer (scripts/install.sh) because the legacy import must always
# be an explicit user action. See PLAN.md § Legacy compatibility.
#
# Examples:
#   ./scripts/import-legacy-pi.sh
#   ./scripts/import-legacy-pi.sh --source /path/to/events.db
#   ./scripts/import-legacy-pi.sh --db /path/to/central.db
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

main() {
  # Prefer the globally-linked binary.
  if command -v token-tally &>/dev/null; then
    exec token-tally import legacy-pi "$@"
  fi

  # Fallback: invoke via node when the pnpm global bin is not yet in PATH
  # (e.g. immediately after 'make install' before the shell is reloaded).
  local fallback="${SCRIPT_DIR}/../store/bin/token-tally.js"
  if [[ -f "${fallback}" ]] && command -v node &>/dev/null; then
    exec node "${fallback}" import legacy-pi "$@"
  fi

  echo "Error: token-tally not found in PATH and node fallback unavailable." >&2
  echo "  Run 'make install' first, or add pnpm's global bin to PATH." >&2
  exit 1
}

main "$@"
