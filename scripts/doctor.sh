#!/usr/bin/env bash
# scripts/doctor.sh — Diagnostic check for all installed ToTally components.
#
# Checks:
#   1. token-tally CLI: available in PATH and reports healthy database.
#   2. Tray app:        /Applications/ToTally.app exists.
#   3. Pi extensions:   ~/.pi/agent/extensions/token-tally-{writer,usage} point
#                       to the correct repo paths.
#   4. Install manifest: present and parseable.
#
# Legacy Pi data is not checked here; use 'token-tally import legacy-pi'
# to migrate it into the central store.
#
# Exit codes:
#   0   all checks pass
#   1   one or more checks failed or produced warnings
set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve paths
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

TOKEN_TALLY_DATA_DIR="${XDG_DATA_HOME:-${HOME}/.local/share}/token-tally"
TOKEN_TALLY_CONFIG_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/token-tally"
MANIFEST_PATH="${TOKEN_TALLY_CONFIG_DIR}/install.json"

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
# Checks
# ---------------------------------------------------------------------------

check_store_cli() {
  section "Store CLI"

  # 1a. Binary reachable?
  # Use an array so that a node-path fallback with a space in it is never
  # subject to unquoted word splitting when the command is invoked.
  local -a cli_cmd
  if command -v token-tally &>/dev/null; then
    cli_cmd=(token-tally)
    pass "token-tally found at $(command -v token-tally)"
  else
    # Try via node directly as a fallback (e.g. PATH not yet updated).
    if [[ -f "${REPO_ROOT}/store/bin/token-tally.js" ]] && command -v node &>/dev/null; then
      cli_cmd=(node "${REPO_ROOT}/store/bin/token-tally.js")
      warn "token-tally not in PATH; falling back to node invocation"
      warn "Add '$(pnpm bin -g 2>/dev/null || echo "pnpm global bin")' to PATH"
    else
      fail "token-tally not found in PATH and node fallback unavailable"
      return
    fi
  fi

  # 1b. Run token-tally doctor against the default DB.
  local doctor_output doctor_status
  doctor_output=$("${cli_cmd[@]}" doctor --json 2>/dev/null) || true
  doctor_status=$(echo "${doctor_output}" | \
    python3 -c "import json,sys; print(json.load(sys.stdin).get('status','error'))" \
    2>/dev/null) || doctor_status="error"

  if [[ "${doctor_status}" == "ok" ]]; then
    pass "Database health: ok"
  elif [[ "${doctor_status}" == "warning" ]]; then
    warn "Database health: warning (run 'token-tally doctor' for details)"
  else
    fail "Database health: ${doctor_status}"
    # Print a snippet of what's wrong.
    echo "${doctor_output}" | \
      python3 -c "import json,sys; d=json.load(sys.stdin); \
        [print('    [' + f['severity'] + '] ' + f['message']) \
         for f in d.get('findings',[]) if f['severity'] in ('error','warning')]" \
      2>/dev/null || true
  fi
}

check_tray() {
  section "Tray app"
  local app_path="/Applications/ToTally.app"
  if [[ -d "${app_path}" ]]; then
    local version
    version=$(defaults read "${app_path}/Contents/Info" CFBundleShortVersionString \
      2>/dev/null) || version="(unknown)"
    pass "ToTally.app installed at ${app_path} (v${version})"
  else
    fail "ToTally.app not found at ${app_path}"
    fail "  Run 'make install' to install it."
  fi
}

check_pi_extensions() {
  section "Pi extensions"
  local pi_ext_dir="${HOME}/.pi/agent/extensions"

  if [[ ! -d "${pi_ext_dir}" ]]; then
    warn "Pi extensions directory not found (${pi_ext_dir})"
    warn "Install Pi first, then re-run 'make install'"
    return
  fi

  local all_ok=true
  for name in token-tally-writer token-tally-usage; do
    local link_path="${pi_ext_dir}/${name}"

    if [[ ! -e "${link_path}" && ! -L "${link_path}" ]]; then
      fail "${name}: not installed at ${link_path}"
      all_ok=false
      continue
    fi

    if [[ ! -L "${link_path}" ]]; then
      fail "${name}: exists but is not a symlink — unexpected state"
      all_ok=false
      continue
    fi

    local target
    target=$(readlink "${link_path}")
    if [[ ! -e "${target}" ]]; then
      fail "${name}: symlink target missing (${target})"
      all_ok=false
      continue
    fi

    pass "${name}: ok (→ ${target})"
  done
}

check_manifest() {
  section "Install manifest"
  if [[ ! -f "${MANIFEST_PATH}" ]]; then
    warn "Manifest not found at ${MANIFEST_PATH}"
    warn "Run 'make install' to create it."
    return
  fi

  local repo_path
  # Pass the path via env to avoid interpolating it into Python source code.
  repo_path=$(TT_MANIFEST_PATH="${MANIFEST_PATH}" python3 -c \
    "import json,os; d=json.load(open(os.environ['TT_MANIFEST_PATH'])); print(d.get('repoPath',''))" \
    2>/dev/null) || repo_path=""

  if [[ -z "${repo_path}" ]]; then
    warn "Manifest exists but could not be parsed"
  elif [[ "${repo_path}" != "${REPO_ROOT}" ]]; then
    warn "Manifest repoPath (${repo_path}) differs from current repo (${REPO_ROOT})"
    warn "Re-run 'make install' from this repo to update the manifest."
  else
    pass "Manifest found at ${MANIFEST_PATH}"
  fi
}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  section "ToTally doctor"
  echo "  Repo: ${REPO_ROOT}"

  check_store_cli
  check_tray
  check_pi_extensions
  check_manifest

  # Summary
  section "Result"
  if (( FAIL_COUNT > 0 )); then
    echo -e "  ${RED}${FAIL_COUNT} check(s) failed, ${WARN_COUNT} warning(s).${RESET}"
    echo    "  Run 'make install' to repair, or fix manually."
    exit 1
  elif (( WARN_COUNT > 0 )); then
    echo -e "  ${YELLOW}All checks passed with ${WARN_COUNT} warning(s).${RESET}"
    exit 0
  else
    echo -e "  ${GREEN}All checks passed.${RESET}"
    exit 0
  fi
}

main "$@"
