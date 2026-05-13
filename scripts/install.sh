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

# ---------------------------------------------------------------------------
# Colour helpers (no-ops when stdout is not a tty)
# ---------------------------------------------------------------------------

if [[ -t 1 ]]; then
  GRAY='\033[90m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  RED='\033[0;31m'
  BOLD='\033[1m'
  RESET='\033[0m'
else
  GRAY=''
  GREEN=''
  YELLOW=''
  RED=''
  BOLD=''
  RESET=''
fi

info() { echo -e "  ${GREEN}✓${RESET}  $*"; }
warn() { echo -e "  ${YELLOW}!${RESET}  $*"; }
err() { echo -e "  ${RED}✗${RESET}  $*"; }
section() { echo -e "\n${BOLD}$*${RESET}"; }

# ---------------------------------------------------------------------------
# XDG-aware directory creation
# ---------------------------------------------------------------------------

# Honour XDG env vars used by the store package's paths.ts. These must stay in
# sync with defaultDataDir / defaultConfigDir / defaultStateDir in store/src/paths.ts.
TOKEN_TALLY_DATA_DIR="${XDG_DATA_HOME:-${HOME}/.local/share}/token-tally"
TOKEN_TALLY_CONFIG_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/token-tally"
TOKEN_TALLY_STATE_DIR="${XDG_STATE_HOME:-${HOME}/.local/state}/token-tally"

create_dirs() {
  mkdir -p \
    "${TOKEN_TALLY_DATA_DIR}" \
    "${TOKEN_TALLY_DATA_DIR}/spool" \
    "${TOKEN_TALLY_CONFIG_DIR}" \
    "${TOKEN_TALLY_STATE_DIR}/logs"
}

# ---------------------------------------------------------------------------
# Interactive component picker
# ---------------------------------------------------------------------------

INSTALL_TRAY=true
INSTALL_PI=true
INSTALL_PI_AVAILABLE=true
INSTALL_CLAUDE_CODE=true
INSTALL_CLAUDE_CODE_AVAILABLE=true
INSTALL_CURSOR=true
INSTALL_CURSOR_AVAILABLE=true
INSTALL_USE_TUI=true

usage() {
  cat << 'EOF'
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
}

parse_args() {
  local arg
  for arg in "$@"; do
    case "${arg}" in
    --all | --no-tui | --yes | -y)
      INSTALL_USE_TUI=false
      ;;
    --help | -h)
      usage
      exit 0
      ;;
    *)
      err "Unknown option: ${arg}"
      usage
      exit 2
      ;;
    esac
  done

  if [[ "${TOKEN_TALLY_INSTALL_NO_TUI:-}" == "1" ]]; then
    INSTALL_USE_TUI=false
  fi

  if [[ ! -t 0 || ! -t 1 ]]; then
    INSTALL_USE_TUI=false
  fi
}

pi_is_present() {
  [[ -d "${HOME}/.pi/agent/extensions" ]]
}

claude_code_is_present() {
  command -v claude &> /dev/null || [[ -d "${HOME}/.claude" ]]
}

cursor_is_present() {
  command -v cursor &> /dev/null ||
    [[ -d "${HOME}/.cursor" ]] ||
    [[ -d "${HOME}/Library/Application Support/Cursor" ]] ||
    [[ -d "/Applications/Cursor.app" ]] ||
    [[ -d "${HOME}/Applications/Cursor.app" ]]
}

apply_presence_defaults() {
  if ! pi_is_present; then
    INSTALL_PI=false
    INSTALL_PI_AVAILABLE=false
  fi

  if ! claude_code_is_present; then
    INSTALL_CLAUDE_CODE=false
    INSTALL_CLAUDE_CODE_AVAILABLE=false
  fi

  if ! cursor_is_present; then
    INSTALL_CURSOR=false
    INSTALL_CURSOR_AVAILABLE=false
  fi
}

component_enabled_label() {
  local enabled="$1"
  local available="${2:-true}"
  if [[ "${available}" != "true" ]]; then
    printf "${YELLOW}not detected${RESET}"
  elif [[ "${enabled}" == "true" ]]; then
    printf "${GREEN}selected${RESET}"
  else
    printf "${YELLOW}skipped${RESET}"
  fi
}

