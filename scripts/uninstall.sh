#!/usr/bin/env bash
# scripts/uninstall.sh — Remove ToTally components installed by make install.
#
# Default behavior (no flags):
#   - Quit ToTally if running.
#   - Remove /Applications/ToTally.app (if manifest-tracked or present).
#   - Remove Pi extension symlinks under ~/.pi/agent/extensions/token-tally-*.
#   - Remove the Claude Code hook symlink and ToTally-owned settings entries.
#   - Remove the Cursor hook symlink and ToTally-owned hooks.json entries.
#   - Remove the install manifest (~/.config/token-tally/install.json).
#   - Print paths of user data (DB, spool, logs) but DO NOT delete them.
#   - Leave ~/.pi/analytics/events.db (legacy Pi DB) untouched.
#
# Flags:
#   --purge        Also remove ~/.local/share/token-tally/ and
#                  ~/.local/state/token-tally/ (DB, spool, logs).
#                  Requires interactive confirmation unless --yes is also given.
#   --yes          Skip interactive confirmation for destructive operations.
#   --keep-app     Skip tray app removal.
#   --keep-pi      Skip Pi extension removal.
#   --keep-claude-code
#                  Skip Claude Code hook removal.
#   --keep-cursor  Skip Cursor hook removal.
#   --keep-data    Alias for not passing --purge (default; explicit opt-out).
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

info()    { echo -e "  ${GREEN}✓${RESET}  $*"; }
warn()    { echo -e "  ${YELLOW}!${RESET}  $*"; }
err()     { echo -e "  ${RED}✗${RESET}  $*"; }
section() { echo -e "\n${BOLD}$*${RESET}"; }

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

OPT_PURGE=false
OPT_YES=false
OPT_KEEP_APP=false
OPT_KEEP_PI=false
OPT_KEEP_CLAUDE_CODE=false
OPT_KEEP_CURSOR=false

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --purge)     OPT_PURGE=true ;;
      --yes)       OPT_YES=true ;;
      --keep-app)  OPT_KEEP_APP=true ;;
      --keep-pi)   OPT_KEEP_PI=true ;;
      --keep-claude-code) OPT_KEEP_CLAUDE_CODE=true ;;
      --keep-cursor) OPT_KEEP_CURSOR=true ;;
      --keep-data) OPT_PURGE=false ;;
      --help|-h)
        echo "Usage: scripts/uninstall.sh [--purge [--yes]] [--keep-app] [--keep-pi] [--keep-claude-code] [--keep-cursor]"
        echo
        echo "Flags:"
        echo "  --purge              Also delete ToTally user data (DB, spool, logs)"
        echo "  --yes                Skip confirmation prompts"
        echo "  --keep-app           Skip removing /Applications/ToTally.app"
        echo "  --keep-pi            Skip removing Pi extension symlinks"
        echo "  --keep-claude-code   Skip removing Claude Code hooks"
        echo "  --keep-cursor        Skip removing Cursor hooks"
        exit 0
        ;;
      *)
        err "Unknown flag: $1"
        exit 1
        ;;
    esac
    shift
  done
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Quit ToTally if it is currently running.
quit_if_running() {
  if ! command -v osascript &>/dev/null; then return; fi
  local running
  running=$(osascript -e \
    'tell application "System Events" to (name of processes) contains "ToTally"' \
    2>/dev/null) || running="false"
  if [[ "${running}" == "true" ]]; then
    echo "  Quitting ToTally…"
    osascript -e 'tell application "ToTally" to quit' 2>/dev/null || true
    sleep 1
    info "ToTally quit"
  fi
}

# Remove /Applications/ToTally.app.
remove_app() {
  local app_path="/Applications/ToTally.app"
  if [[ ! -e "${app_path}" ]]; then
    info "ToTally.app not present — nothing to remove"
    return
  fi
  if [[ ! -w "/Applications" ]]; then
    err "/Applications is not writable; cannot remove ${app_path}"
    err "Do NOT run 'sudo make uninstall'. Remove the app directly as admin:"
    err "    sudo rm -rf /Applications/ToTally.app"
    return 1
  fi
  rm -rf "${app_path}"
  info "Removed ${app_path}"
}

