#!/usr/bin/env bash
# scripts/install-claude-code.sh — Install Claude Code hook integration.
#
# Installs a command symlink:
#   ~/.local/bin/token-tally-claude-hook
#     → <repo>/harnesses/claude-code/writer/dist/bin/token-tally-claude-hook.js
#
# Then idempotently merges ToTally hook commands into ~/.claude/settings.json.
# The merge preserves all user settings and only removes/replaces commands owned
# by ToTally (commands beginning with "token-tally-claude-hook" or the installed
# hook path).
#
# Arguments:
#   $1  REPO_ROOT — absolute path to the repository root
#
# Exit codes:
#   0   success
#   1   Claude Code not detected, build failed, or settings merge failed
set -euo pipefail

if [[ -t 1 ]]; then
  GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; RESET='\033[0m'
else
  GREEN=''; YELLOW=''; RED=''; RESET=''
fi

info()  { echo -e "  ${GREEN}✓${RESET}  $*"; }
warn()  { echo -e "  ${YELLOW}!${RESET}  $*"; }
err()   { echo -e "  ${RED}✗${RESET}  $*"; }

claude_code_is_present() {
  command -v claude &>/dev/null || [[ -d "${HOME}/.claude" ]]
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

merge_settings() {
  local settings_path="$1"
  local hook_command="$2"

  TT_CC_SETTINGS_PATH="${settings_path}" \
  TT_CC_HOOK_COMMAND="${hook_command}" \
  python3 - <<'PY'
import json
import os
import shutil
import time
from pathlib import Path

settings_path = Path(os.environ["TT_CC_SETTINGS_PATH"])
hook_command = os.environ["TT_CC_HOOK_COMMAND"]
events = [
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "SubagentStop",
]

settings_path.parent.mkdir(parents=True, exist_ok=True)
if settings_path.exists():
    try:
        with settings_path.open() as f:
            data = json.load(f)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"settings JSON is malformed: {exc}")
    backup = settings_path.with_name(settings_path.name + f".bak-{int(time.time())}")
    shutil.copy2(settings_path, backup)
else:
    data = {}

if not isinstance(data, dict):
    raise SystemExit("settings JSON root must be an object")

hooks_root = data.setdefault("hooks", {})
if not isinstance(hooks_root, dict):
    raise SystemExit("settings JSON 'hooks' key must be an object")

def owned(command: object) -> bool:
    if not isinstance(command, str):
        return False
    return command.startswith("token-tally-claude-hook") or command.startswith(hook_command)

for event in events:
    existing = hooks_root.get(event, [])
    if not isinstance(existing, list):
        existing = []

    cleaned = []
    for matcher in existing:
        if not isinstance(matcher, dict):
            cleaned.append(matcher)
            continue
        matcher_copy = dict(matcher)
        matcher_hooks = matcher_copy.get("hooks", [])
        if not isinstance(matcher_hooks, list):
            cleaned.append(matcher_copy)
            continue
        filtered_hooks = [
            h for h in matcher_hooks
            if not (isinstance(h, dict) and owned(h.get("command")))
        ]
        if filtered_hooks:
            matcher_copy["hooks"] = filtered_hooks
            cleaned.append(matcher_copy)

    cleaned.append({
        "hooks": [{"type": "command", "command": hook_command}],
    })
    hooks_root[event] = cleaned

# Atomic write via temp file + rename (mirrors install-cursor.sh merge_hooks).
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
}

main() {
  local repo_root="${1:?REPO_ROOT is required}"
  local claude_dir="${HOME}/.claude"

  if ! claude_code_is_present; then
    warn "Claude Code not detected"
    warn "Install or run Claude Code first, then re-run 'make install'."
    return 1
  fi
  mkdir -p "${claude_dir}"

  local writer_dir="${repo_root}/harnesses/claude-code/writer"
  local hook_target="${writer_dir}/dist/bin/token-tally-claude-hook.js"
  local hook_link="${HOME}/.local/bin/token-tally-claude-hook"
  local settings_path="${claude_dir}/settings.json"

  if [[ ! -d "${writer_dir}" ]]; then
    err "Claude Code writer source not found: ${writer_dir}"
    return 1
  fi

  if ! command -v pnpm &>/dev/null; then
    err "pnpm not found in PATH; cannot build Claude Code writer"
    return 1
  fi

  pnpm --dir "${repo_root}" --filter @token-tally/claude-code-writer build
  chmod +x "${hook_target}"
  info "Claude Code writer built"

  mkdir -p "${HOME}/.local/bin"
  ensure_symlink "${hook_link}" "${hook_target}" "Claude Code hook"

  case ":${PATH}:" in
    *":${HOME}/.local/bin:"*) ;;
    *) warn "${HOME}/.local/bin is not on PATH; Claude Code may not find token-tally-claude-hook" ;;
  esac

  merge_settings "${settings_path}" "token-tally-claude-hook"
  info "Claude Code hooks merged into ${settings_path}"

  # ---- Daemon note ----
  # The claude-code hook writer does not trigger full-directory spool drain.
  # The token-tally drain daemon handles background persistence.
  # See 'token-tally daemon --help' for usage. Do not register the daemon
  # with launchd/cron yet — failed-file quarantine (T8) must land first.
}

main "$@"