required_label() {
  printf "${GRAY}required${RESET}"
}

checkbox() {
  local enabled="$1"
  if [[ "${enabled}" == "true" ]]; then
    printf "[x]"
  else
    printf "[ ]"
  fi
}

render_component_picker() {
  local selected_index="$1"
  local row_prefix

  printf '\033[H\033[2J'
  section "ToTally installer"
  echo "  Repo: ${REPO_ROOT}"
  echo
  echo "  Choose optional components. Store & CLI is required and will always run."
  echo "  Controls: ↑/↓ move, Space toggle, Enter install, q cancel"
  echo

  row_prefix="  "
  printf "%s%s Store & CLI       %s  token-tally CLI + ${TOKEN_TALLY_DATA_DIR}/events.db\n" \
    "${row_prefix}" "$(checkbox 'true')" "$(required_label)"

  row_prefix="  "
  [[ "${selected_index}" == "0" ]] && row_prefix="› "
  printf "%s%s Tray app          %s  /Applications/ToTally.app\n" \
    "${row_prefix}" "$(checkbox "${INSTALL_TRAY}")" "$(component_enabled_label "${INSTALL_TRAY}")"

  row_prefix="  "
  [[ "${selected_index}" == "1" ]] && row_prefix="› "
  printf "%s%s Pi integration    %s  ~/.pi/agent/extensions/token-tally-*\n" \
    "${row_prefix}" "$(checkbox "${INSTALL_PI}")" "$(component_enabled_label "${INSTALL_PI}" "${INSTALL_PI_AVAILABLE}")"

  row_prefix="  "
  [[ "${selected_index}" == "2" ]] && row_prefix="› "
  printf "%s%s Claude Code       %s  ~/.claude/settings.json hooks\n" \
    "${row_prefix}" "$(checkbox "${INSTALL_CLAUDE_CODE}")" "$(component_enabled_label "${INSTALL_CLAUDE_CODE}" "${INSTALL_CLAUDE_CODE_AVAILABLE}")"

  row_prefix="  "
  [[ "${selected_index}" == "3" ]] && row_prefix="› "
  printf "%s%s Cursor            %s  ~/.cursor/hooks.json hooks\n" \
    "${row_prefix}" "$(checkbox "${INSTALL_CURSOR}")" "$(component_enabled_label "${INSTALL_CURSOR}" "${INSTALL_CURSOR_AVAILABLE}")"

  echo
  row_prefix="  "
  [[ "${selected_index}" == "4" ]] && row_prefix="› "
  printf "%sInstall selected components\n" "${row_prefix}"

  row_prefix="  "
  [[ "${selected_index}" == "5" ]] && row_prefix="› "
  printf "%sCancel\n" "${row_prefix}"
}

prompt_component_selection() {
  if [[ "${INSTALL_USE_TUI}" != "true" ]]; then
    return 0
  fi

  local selected_index=0
  local key rest

  while true; do
    render_component_picker "${selected_index}"
    IFS= read -rsn1 key || return 1

    if [[ "${key}" == $'\x1b' ]]; then
      IFS= read -rsn2 -t 0.1 rest || rest=""
      case "${rest}" in
      "[A")
        if ((selected_index > 0)); then
          selected_index=$((selected_index - 1))
        fi
        ;;
      "[B")
        if ((selected_index < 5)); then
          selected_index=$((selected_index + 1))
        fi
        ;;
      esac
      continue
    fi

    case "${key}" in
    " ")
      case "${selected_index}" in
      0) [[ "${INSTALL_TRAY}" == "true" ]] && INSTALL_TRAY=false || INSTALL_TRAY=true ;;
      1)
        if [[ "${INSTALL_PI_AVAILABLE}" == "true" ]]; then
          [[ "${INSTALL_PI}" == "true" ]] && INSTALL_PI=false || INSTALL_PI=true
        fi
        ;;
      2)
        if [[ "${INSTALL_CLAUDE_CODE_AVAILABLE}" == "true" ]]; then
          [[ "${INSTALL_CLAUDE_CODE}" == "true" ]] && INSTALL_CLAUDE_CODE=false || INSTALL_CLAUDE_CODE=true
        fi
        ;;
      3)
        if [[ "${INSTALL_CURSOR_AVAILABLE}" == "true" ]]; then
          [[ "${INSTALL_CURSOR}" == "true" ]] && INSTALL_CURSOR=false || INSTALL_CURSOR=true
        fi
        ;;
      esac
      ;;
    "" | $'\n' | $'\r')
      if [[ "${selected_index}" == "5" ]]; then
        echo
        warn "Install cancelled"
        exit 130
      fi
      break
      ;;
    q | Q)
      echo
      warn "Install cancelled"
      exit 130
      ;;
    esac
  done

  printf '\033[H\033[2J'
}

