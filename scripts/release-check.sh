#!/usr/bin/env bash
# scripts/release-check.sh — Pre-release automated checks for ToTally.
#
# Runs all automated quality gates in order:
#   1. TypeScript typecheck (all workspace packages)
#   2. Store unit tests (pnpm --filter @token-tally/store test)
#   3. Swift build (clients/macos-tray)
#   4. Swift tests (clients/macos-tray)
#   5. shellcheck on installer scripts (if shellcheck is available)
#   6. Large performance fixture generation + Swift performance tests
#      (skipped if --skip-perf is passed or pnpm exec tsx is unavailable)
#
# FLAGS
#   --skip-perf    Skip large-fixture generation and Swift performance tests.
#   --help         Print this help and exit.
#
# EXIT CODES
#   0   all checks passed
#   1   one or more checks failed
set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve repo root
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ---------------------------------------------------------------------------
# Colour helpers
# ---------------------------------------------------------------------------

if [[ -t 1 ]]; then
  GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; RESET='\033[0m'
else
  GREEN=''; YELLOW=''; RED=''; BOLD=''; RESET=''
fi

pass()    { echo -e "  ${GREEN}✓${RESET}  $*"; }
warn()    { echo -e "  ${YELLOW}!${RESET}  $*"; ((WARN_COUNT++)) || true; }
fail()    { echo -e "  ${RED}✗${RESET}  $*"; ((FAIL_COUNT++)) || true; }
section() { echo -e "\n${BOLD}$*${RESET}"; }

WARN_COUNT=0
FAIL_COUNT=0

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

OPT_SKIP_PERF=false

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --skip-perf) OPT_SKIP_PERF=true ;;
      --help|-h)
        echo "Usage: scripts/release-check.sh [--skip-perf]"
        echo
        echo "  --skip-perf    Skip large-fixture generation and Swift performance tests"
        exit 0
        ;;
      *)
        echo "Unknown flag: $1" >&2
        exit 1
        ;;
    esac
    shift
  done
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Run a command and capture its exit code without triggering set -e.
# Prints pass/fail and returns the exit code.
run_check() {
  local label="$1"
  shift
  local exit_code=0
  # Run in subshell so set -e doesn't kill the parent on failure.
  if (cd "${REPO_ROOT}" && "$@") 2>&1; then
    pass "${label}"
  else
    exit_code=$?
    fail "${label} (exit ${exit_code})"
  fi
  return "${exit_code}"
}

# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------

check_typecheck() {
  section "TypeScript typecheck"

  # Build store declarations first. Fresh CI checkouts do not have store/dist,
  # and workspace consumers resolve @token-tally/store through package exports.
  if ! (cd "${REPO_ROOT}" && pnpm --filter @token-tally/store build 2>&1); then
    fail "store: build failed — cannot typecheck workspace consumers"
    return
  fi

  # Typecheck every workspace package.
  # Each package has a "typecheck" script in package.json; using it is preferred
  # over bare "tsc --noEmit" because some packages (e.g. clients/web-explorer)
  # have multiple tsconfigs covered by the script.
  local packages=(
    "store"
    "harnesses/pi/writer-extension"
    "harnesses/cursor/writer"
    "harnesses/claude-code/writer"
    "clients/pi-usage-command"
    "clients/web-explorer"
  )

  for pkg in "${packages[@]}"; do
    local pkg_dir="${REPO_ROOT}/${pkg}"
    if [[ ! -f "${pkg_dir}/tsconfig.json" ]]; then
      warn "${pkg}: no tsconfig.json — skipping typecheck"
      continue
    fi
    if (cd "${pkg_dir}" && pnpm run typecheck 2>&1); then
      pass "${pkg}: typecheck passed"
    else
      fail "${pkg}: typecheck failed"
    fi
  done
}

check_store_tests() {
  section "Store unit tests"
  # Build the store first so .js test files are current.
  if ! (cd "${REPO_ROOT}" && pnpm --filter @token-tally/store build 2>&1); then
    fail "store build failed — cannot run tests"
    return
  fi
  if (cd "${REPO_ROOT}" && pnpm --filter @token-tally/store test 2>&1); then
    pass "store tests: all passed"
  else
    fail "store tests: one or more tests failed"
  fi
}

check_swift_build() {
  section "Swift build"
  if (cd "${REPO_ROOT}" && swift build --package-path clients/macos-tray 2>&1); then
    pass "swift build: succeeded"
  else
    fail "swift build: failed"
  fi
}

check_swift_tests() {
  section "Swift tests"
  if ! xcrun --find xctest >/dev/null 2>&1; then
    fail "swift tests require full Xcode (xctest not found)"
    return
  fi

  # Run everything except PerformanceTests, which need the large fixture.
  # PerformanceTests are handled separately in check_perf.
  if (cd "${REPO_ROOT}" && swift test --package-path clients/macos-tray \
        --filter "AnalyticsQueriesTests|FormattersTests|AnalyticsTrayTests" \
        2>&1); then
    pass "swift tests: all passed"
  else
    fail "swift tests: one or more tests failed"
  fi
}

check_shellcheck() {
  section "shellcheck (shell script linting)"
  if ! command -v shellcheck &>/dev/null; then
    warn "shellcheck not found — skipping (install via 'brew install shellcheck')"
    return
  fi

  local shell_scripts
  # Find all .sh files under scripts/ — quote-safe expansion via mapfile.
  mapfile -t shell_scripts < <(find "${REPO_ROOT}/scripts" -name "*.sh" | sort)

  local any_failed=false
  for script in "${shell_scripts[@]}"; do
    local rel="${script#"${REPO_ROOT}/"}"
    if shellcheck --shell=bash "${script}" 2>&1; then
      pass "${rel}: shellcheck passed"
    else
      fail "${rel}: shellcheck reported issues"
      any_failed=true
    fi
  done

  if [[ "${any_failed}" == "false" ]]; then
    pass "shellcheck: all scripts clean"
  fi
}

