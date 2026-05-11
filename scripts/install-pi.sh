#!/usr/bin/env bash
# scripts/install-pi.sh — Install Pi writer and usage-command extensions.
#
# Installs two symlinks in ~/.pi/agent/extensions/:
#   token-tally-writer → <repo>/harnesses/pi/writer-extension
#   token-tally-usage  → <repo>/clients/pi-usage-command
#
# Idempotency: if the symlink already exists and points to the right place,
# it is left unchanged. If it points elsewhere, it is replaced with a warning.
#
# Arguments:
#   $1  REPO_ROOT — absolute path to the repository root
#
# Exit codes:
#   0   success (both symlinks created or already correct)
#   1   Pi not detected (extensions dir absent), or symlink creation failed
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
# ensure_symlink <link_path> <target_path> <label>
# ---------------------------------------------------------------------------
# Creates or repairs a symlink so that link_path → target_path.
# - If the link already exists and is correct: no-op + info message.
# - If the link exists but points elsewhere: replace + warn.
# - If the link exists but the target does not exist: replace + warn.
# - If a non-symlink file or directory is at link_path: error out.
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
# Main
# ---------------------------------------------------------------------------

main() {
  local repo_root="${1:?REPO_ROOT is required}"

  local pi_ext_dir="${HOME}/.pi/agent/extensions"

  # If the Pi extensions directory doesn't exist, Pi is not installed.
  if [[ ! -d "${pi_ext_dir}" ]]; then
    warn "Pi extensions directory not found (${pi_ext_dir})"
    warn "Install Pi first: https://pi.ai/docs or similar"
    warn "Re-run 'make install' after Pi is installed."
    return 1
  fi

  local writer_source="${repo_root}/harnesses/pi/writer-extension"
  local usage_source="${repo_root}/clients/pi-usage-command"

  if [[ ! -d "${writer_source}" ]]; then
    err "Writer extension source not found: ${writer_source}"
    return 1
  fi

  if [[ ! -d "${usage_source}" ]]; then
    err "Usage command source not found: ${usage_source}"
    return 1
  fi

  ensure_symlink \
    "${pi_ext_dir}/token-tally-writer" \
    "${writer_source}" \
    "Pi writer extension"

  ensure_symlink \
    "${pi_ext_dir}/token-tally-usage" \
    "${usage_source}" \
    "Pi usage command"
}

main "$@"