print_component_plan() {
  echo "  Components:"
  echo "    store   $(required_label)" echo "    tray    $(component_enabled_label "${INSTALL_TRAY}")"
  echo "    pi      $(component_enabled_label "${INSTALL_PI}" "${INSTALL_PI_AVAILABLE}")"
  echo "    claude  $(component_enabled_label "${INSTALL_CLAUDE_CODE}" "${INSTALL_CLAUDE_CODE_AVAILABLE}")"
  echo "    cursor  $(component_enabled_label "${INSTALL_CURSOR}" "${INSTALL_CURSOR_AVAILABLE}")"
}

# ---------------------------------------------------------------------------
# Read/write the install manifest
# ---------------------------------------------------------------------------

MANIFEST_PATH="${TOKEN_TALLY_CONFIG_DIR}/install.json"

# Read an existing installedAt timestamp so we can preserve it on updates.
# Falls back to the current epoch-ms if the manifest is absent or malformed.
read_installed_at() {
  local ts
  if [[ -f "${MANIFEST_PATH}" ]] && command -v python3 &> /dev/null; then
    # Pass the path via env to avoid shell interpolation into Python source.
    ts=$(TT_MANIFEST_PATH="${MANIFEST_PATH}" python3 -c \
      "import json,os; d=json.load(open(os.environ['TT_MANIFEST_PATH'])); print(d.get('installedAt',''))" \
      2> /dev/null) || ts=""
    if [[ "${ts}" =~ ^[0-9]+$ ]]; then
      echo "${ts}"
      return
    fi
  fi
  # Fallback: current time in milliseconds
  echo $(($(date +%s) * 1000))
}

