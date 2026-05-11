#!/usr/bin/env bash
# scripts/install.sh — ToTally idempotent installer orchestrator.
#
# Calls each component script in order. A failure in install-store.sh aborts
# the run (the store is the foundation every other component depends on).
# Failures in install-tray.sh and install-pi.sh are reported but do NOT abort
# — the other components should still complete.
#
# This script is designed to be safe for `git pull && make install`.
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
  GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; RESET='\033[0m'
else
  GREEN=''; YELLOW=''; RED=''; BOLD=''; RESET=''
fi

info()    { echo -e "  ${GREEN}✓${RESET}  $*"; }
warn()    { echo -e "  ${YELLOW}!${RESET}  $*"; }
err()     { echo -e "  ${RED}✗${RESET}  $*"; }
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
# Read/write the install manifest
# ---------------------------------------------------------------------------

MANIFEST_PATH="${TOKEN_TALLY_CONFIG_DIR}/install.json"

# Read an existing installedAt timestamp so we can preserve it on updates.
# Falls back to the current epoch-ms if the manifest is absent or malformed.
read_installed_at() {
  local ts
  if [[ -f "${MANIFEST_PATH}" ]] && command -v python3 &>/dev/null; then
    ts=$(python3 -c \
      "import json,sys; d=json.load(open('${MANIFEST_PATH}')); print(d.get('installedAt',''))" \
      2>/dev/null) || ts=""
    if [[ -n "${ts}" ]]; then
      echo "${ts}"
      return
    fi
  fi
  # Fallback: current time in milliseconds
  echo $(( $(date +%s) * 1000 ))
}

