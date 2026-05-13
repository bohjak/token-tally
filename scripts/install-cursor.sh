#!/usr/bin/env bash
# scripts/install-cursor.sh — Install Cursor hook integration.
#
# Installs a command symlink:
#   ~/.local/bin/token-tally-cursor-hook
#     → <repo>/harnesses/cursor/writer/dist/bin/token-tally-cursor-hook.js
#
# Then idempotently merges ToTally hook commands into ~/.cursor/hooks.json.
# The merge preserves all user settings and only removes/replaces commands
# owned by ToTally (flat entries whose "command" field contains
# "token-tally-cursor-hook").
#
# Cursor hook format (lower-camel event names, flat entries):
#   {
#     "version": 1,
#     "hooks": {
#       "sessionStart": [{ "command": "token-tally-cursor-hook" }]
#     }
#   }
#
# This is intentionally different from Claude Code's nested format. Do NOT use
# the Claude Code hook JSON shape for ~/.cursor/hooks.json.
#
# Arguments:
#   $1  REPO_ROOT — absolute path to the repository root
#
# Exit codes:
#   0   success
#   1   Cursor not detected, build failed, or hooks merge failed
set -euo pipefail

if [[ -t 1 ]]; then
  GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; RESET='\033[0m'
else
  GREEN=''; YELLOW=''; RED=''; RESET=''
fi

info()  { echo -e "  ${GREEN}✓${RESET}  $*"; }
warn()  { echo -e "  ${YELLOW}!${RESET}  $*"; }
err()   { echo -e "  ${RED}✗${RESET}  $*"; }

# ---------------------------------------------------------------------------
# Presence detection and symlink helper
# ---------------------------------------------------------------------------

cursor_is_present() {
  command -v cursor &>/dev/null || \
    [[ -d "${HOME}/.cursor" ]] || \
    [[ -d "${HOME}/Library/Application Support/Cursor" ]] || \
    [[ -d "/Applications/Cursor.app" ]] || \
    [[ -d "${HOME}/Applications/Cursor.app" ]]
}

ensure_symlink() {
  local link_path="$1"
  local target_path="$2"
  local label="$3"

  if [[ -L "${link_path}" ]]; then
    local current_target
    current_target=$(readlink "${link_path}")
    if [[ "${current_target}" == "${target_path}" && -e "${target_path}" ]]; then
      info "${label}: already correct (${link_path})"
      return 0
    fi
    warn "${label}: symlink exists but points to '${current_target}' — replacing"
    rm "${link_path}"
  elif [[ -e "${link_path}" ]]; then
    err "${label}: a non-symlink file/directory exists at ${link_path}"
    err "  Remove it manually, then re-run 'make install'."
    return 1
  fi

  if [[ ! -e "${target_path}" ]]; then
    err "${label}: target does not exist: ${target_path}"
    return 1
  fi

  ln -s "${target_path}" "${link_path}"
  info "${label}: symlinked (${link_path} → ${target_path})"
}

# ---------------------------------------------------------------------------
# hooks.json merge
#
# Uses Python 3 (present on all supported platforms) to perform the merge.
# All values are passed via environment variables to avoid shell interpolation
# issues with paths containing spaces or special characters.
# ---------------------------------------------------------------------------

merge_hooks() {
  local hooks_path="$1"
  local hook_command="$2"

  TT_CUR_HOOKS_PATH="${hooks_path}" \
  TT_CUR_HOOK_COMMAND="${hook_command}" \
  python3 - <<'PY'
import json
import os
import shutil
import time
from pathlib import Path

hooks_path  = Path(os.environ["TT_CUR_HOOKS_PATH"])
hook_command = os.environ["TT_CUR_HOOK_COMMAND"]

# The 10 Cursor agent-hook events this integration subscribes to.
# Names are lower-camel as required by Cursor's native hooks.json format.
EVENTS = [
    "sessionStart",
    "sessionEnd",
    "beforeSubmitPrompt",
    "afterAgentResponse",
    "preToolUse",
    "postToolUse",
    "postToolUseFailure",
    "stop",
    "subagentStop",
    "preCompact",
]

# ----- Load or initialise the hooks.json file -----
hooks_path.parent.mkdir(parents=True, exist_ok=True)
if hooks_path.exists():
    try:
        with hooks_path.open() as f:
            data = json.load(f)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"hooks.json is malformed: {exc}")
    # Back up on first modification this run so the user can recover.
    backup = hooks_path.with_name(
        hooks_path.name + f".bak-{int(time.time())}"
    )
    shutil.copy2(hooks_path, backup)