write_manifest() {
  local installed_at="$1"
  local updated_at="$2"
  local store_ok="$3" # true|false
  local store_db_path="$4"
  local store_schema_ver="$5"
  local tray_ok="$6" # true|false
  local tray_version="$7"
  local pi_ok="$8" # true|false
  local pi_writer_path="$9"
  local pi_usage_path="${10}"
  local claude_code_ok="${11}" # true|false
  local claude_code_hook_path="${12}"
  local claude_code_settings_path="${13}"
  local claude_code_version="${14}"
  local cursor_ok="${15}" # true|false
  local cursor_hook_path="${16}"
  local cursor_hooks_path="${17}"

  # All values are passed via the environment so that paths with special
  # characters or spaces never get interpolated into Python source code.
  # The heredoc uses a quoted delimiter (<<'PY') to prevent any shell
  # expansion inside the Python script.
  TT_MANIFEST_PATH="${MANIFEST_PATH}" \
    TT_REPO_ROOT="${REPO_ROOT}" \
    TT_INSTALLED_AT="${installed_at}" \
    TT_UPDATED_AT="${updated_at}" \
    TT_STORE_OK="${store_ok}" \
    TT_STORE_DB_PATH="${store_db_path}" \
    TT_STORE_SCHEMA_VER="${store_schema_ver}" \
    TT_TRAY_OK="${tray_ok}" \
    TT_TRAY_VERSION="${tray_version}" \
    TT_PI_OK="${pi_ok}" \
    TT_PI_WRITER_PATH="${pi_writer_path}" \
    TT_PI_USAGE_PATH="${pi_usage_path}" \
    TT_CC_OK="${claude_code_ok}" \
    TT_CC_HOOK_PATH="${claude_code_hook_path}" \
    TT_CC_SETTINGS_PATH="${claude_code_settings_path}" \
    TT_CC_VERSION="${claude_code_version}" \
    TT_CURSOR_OK="${cursor_ok}" \
    TT_CURSOR_HOOK_PATH="${cursor_hook_path}" \
    TT_CURSOR_HOOKS_PATH="${cursor_hooks_path}" \
    python3 - << 'PY'
import json, os

def e(k): return os.environ[k]
def b(k): return e(k) == "true"

schema_raw = e("TT_STORE_SCHEMA_VER")
schema_ver = int(schema_raw) if schema_raw.isdigit() else 0

pi_block = (
    {
        "installed": True,
        "writerExtensionPath": e("TT_PI_WRITER_PATH"),
        "usageCommandPath":    e("TT_PI_USAGE_PATH"),
    }
    if b("TT_PI_OK")
    else {"installed": False, "reason": "Pi not detected or install failed"}
)

claude_code_block = (
    {
        "installed": True,
        "hookBinPath": e("TT_CC_HOOK_PATH"),
        "settingsPath": e("TT_CC_SETTINGS_PATH"),
        "version": e("TT_CC_VERSION"),
    }
    if b("TT_CC_OK")
    else {"installed": False, "reason": "Claude Code not detected or install failed"}
)

cursor_block = (
    {
        "installed": True,
        "hookBinPath":   e("TT_CURSOR_HOOK_PATH"),
        "hooksJsonPath": e("TT_CURSOR_HOOKS_PATH"),
    }
    if b("TT_CURSOR_OK")
    else {"installed": False, "reason": "Cursor not detected or install skipped"}
)

data = {
    "repoPath":    e("TT_REPO_ROOT"),
    "installedAt": int(e("TT_INSTALLED_AT")),
    "updatedAt":   int(e("TT_UPDATED_AT")),
    "components": {
        "store": {
            "installed":     b("TT_STORE_OK"),
            "databasePath":  e("TT_STORE_DB_PATH"),
            "schemaVersion": schema_ver,
        },
        "tray": {
            "installed": b("TT_TRAY_OK"),
            "path":      "/Applications/ToTally.app",
            "version":   e("TT_TRAY_VERSION"),
        },
        "pi": pi_block,
        "claudeCode": claude_code_block,
        "cursor": cursor_block,
    },
}
manifest_path = e("TT_MANIFEST_PATH")
os.makedirs(os.path.dirname(manifest_path), exist_ok=True)
with open(manifest_path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  parse_args "$@"
  apply_presence_defaults
  prompt_component_selection

  section "ToTally installer"
  echo "  Repo: ${REPO_ROOT}"
  print_component_plan

  # ---- Pre-flight: create directories ----
  create_dirs
  info "Directories created (data, config, state)"

  # Track component outcomes for the final summary.
  local store_ok=false tray_ok=false pi_ok=false claude_code_ok=false
  local store_db_path="${TOKEN_TALLY_DATA_DIR}/events.db"
  local store_schema_ver=0
  local tray_version="unknown"
  local pi_writer_path="${HOME}/.pi/agent/extensions/token-tally-writer"
  local pi_usage_path="${HOME}/.pi/agent/extensions/token-tally-usage"
  local claude_code_hook_path="${HOME}/.local/bin/token-tally-claude-hook"
  local claude_code_settings_path="${HOME}/.claude/settings.json"
  local claude_code_version="unknown"
  local tray_error_msg="" pi_error_msg="" claude_code_error_msg=""
  local pi_skipped=false claude_code_skipped=false

  # ---- Pricing table (must run before harness builders) -------------------
  # Regenerates store/src/pricing/rates.json from curated pricing-sources/*.yaml.
  # The Cursor writer (and future harness builds) embed rates.json at compile
  # time, so this must succeed before any harness installer runs.
  # - Exits non-zero only on malformed/missing source data → abort install.
  # - Stale asOf dates produce console warnings but do not abort; the
  #   stricter --check mode is reserved for release-check.sh.
  section "Pricing table"
  if [[ -f "${REPO_ROOT}/scripts/generate-pricing.ts" ]]; then
    if (cd "${REPO_ROOT}" && pnpm exec tsx scripts/generate-pricing.ts 2>&1); then
      info "Pricing table up to date (store/src/pricing/rates.json)"
    else
      err "Pricing table generation failed — aborting"
      exit 1
    fi
  else
    warn "scripts/generate-pricing.ts not found — skipping pricing table generation"
  fi

  # ---- Store (abort on failure — it's the foundation) ----
  section "Store & CLI"
  if "${SCRIPT_DIR}/install-store.sh" "${REPO_ROOT}" "${TOKEN_TALLY_DATA_DIR}"; then
    store_ok=true
    info "Store installed and database migrated"
    # Extract schema version from doctor output (best-effort; 0 if unavailable).
    if command -v token-tally &> /dev/null; then
      local doctor_json
      doctor_json=$(token-tally doctor --json 2> /dev/null) || true
      if [[ -n "${doctor_json}" ]]; then
        store_schema_ver=$(echo "${doctor_json}" |
          python3 -c "import json,sys; d=json.load(sys.stdin); \
            [print(f['detail']['version']) for f in d['findings'] if f['code']=='schema_ok']" \
            2> /dev/null) || store_schema_ver=1
        store_schema_ver=${store_schema_ver:-1}
      fi
    fi
  else
    err "Store install failed — aborting"
    exit 1
  fi

  # ---- Tray (report failure, continue) ----
  section "macOS Tray"
  if [[ "${INSTALL_TRAY}" == "true" ]]; then
    if "${SCRIPT_DIR}/install-tray.sh" "${REPO_ROOT}"; then
      tray_ok=true
      tray_version=$(defaults read /Applications/ToTally.app/Contents/Info \
        CFBundleShortVersionString 2> /dev/null) || tray_version="0.1.0"
      info "ToTally.app installed to /Applications/ToTally.app"
    else
      tray_error_msg="Tray install failed — check output above"
      warn "${tray_error_msg}"
    fi
  else
    tray_error_msg="Tray install skipped by user"
    warn "${tray_error_msg}"
  fi

  # ---- Pi integration (report failure, continue) ----
  section "Pi integration"
  if [[ "${INSTALL_PI}" == "true" ]]; then
    if "${SCRIPT_DIR}/install-pi.sh" "${REPO_ROOT}"; then
      pi_ok=true
      info "Pi writer and usage extensions symlinked"
    else
      pi_error_msg="Pi install failed or Pi not detected — check output above"
      warn "${pi_error_msg}"
    fi
  else
    pi_skipped=true
    if [[ "${INSTALL_PI_AVAILABLE}" == "true" ]]; then
      pi_error_msg="Pi install skipped by user"
    else
      pi_error_msg="Pi not detected — skipping integration"
    fi
    warn "${pi_error_msg}"
  fi

  # ---- Claude Code integration (report failure, continue) ----
  section "Claude Code integration"
  if [[ "${INSTALL_CLAUDE_CODE}" == "true" ]]; then
    if command -v claude &> /dev/null; then
      claude_code_version=$(claude --version 2> /dev/null | head -n 1) || claude_code_version="unknown"
      claude_code_version=${claude_code_version:-unknown}
    fi
    if "${SCRIPT_DIR}/install-claude-code.sh" "${REPO_ROOT}"; then
      claude_code_ok=true
      info "Claude Code hooks installed"
    else
      claude_code_error_msg="Claude Code install failed or Claude Code not detected — check output above"
      warn "${claude_code_error_msg}"
    fi
  else
    claude_code_skipped=true
    if [[ "${INSTALL_CLAUDE_CODE_AVAILABLE}" == "true" ]]; then
      claude_code_error_msg="Claude Code install skipped by user"
    else
      claude_code_error_msg="Claude Code not detected — skipping hooks"
    fi
    warn "${claude_code_error_msg}"
  fi

  # ---- Cursor integration (report failure, continue) ----
  # Cursor is disabled before the picker when the app/config/CLI is absent, so
  # installs on machines without Cursor skip this section without building or
  # writing hook config.
  section "Cursor integration"
  local cursor_ok=false cursor_skipped=false cursor_error_msg=""
  local cursor_hook_path="${HOME}/.local/bin/token-tally-cursor-hook"
  local cursor_hooks_path="${HOME}/.cursor/hooks.json"

  if [[ "${INSTALL_CURSOR}" == "true" ]]; then
    if "${SCRIPT_DIR}/install-cursor.sh" "${REPO_ROOT}"; then
      cursor_ok=true
      info "Cursor hooks installed"
    else
      cursor_error_msg="Cursor install failed — check output above"
      warn "${cursor_error_msg}"
    fi
  else
    cursor_skipped=true
    if [[ "${INSTALL_CURSOR_AVAILABLE}" == "true" ]]; then
      cursor_error_msg="Cursor install skipped by user"
    else
      cursor_error_msg="Cursor not detected — skipping hooks"
    fi
    warn "${cursor_error_msg}"
  fi

  # ---- Manifest ----
  section "Install manifest"
  local installed_at updated_at
  installed_at=$(read_installed_at)
  updated_at=$(($(date +%s) * 1000))

  write_manifest \
    "${installed_at}" "${updated_at}" \
    "${store_ok}" "${store_db_path}" "${store_schema_ver}" \
    "${tray_ok}" "${tray_version}" \
    "${pi_ok}" "${pi_writer_path}" "${pi_usage_path}" \
    "${claude_code_ok}" "${claude_code_hook_path}" "${claude_code_settings_path}" "${claude_code_version}" \
    "${cursor_ok}" "${cursor_hook_path}" "${cursor_hooks_path}"
  info "Manifest written to ${MANIFEST_PATH}"

  # ---- Summary ----
  section "Summary"
  local store_label tray_label pi_label claude_code_label cursor_label
  [[ "${store_ok}" == "true" ]] && store_label="${GREEN}ok${RESET}" || store_label="${RED}failed${RESET}"
  [[ "${tray_ok}" == "true" ]] && tray_label="${GREEN}ok${RESET}" || tray_label="${YELLOW}failed${RESET}"
  if [[ "${pi_ok}" == "true" ]]; then
    pi_label="${GREEN}ok${RESET}"
  elif [[ "${pi_skipped}" == "true" ]]; then
    pi_label="${YELLOW}skipped${RESET}"
  else
    pi_label="${YELLOW}failed${RESET}"
  fi
  if [[ "${claude_code_ok}" == "true" ]]; then
    claude_code_label="${GREEN}ok${RESET}"
  elif [[ "${claude_code_skipped}" == "true" ]]; then
    claude_code_label="${YELLOW}skipped${RESET}"
  else
    claude_code_label="${YELLOW}failed${RESET}"
  fi
  # Cursor has three display states: ok (installed), skipped (not detected or
  # user-deselected), failed (install error).
  if [[ "${cursor_ok}" == "true" ]]; then
    cursor_label="${GREEN}ok${RESET}"
  elif [[ "${cursor_skipped}" == "true" ]]; then
    cursor_label="${YELLOW}skipped${RESET}"
  else
    cursor_label="${RED}failed${RESET}"
  fi

  echo -e "  store   ${store_label}"
  echo -e "  tray    ${tray_label}"
  echo -e "  pi      ${pi_label}"
  echo -e "  claude  ${claude_code_label}"
  echo -e "  cursor  ${cursor_label}"
  echo

  if [[ "${store_ok}" == "true" ]]; then
    echo -e "  ${GREEN}ToTally installed successfully.${RESET}"
    echo "  Run 'make doctor' to verify component health."
    echo "  Run 'git pull && make install' to update."
  else
    echo -e "  ${RED}Install incomplete.${RESET}"
    exit 1
  fi
}

main "$@"