write_manifest() {
  local installed_at="$1"
  local updated_at="$2"
  local store_ok="$3"       # true|false
  local store_db_path="$4"
  local store_schema_ver="$5"
  local tray_ok="$6"        # true|false
  local tray_version="$7"
  local pi_ok="$8"          # true|false
  local pi_writer_path="$9"
  local pi_usage_path="${10}"

  # Convert bash true/false → Python True/False for use inside the heredoc.
  local py_store_ok py_tray_ok py_pi_ok
  [[ "${store_ok}" == "true" ]] && py_store_ok="True" || py_store_ok="False"
  [[ "${tray_ok}"  == "true" ]] && py_tray_ok="True"  || py_tray_ok="False"
  [[ "${pi_ok}"    == "true" ]] && py_pi_ok="True"    || py_pi_ok="False"

  python3 - <<PY
import json, os

if ${py_pi_ok}:
    pi_block = {
        "installed": True,
        "writerExtensionPath": "${pi_writer_path}",
        "usageCommandPath":    "${pi_usage_path}",
    }
else:
    pi_block = {"installed": False, "reason": "Pi not detected or install failed"}

data = {
    "repoPath":    "${REPO_ROOT}",
    "installedAt": ${installed_at},
    "updatedAt":   ${updated_at},
    "components": {
        "store": {
            "installed":     ${py_store_ok},
            "databasePath":  "${store_db_path}",
            "schemaVersion": ${store_schema_ver},
        },
        "tray": {
            "installed": ${py_tray_ok},
            "path":      "/Applications/ToTally.app",
            "version":   "${tray_version}",
        },
        "pi": pi_block,
    },
}
os.makedirs(os.path.dirname("${MANIFEST_PATH}"), exist_ok=True)
with open("${MANIFEST_PATH}", "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  section "ToTally installer"
  echo "  Repo: ${REPO_ROOT}"

  # ---- Pre-flight: create directories ----
  create_dirs
  info "Directories created (data, config, state)"

  # Track component outcomes for the final summary.
  local store_ok=false tray_ok=false pi_ok=false
  local store_db_path="${TOKEN_TALLY_DATA_DIR}/events.db"
  local store_schema_ver=0
  local tray_version="unknown"
  local pi_writer_path="${HOME}/.pi/agent/extensions/token-tally-writer"
  local pi_usage_path="${HOME}/.pi/agent/extensions/token-tally-usage"
  local tray_error_msg="" pi_error_msg=""

  # ---- Store (abort on failure — it's the foundation) ----
  section "Store & CLI"
  if "${SCRIPT_DIR}/install-store.sh" "${REPO_ROOT}" "${TOKEN_TALLY_DATA_DIR}"; then
    store_ok=true
    info "Store installed and database migrated"
    # Extract schema version from doctor output (best-effort; 0 if unavailable).
    if command -v token-tally &>/dev/null; then
      local doctor_json
      doctor_json=$(token-tally doctor --json 2>/dev/null) || true
      if [[ -n "${doctor_json}" ]]; then
        store_schema_ver=$(echo "${doctor_json}" | \
          python3 -c "import json,sys; d=json.load(sys.stdin); \
            [print(f['detail']['version']) for f in d['findings'] if f['code']=='schema_ok']" \
          2>/dev/null) || store_schema_ver=1
        store_schema_ver=${store_schema_ver:-1}
      fi
    fi
  else
    err "Store install failed — aborting"
    exit 1
  fi

  # ---- Tray (report failure, continue) ----
  section "macOS Tray"
  if "${SCRIPT_DIR}/install-tray.sh" "${REPO_ROOT}"; then
    tray_ok=true
    tray_version=$(defaults read /Applications/ToTally.app/Contents/Info \
      CFBundleShortVersionString 2>/dev/null) || tray_version="0.1.0"
    info "ToTally.app installed to /Applications/ToTally.app"
  else
    tray_error_msg="Tray install failed — check output above"
    warn "${tray_error_msg}"
  fi

  # ---- Pi integration (report failure, continue) ----
  section "Pi integration"
  if "${SCRIPT_DIR}/install-pi.sh" "${REPO_ROOT}"; then
    pi_ok=true
    info "Pi writer and usage extensions symlinked"
  else
    pi_error_msg="Pi install failed or Pi not detected — check output above"
    warn "${pi_error_msg}"
  fi

  # ---- Manifest ----
  section "Install manifest"
  local installed_at updated_at
  installed_at=$(read_installed_at)
  updated_at=$(( $(date +%s) * 1000 ))

  write_manifest \
    "${installed_at}" "${updated_at}" \
    "${store_ok}" "${store_db_path}" "${store_schema_ver}" \
    "${tray_ok}" "${tray_version}" \
    "${pi_ok}" "${pi_writer_path}" "${pi_usage_path}"
  info "Manifest written to ${MANIFEST_PATH}"

  # ---- Summary ----
  section "Summary"
  local store_label tray_label pi_label
  [[ "${store_ok}" == "true" ]] && store_label="${GREEN}ok${RESET}" || store_label="${RED}failed${RESET}"
  [[ "${tray_ok}"  == "true" ]] && tray_label="${GREEN}ok${RESET}"  || tray_label="${YELLOW}failed${RESET}"
  [[ "${pi_ok}"    == "true" ]] && pi_label="${GREEN}ok${RESET}"    || pi_label="${YELLOW}failed${RESET}"

  echo -e "  store   ${store_label}"
  echo -e "  tray    ${tray_label}"
  echo -e "  pi      ${pi_label}"
  echo

  # Hint about legacy Pi data import (never run automatically).
  if [[ -f "${HOME}/.pi/analytics/events.db" ]]; then
    echo -e "  ${YELLOW}Note:${RESET} Legacy Pi analytics data found at:"
    echo    "    ~/.pi/analytics/events.db"
    echo    "  To import it into the central store, run:"
    echo    "    token-tally import legacy-pi"
    echo
  fi

  if [[ "${store_ok}" == "true" ]]; then
    echo -e "  ${GREEN}ToTally installed successfully.${RESET}"
    echo    "  Run 'make doctor' to verify component health."
    echo    "  Run 'git pull && make install' to update."
  else
    echo -e "  ${RED}Install incomplete.${RESET}"
    exit 1
  fi
}

main "$@"
