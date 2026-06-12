#!/usr/bin/env bash
# scripts/check-schema-constants.sh — Verify Swift↔TS schema constant parity.
#
# The macOS tray app (Swift) and the store library (TypeScript) both define the
# same three schema-versioning constants.  If one side is bumped without the
# other, readers and writers fall out of step on degraded/too-new detection.
#
# Constants verified:
#   Swift: minSupportedSchemaVersion  ↔  TS: MIN_SUPPORTED_SCHEMA_VERSION
#   Swift: maxKnownSchemaVersion      ↔  TS: MAX_KNOWN_SCHEMA_VERSION
#   Swift: schemaForwardWindow        ↔  TS: SCHEMA_FORWARD_WINDOW
#
# Source files read — no build artifacts required:
#   clients/macos-tray/AnalyticsTray/Data/AnalyticsDatabase.swift
#   store/src/connection.ts
#
# Usage:
#   scripts/check-schema-constants.sh [<repo-root>]
#
#   <repo-root> is optional; when omitted the script auto-detects it from the
#   location of BASH_SOURCE.  scripts/release-check.sh passes REPO_ROOT
#   explicitly so it works regardless of the caller's working directory.
#
# Exit codes:  0 = constants match,  1 = mismatch or extraction error
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${1:-$(cd "${SCRIPT_DIR}/.." && pwd)}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Extract an integer constant from the first line matching PATTERN in FILE.
#
# Args:
#   $1  absolute path to the source file
#   $2  grep pattern that uniquely identifies the assignment line
#       (e.g. 'maxKnownSchemaVersion = '); the pattern should include ' = '
#       so the extracted value always comes after an assignment operator
#
# Prints the integer to stdout; returns 1 and writes a diagnostic to stderr
# if the pattern is not found or no integer follows the assignment.
extract_int() {
  local file="$1"
  local pattern="$2"

  # -m 1: stop after the first match so a name appearing in comments later
  # in the file does not produce a multi-line result.
  local match_line
  if ! match_line="$(grep -m 1 "${pattern}" "${file}" 2>/dev/null)"; then
    echo "ERROR: pattern '${pattern}' not found in ${file}" >&2
    return 1
  fi

  # Two-step extraction using bash parameter expansion (no subprocesses):
  #   1. Remove everything up to and including the first '= ' (the LHS).
  #   2. Remove everything from the first non-digit character onward
  #      (trailing comments like '// …', semicolons, etc.).
  local trimmed="${match_line#*= }"
  local value="${trimmed%%[!0-9]*}"

  if [[ ! "${value}" =~ ^[0-9]+$ ]]; then
    echo "ERROR: could not parse integer from line: ${match_line}" >&2
    return 1
  fi

  echo "${value}"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  local swift_file="${REPO_ROOT}/clients/macos-tray/AnalyticsTray/Data/AnalyticsDatabase.swift"
  local ts_file="${REPO_ROOT}/store/src/connection.ts"

  # Fail early with an actionable message rather than a confusing grep error.
  if [[ ! -f "${swift_file}" ]]; then
    echo "ERROR: Swift source not found: ${swift_file}" >&2
    exit 1
  fi
  if [[ ! -f "${ts_file}" ]]; then
    echo "ERROR: TypeScript source not found: ${ts_file}" >&2
    exit 1
  fi

  # Declare before assigning so that set -e can catch a non-zero return from
  # extract_int.  Combining `local var=$(cmd)` in one statement suppresses the
  # exit-code check in several bash versions because `local` is a builtin.
  local swift_min swift_max swift_window ts_min ts_max ts_window

  swift_min="$(extract_int "${swift_file}" 'minSupportedSchemaVersion = ')"
  swift_max="$(extract_int "${swift_file}" 'maxKnownSchemaVersion = ')"
  swift_window="$(extract_int "${swift_file}" 'schemaForwardWindow = ')"

  ts_min="$(extract_int "${ts_file}" 'MIN_SUPPORTED_SCHEMA_VERSION = ')"
  ts_max="$(extract_int "${ts_file}" 'MAX_KNOWN_SCHEMA_VERSION = ')"
  ts_window="$(extract_int "${ts_file}" 'SCHEMA_FORWARD_WINDOW = ')"

  # Collect ALL mismatches before exiting so every divergence is visible at once.
  local failed=false

  if [[ "${swift_min}" != "${ts_min}" ]]; then
    echo "MISMATCH: MIN_SUPPORTED_SCHEMA_VERSION  Swift=${swift_min}  TS=${ts_min}" >&2
    failed=true
  fi
  if [[ "${swift_max}" != "${ts_max}" ]]; then
    echo "MISMATCH: MAX_KNOWN_SCHEMA_VERSION      Swift=${swift_max}  TS=${ts_max}" >&2
    failed=true
  fi
  if [[ "${swift_window}" != "${ts_window}" ]]; then
    echo "MISMATCH: SCHEMA_FORWARD_WINDOW         Swift=${swift_window}  TS=${ts_window}" >&2
    failed=true
  fi

  if [[ "${failed}" == "true" ]]; then
    echo >&2
    echo "Update both source files to the same values before releasing:" >&2
    echo "  Swift: clients/macos-tray/AnalyticsTray/Data/AnalyticsDatabase.swift" >&2
    echo "     TS: store/src/connection.ts" >&2
    exit 1
  fi

  echo "Schema constants match: MIN_SUPPORTED=${ts_min}  MAX_KNOWN=${ts_max}  FORWARD_WINDOW=${ts_window}"
}

main "$@"