check_pricing() {
  section "Pricing table drift check"

  if ! command -v pnpm &>/dev/null; then
    warn "pnpm not found — skipping pricing drift check"
    return
  fi

  if [[ ! -f "${REPO_ROOT}/scripts/generate-pricing.ts" ]]; then
    warn "scripts/generate-pricing.ts not found — skipping pricing drift check"
    return
  fi

  # --check fails when rates.json is out of sync with sources/ OR when any
  # source file has an asOf date older than 180 days.
  if (cd "${REPO_ROOT}" && pnpm exec tsx scripts/generate-pricing.ts --check 2>&1); then
    pass "pricing: rates.json is up to date and all sources are fresh"
  else
    fail "pricing: rates.json is out of sync or sources are stale. " \
      "Run 'pnpm exec tsx scripts/generate-pricing.ts' to regenerate and update asOf dates."
  fi
}

check_claude_code_writer_tests() {
  section "Claude Code writer tests"

  if ! command -v pnpm &>/dev/null; then
    warn "pnpm not found — skipping Claude Code writer tests"
    return
  fi

  local cc_writer_dir="${REPO_ROOT}/harnesses/claude-code/writer"
  if [[ ! -f "${cc_writer_dir}/package.json" ]]; then
    warn "Claude Code writer package not found at harnesses/claude-code/writer — skipping"
    return
  fi

  if ! (cd "${REPO_ROOT}" && pnpm --filter @token-tally/claude-code-writer build 2>&1); then
    fail "Claude Code writer: build failed — cannot run tests"
    return
  fi

  if (cd "${REPO_ROOT}" && pnpm --filter @token-tally/claude-code-writer test 2>&1); then
    pass "Claude Code writer tests: all passed"
  else
    fail "Claude Code writer tests: one or more tests failed"
  fi
}

check_cursor_writer_tests() {
  section "Cursor writer tests"

  if ! command -v pnpm &>/dev/null; then
    warn "pnpm not found — skipping Cursor writer tests"
    return
  fi

  local cursor_writer_dir="${REPO_ROOT}/harnesses/cursor/writer"
  if [[ ! -f "${cursor_writer_dir}/package.json" ]]; then
    warn "Cursor writer package not found at harnesses/cursor/writer — skipping"
    return
  fi

  # Build first so compiled .js test files are current. A missing main.ts
  # (expected until T4 is implemented) will surface as a build failure here.
  if ! (cd "${REPO_ROOT}" && pnpm --filter @token-tally/cursor-writer build 2>&1); then
    fail "Cursor writer: build failed — cannot run tests (T4 likely not yet implemented)"
    return
  fi

  if (cd "${REPO_ROOT}" && pnpm --filter @token-tally/cursor-writer test 2>&1); then
    pass "Cursor writer tests: all passed"
  else
    fail "Cursor writer tests: one or more tests failed"
  fi
}

check_perf() {
  section "Performance fixture + Swift performance tests"

  if [[ "${OPT_SKIP_PERF}" == "true" ]]; then
    warn "Skipping performance tests (--skip-perf)"
    return
  fi

  if ! command -v pnpm &>/dev/null; then
    warn "pnpm not found — skipping performance fixture generation"
    return
  fi

  local large_fixture="/tmp/token-tally-large.db"

  echo "  Generating large fixture (≈1 M rows) → ${large_fixture}"
  echo "  This takes ~30-60 s on a modern Mac…"

  if (cd "${REPO_ROOT}" && \
      pnpm exec tsx fixtures/generate-large-db.ts --out "${large_fixture}" 2>&1); then
    pass "large fixture generated: ${large_fixture}"
  else
    fail "large fixture generation failed"
    return
  fi

  echo "  Running Swift performance tests against ${large_fixture}…"
  if (cd "${REPO_ROOT}" && \
      swift test --package-path clients/macos-tray --filter PerformanceTests 2>&1); then
    pass "swift performance tests: passed"
  else
    fail "swift performance tests: failed"
  fi
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

print_summary() {
  echo
  echo "─────────────────────────────────────────────────"
  if [[ "${FAIL_COUNT}" -eq 0 && "${WARN_COUNT}" -eq 0 ]]; then
    echo -e "${GREEN}Release check PASSED.${RESET}  All ${FAIL_COUNT} failures, ${WARN_COUNT} warnings."
  elif [[ "${FAIL_COUNT}" -eq 0 ]]; then
    echo -e "${YELLOW}Release check passed with ${WARN_COUNT} warning(s).${RESET}"
  else
    echo -e "${RED}Release check FAILED: ${FAIL_COUNT} failure(s), ${WARN_COUNT} warning(s).${RESET}"
  fi
  echo "─────────────────────────────────────────────────"
  echo

  if [[ "${FAIL_COUNT}" -gt 0 ]]; then
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  parse_args "$@"

  echo -e "${BOLD}ToTally release check${RESET}"
  echo "  Repo: ${REPO_ROOT}"
  if [[ "${OPT_SKIP_PERF}" == "true" ]]; then
    echo "  Performance tests: skipped (--skip-perf)"
  fi

  check_typecheck
  check_store_tests
  check_swift_build
  check_swift_tests
  check_shellcheck
  check_pricing
  check_claude_code_writer_tests
  check_cursor_writer_tests
  check_perf

  print_summary
}

main "$@"
