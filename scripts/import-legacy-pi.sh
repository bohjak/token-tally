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

main() {
  exec token-tally import legacy-pi "$@"
}

main "$@"