else:
    data = {}

if not isinstance(data, dict):
    raise SystemExit("hooks.json root must be a JSON object")

# Ensure required top-level fields without clobbering unrelated keys.
# "version" is specified by the Cursor docs; preserve it if already set.
data.setdefault("version", 1)
hooks_root = data.setdefault("hooks", {})
if not isinstance(hooks_root, dict):
    raise SystemExit("hooks.json 'hooks' key must be a JSON object")

def is_owned(entry: object) -> bool:
    """Return True for flat hook entries that belong to token-tally-cursor-hook."""
    if not isinstance(entry, dict):
        return False
    cmd = entry.get("command", "")
    return isinstance(cmd, str) and hook_command in cmd

# ----- Merge: filter then append -----
for event in EVENTS:
    existing = hooks_root.get(event, [])
    if not isinstance(existing, list):
        # Unexpected shape — preserve the value and add alongside it.
        existing = []

    # Remove previously-installed entries owned by this hook (idempotent).
    cleaned = [entry for entry in existing if not is_owned(entry)]

    # Append the owned flat entry in Cursor-native format.
    # This is deliberately minimal: no "type" field (command is the default),
    # no "matcher" (match all tools/events), no "timeout".
    cleaned.append({"command": hook_command})

    hooks_root[event] = cleaned

# ----- Atomic write via temp file + rename -----
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
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  local repo_root="${1:?REPO_ROOT is required}"
  local cursor_dir="${HOME}/.cursor"

  # Fail-soft: skip gracefully when Cursor is not installed. If the app or CLI
  # exists but ~/.cursor has not been created yet, initialise it so hooks.json
  # can be written in the documented location.
  if ! cursor_is_present; then
    warn "Cursor not detected"
    warn "Install or launch Cursor first, then re-run 'make install'."
    return 1
  fi
  mkdir -p "${cursor_dir}"

  local writer_dir="${repo_root}/harnesses/cursor/writer"
  local hook_target="${writer_dir}/dist/bin/token-tally-cursor-hook.js"
  local hook_link="${HOME}/.local/bin/token-tally-cursor-hook"
  local hooks_path="${cursor_dir}/hooks.json"

  if [[ ! -d "${writer_dir}" ]]; then
    err "Cursor writer source not found: ${writer_dir}"
    err "The harnesses/cursor/writer package must exist before installing."
    return 1
  fi

  if ! command -v pnpm &>/dev/null; then
    err "pnpm not found in PATH; cannot build Cursor writer"
    return 1
  fi

  # Build the Cursor writer package.
  pnpm --dir "${repo_root}" --filter @token-tally/cursor-writer build
  chmod +x "${hook_target}"
  info "Cursor writer built"

  # Symlink the hook binary into ~/.local/bin so Cursor can find it on PATH.
  mkdir -p "${HOME}/.local/bin"
  ensure_symlink "${hook_link}" "${hook_target}" "Cursor hook"

  case ":${PATH}:" in
    *":${HOME}/.local/bin:"*) ;;
    *) warn "${HOME}/.local/bin is not on PATH; Cursor may not find token-tally-cursor-hook" ;;
  esac

  # Merge owned hook entries into ~/.cursor/hooks.json in Cursor-native format.
  merge_hooks "${hooks_path}" "token-tally-cursor-hook"
  info "Cursor hooks merged into ${hooks_path}"
}

main "$@"