# Remove Pi extension symlinks matching token-tally-*.
remove_pi_symlinks() {
  local pi_ext_dir="${HOME}/.pi/agent/extensions"
  if [[ ! -d "${pi_ext_dir}" ]]; then
    info "Pi extensions directory not found — nothing to remove"
    return
  fi

  local found=false
  # Use a loop over the expected names rather than a glob over the real dir
  # to avoid accidentally touching symlinks we didn't create.
  for name in token-tally-writer token-tally-usage; do
    local link_path="${pi_ext_dir}/${name}"
    if [[ -L "${link_path}" ]]; then
      rm "${link_path}"
      info "Removed symlink ${link_path}"
      found=true
    elif [[ -e "${link_path}" ]]; then
      warn "${link_path} exists but is not a symlink — leaving in place"
    fi
  done

  if [[ "${found}" == "false" ]]; then
    info "No Pi token-tally symlinks found — nothing to remove"
  fi
}

# Remove Claude Code hook symlink and ToTally-owned settings entries.
remove_claude_code_hooks() {
  local hook_link="${HOME}/.local/bin/token-tally-claude-hook"
  local settings_path="${HOME}/.claude/settings.json"

  if [[ -L "${hook_link}" ]]; then
    local target
    target=$(readlink "${hook_link}")
    if [[ "${target}" == "${REPO_ROOT}"/* ]]; then
      rm "${hook_link}"
      info "Removed symlink ${hook_link}"
    else
      warn "${hook_link} points outside this repo (${target}) — leaving in place"
    fi
  elif [[ -e "${hook_link}" ]]; then
    warn "${hook_link} exists but is not a symlink — leaving in place"
  else
    info "Claude Code hook symlink not found — nothing to remove"
  fi

  if [[ ! -f "${settings_path}" ]]; then
    info "Claude Code settings not found — nothing to edit"
    return
  fi

  TT_CC_SETTINGS_PATH="${settings_path}" python3 - <<'PY'
import json
import os
import shutil
import time
from pathlib import Path

settings_path = Path(os.environ["TT_CC_SETTINGS_PATH"])
try:
    with settings_path.open() as f:
        data = json.load(f)
except json.JSONDecodeError as exc:
    raise SystemExit(f"settings JSON is malformed: {exc}")

if not isinstance(data, dict):
    raise SystemExit("settings JSON root must be an object")

hooks_root = data.get("hooks")
if not isinstance(hooks_root, dict):
    raise SystemExit(0)

def owned(command: object) -> bool:
    # Match both old bare-name installs and new absolute-path installs.
    return isinstance(command, str) and (
        command.startswith("token-tally-claude-hook") or
        command.endswith("/token-tally-claude-hook")
    )

changed = False
for event in list(hooks_root.keys()):
    matchers = hooks_root.get(event)
    if not isinstance(matchers, list):
        continue
    new_matchers = []
    for matcher in matchers:
        if not isinstance(matcher, dict):
            new_matchers.append(matcher)
            continue
        matcher_copy = dict(matcher)
        matcher_hooks = matcher_copy.get("hooks", [])
        if not isinstance(matcher_hooks, list):
            new_matchers.append(matcher_copy)
            continue
        filtered_hooks = [
            h for h in matcher_hooks
            if not (isinstance(h, dict) and owned(h.get("command")))
        ]
        if len(filtered_hooks) != len(matcher_hooks):
            changed = True
        if filtered_hooks:
            matcher_copy["hooks"] = filtered_hooks
            new_matchers.append(matcher_copy)
        elif any(isinstance(h, dict) and owned(h.get("command")) for h in matcher_hooks):
            # Drop matchers that only contained ToTally-owned hooks.
            changed = True
        else:
            new_matchers.append(matcher_copy)
    if new_matchers:
        hooks_root[event] = new_matchers
    else:
        del hooks_root[event]
        changed = True

if changed:
    backup = settings_path.with_name(settings_path.name + ".bak-" + str(int(time.time())))
    shutil.copy2(settings_path, backup)
    tmp = settings_path.with_suffix(".json.tmp")
    try:
        with tmp.open("w") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        tmp.replace(settings_path)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
PY
  info "Removed ToTally Claude Code hooks from ${settings_path}"
}

# Remove Cursor hook symlink and ToTally-owned hooks.json entries.
#
# Cursor's hooks.json uses lower-camel event names with flat entry arrays:
#   { "version": 1, "hooks": { "sessionStart": [{"command": "..."}] } }
# We filter out entries whose "command" field contains "token-tally-cursor-hook".
remove_cursor_hooks() {
  local hook_link="${HOME}/.local/bin/token-tally-cursor-hook"
  local hooks_path="${HOME}/.cursor/hooks.json"

  # Remove the hook binary symlink if it points into this repo.
  if [[ -L "${hook_link}" ]]; then
    local target
    target=$(readlink "${hook_link}")
    if [[ "${target}" == "${REPO_ROOT}"/* ]]; then
      rm "${hook_link}"
      info "Removed symlink ${hook_link}"
    else
      warn "${hook_link} points outside this repo (${target}) — leaving in place"
    fi
  elif [[ -e "${hook_link}" ]]; then
    warn "${hook_link} exists but is not a symlink — leaving in place"
  else
    info "Cursor hook symlink not found — nothing to remove"
  fi

  if [[ ! -f "${hooks_path}" ]]; then
    info "Cursor hooks.json not found — nothing to edit"
    return
  fi

  TT_CURSOR_HOOKS_PATH="${hooks_path}" python3 - <<'PY'
import json
import os
import shutil
import time
from pathlib import Path

hooks_path = Path(os.environ["TT_CURSOR_HOOKS_PATH"])
try:
    with hooks_path.open() as f:
        data = json.load(f)
except json.JSONDecodeError as exc:
    raise SystemExit(f"hooks.json is malformed: {exc}")

if not isinstance(data, dict):
    raise SystemExit("hooks.json root must be an object")

hooks_root = data.get("hooks")
if not isinstance(hooks_root, dict):
    # No hooks object — nothing to remove.
    raise SystemExit(0)

def owned(command: object) -> bool:
    """True when an entry command belongs to ToTally's Cursor hook."""
    return isinstance(command, str) and "token-tally-cursor-hook" in command

changed = False
for event in list(hooks_root.keys()):
    entries = hooks_root.get(event)
    if not isinstance(entries, list):
        continue
    filtered = [
        e for e in entries
        if not (isinstance(e, dict) and owned(e.get("command")))
    ]
    if len(filtered) != len(entries):
        changed = True
    if filtered:
        hooks_root[event] = filtered
    else:
        # Drop the event key entirely when no non-ToTally entries remain.
        del hooks_root[event]

if changed:
    backup = hooks_path.with_name(hooks_path.name + ".bak-" + str(int(time.time())))
    shutil.copy2(hooks_path, backup)
    tmp = hooks_path.with_suffix(".json.tmp")
    try:
        with tmp.open("w") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        tmp.replace(hooks_path)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
PY
  info "Removed ToTally Cursor hooks from ${hooks_path}"
}

# Remove the install manifest.
remove_manifest() {
  if [[ -f "${MANIFEST_PATH}" ]]; then
    rm "${MANIFEST_PATH}"
    info "Removed manifest ${MANIFEST_PATH}"
  else
    info "Manifest not found — nothing to remove"
  fi
}

# Unload and remove the drain daemon from launchd (macOS) or systemd (Linux).
# Must run before --purge, which deletes the daemon binary from TOKEN_TALLY_DATA_DIR.
remove_daemon() {
  case "$(uname -s)" in
    Darwin)
      local plist_label="com.token-tally.daemon"
      local plist_path="${HOME}/Library/LaunchAgents/${plist_label}.plist"
      # bootout unloads and removes the job; tolerate not-loaded (exit non-zero).
      if launchctl bootout "gui/$(id -u)/${plist_label}" 2>/dev/null; then
        info "Daemon unloaded from launchd"
      else
        info "Daemon was not loaded in launchd (already stopped or never installed)"
      fi
      if [[ -f "${plist_path}" ]]; then
        rm "${plist_path}"
        info "Removed launchd plist ${plist_path}"
      else
        info "launchd plist not found -- nothing to remove"
      fi
      ;;
    Linux)
      local unit_path="${HOME}/.config/systemd/user/token-tally-daemon.service"
      if command -v systemctl &>/dev/null; then
        # Tolerate unit-not-found / not-active errors (various non-zero exit codes).
        systemctl --user disable --now token-tally-daemon 2>/dev/null || true
        info "Daemon disabled via systemd --user"
        systemctl --user daemon-reload 2>/dev/null || true
      fi
      if [[ -f "${unit_path}" ]]; then
        rm "${unit_path}"
        info "Removed systemd unit ${unit_path}"
      else
        info "systemd unit not found -- nothing to remove"
      fi
      ;;
    *)
      info "Unsupported platform -- skipping daemon deregistration"
      ;;
  esac
}

# Purge user data after confirmation.
purge_user_data() {
  echo
  echo -e "  ${RED}WARNING: --purge will permanently delete:${RESET}"
  echo    "    ${TOKEN_TALLY_DATA_DIR}/"
  echo    "    ${TOKEN_TALLY_STATE_DIR}/"
  echo    "  This includes the analytics database, spool files, and logs."
  echo    "  Your legacy Pi DB (~/.pi/analytics/events.db) is NOT affected."
  echo

  if [[ "${OPT_YES}" == "false" ]]; then
    read -r -p "  Type 'yes' to confirm deletion: " answer
    if [[ "${answer}" != "yes" ]]; then
      warn "Purge cancelled."
      return
    fi
  fi

  if [[ -d "${TOKEN_TALLY_DATA_DIR}" ]]; then
    rm -rf "${TOKEN_TALLY_DATA_DIR}"
    info "Deleted ${TOKEN_TALLY_DATA_DIR}"
  fi
  if [[ -d "${TOKEN_TALLY_STATE_DIR}" ]]; then
    rm -rf "${TOKEN_TALLY_STATE_DIR}"
    info "Deleted ${TOKEN_TALLY_STATE_DIR}"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  parse_args "$@"
  local -a _failures=()

  section "ToTally uninstall"

  # ---- Daemon (must run before purge to avoid deleting the binary first) ----
  section "Drain daemon"
  remove_daemon || _failures+=("drain daemon deregistration")

  # ---- App ----
  section "Tray app"
  if [[ "${OPT_KEEP_APP}" == "false" ]]; then
    quit_if_running
    remove_app || _failures+=("tray app removal")
  else
    info "Skipping tray removal (--keep-app)"
  fi

  # ---- Pi ----
  section "Pi extensions"
  if [[ "${OPT_KEEP_PI}" == "false" ]]; then
    remove_pi_symlinks || _failures+=("Pi extension removal")
  else
    info "Skipping Pi extension removal (--keep-pi)"
  fi

  # ---- Claude Code ----
  section "Claude Code hooks"
  if [[ "${OPT_KEEP_CLAUDE_CODE}" == "false" ]]; then
    remove_claude_code_hooks || _failures+=("Claude Code hook removal")
  else
    info "Skipping Claude Code hook removal (--keep-claude-code)"
  fi

  # ---- Cursor ----
  section "Cursor hooks"
  if [[ "${OPT_KEEP_CURSOR}" == "false" ]]; then
    remove_cursor_hooks || _failures+=("Cursor hook removal")
  else
    info "Skipping Cursor hook removal (--keep-cursor)"
  fi

  # ---- Manifest ----
  section "Install manifest"
  remove_manifest || _failures+=("manifest removal")

  # ---- User data ----
  section "User data"
  if [[ "${OPT_PURGE}" == "true" ]]; then
    purge_user_data || _failures+=("data purge")
  else
    echo    "  User data NOT deleted (pass --purge to also remove):"
    [[ -d "${TOKEN_TALLY_DATA_DIR}" ]]  && echo "    ${TOKEN_TALLY_DATA_DIR}/"
    [[ -d "${TOKEN_TALLY_STATE_DIR}" ]] && echo "    ${TOKEN_TALLY_STATE_DIR}/"
    echo    "  Delete them manually, or re-run with:"
    echo    "    scripts/uninstall.sh --purge"
    echo    "    scripts/uninstall.sh --purge --yes   # skip confirmation"
  fi

  # Always remind the user about the legacy Pi DB (never ours to touch).
  if [[ -f "${HOME}/.pi/analytics/events.db" ]]; then
    echo
    echo    "  The legacy Pi analytics database was NOT modified:"
    echo    "    ~/.pi/analytics/events.db"
    echo    "  Delete it manually if you no longer need it."
  fi

  echo
  if [[ "${#_failures[@]}" -gt 0 ]]; then
    err "Some components failed to uninstall:"
    for _f in "${_failures[@]}"; do
      err "  - ${_f}"
    done
    exit 1
  else
    info "Uninstall complete."
  fi
}

main "$@"
