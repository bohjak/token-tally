#!/usr/bin/env bash
# scripts/doctor.sh — Diagnostic check for all installed ToTally components.
#
# Checks:
#   1. token-tally CLI: available in PATH and reports healthy database.
#   2. Tray app:        /Applications/ToTally.app exists.
#   3. Pi extensions:   ~/.pi/agent/extensions/token-tally-{writer,usage} point
#                       to the correct repo paths.
#   4. Claude Code:     hook binary and ~/.claude/settings.json entries.
#   5. Install manifest: present and parseable.
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
TOKEN_TALLY_STATE_DIR="${XDG_STATE_HOME:-${HOME}/.local/state}/token-tally"
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

check_claude_code() {
  section "Claude Code hooks"

  local claude_dir="${HOME}/.claude"
  local hook_link="${HOME}/.local/bin/token-tally-claude-hook"
  local settings_path="${claude_dir}/settings.json"

  if [[ ! -d "${claude_dir}" ]]; then
    warn "Claude Code settings directory not found (${claude_dir})"
    warn "Install or run Claude Code first, then re-run 'make install'"
    return
  fi

  if command -v claude &>/dev/null; then
    local version
    version=$(claude --version 2>/dev/null | head -n 1) || version="(unknown)"
    pass "claude CLI found at $(command -v claude) (${version:-unknown})"
  else
    warn "claude CLI not found in PATH"
  fi

  if [[ -L "${hook_link}" ]]; then
    local target
    target=$(readlink "${hook_link}")
    if [[ -e "${target}" ]]; then
      pass "token-tally-claude-hook symlink ok (→ ${target})"
    else
      fail "token-tally-claude-hook target missing (${target})"
    fi
  elif [[ -e "${hook_link}" ]]; then
    fail "${hook_link} exists but is not a symlink — unexpected state"
  else
    fail "token-tally-claude-hook not installed at ${hook_link}"
  fi

  if [[ ! -f "${settings_path}" ]]; then
    fail "Claude Code settings not found at ${settings_path}"
  else
    local settings_status
    settings_status=$(TT_CC_SETTINGS_PATH="${settings_path}" python3 - <<'PY'
import json
import os
from pathlib import Path

settings_path = Path(os.environ["TT_CC_SETTINGS_PATH"])
events = [
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "SubagentStop",
]
try:
    with settings_path.open() as f:
        data = json.load(f)
except Exception as exc:
    print(f"ERROR:settings JSON could not be parsed: {exc}")
    raise SystemExit(0)

hooks_root = data.get("hooks") if isinstance(data, dict) else None
if not isinstance(hooks_root, dict):
    print("ERROR:settings JSON has no hooks object")
    raise SystemExit(0)

missing = []
for event in events:
    found = False
    matchers = hooks_root.get(event, [])
    if isinstance(matchers, list):
        for matcher in matchers:
            if not isinstance(matcher, dict):
                continue
            hook_entries = matcher.get("hooks", [])
            if not isinstance(hook_entries, list):
                continue
            for hook in hook_entries:
                if not isinstance(hook, dict):
                    continue
                command = hook.get("command")
                if isinstance(command, str) and command.startswith("token-tally-claude-hook"):
                    found = True
    if not found:
        missing.append(event)

if missing:
    print("WARN:" + ",".join(missing))
else:
    print("OK")
PY
)
    case "${settings_status}" in
      OK) pass "Claude Code settings contain all ToTally hooks" ;;
      WARN:*) warn "Claude Code settings missing ToTally hooks: ${settings_status#WARN:}" ;;
      ERROR:*) fail "${settings_status#ERROR:}" ;;
      *) warn "Unexpected Claude Code settings check output: ${settings_status}" ;;
    esac
  fi

  local db_path="${TOKEN_TALLY_DATA_DIR}/events.db"
  if [[ -f "${db_path}" ]] && command -v sqlite3 &>/dev/null; then
    local count
    count=$(sqlite3 "${db_path}" "SELECT COUNT(*) FROM harnesses WHERE name='claude-code';" 2>/dev/null) || count="0"
    if [[ "${count}" == "0" ]]; then
      warn "No claude-code rows seen yet in ${db_path}; run a Claude Code session to populate data"
    else
      pass "claude-code harness row present in database"
    fi
  fi

  local state_dir="${TOKEN_TALLY_STATE_DIR}/claude-code"
  if [[ -d "${state_dir}" ]]; then
    local stale_count
    stale_count=$(find "${state_dir}" -type f -name '*.json' -mtime +30 2>/dev/null | wc -l | tr -d ' ')
    if [[ "${stale_count}" != "0" ]]; then
      warn "${stale_count} stale Claude Code state file(s) older than 30 days in ${state_dir}"
    fi
  fi
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
  check_claude_code
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
