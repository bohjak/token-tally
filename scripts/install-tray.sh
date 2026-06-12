#!/usr/bin/env bash
# scripts/install-tray.sh — Build and atomically install ToTally.app.
#
# Responsibilities:
#   1. Build the Swift tray app in release configuration.
#   2. Assemble the app bundle as ToTally.app under clients/macos-tray/dist/.
#   3. Atomically install the bundle to /Applications/ToTally.app.
#   4. Stop any running instance first so the binary can be replaced.
#   5. Launch the newly-installed app (which self-registers for launch-at-login
#      on first run because AppSettings.defaultLaunchAtLogin = true).
#
# Arguments:
#   $1  REPO_ROOT — absolute path to the repository root
#
# Tray sub-package layout (relative to REPO_ROOT):
#   clients/macos-tray/Package.swift
#   clients/macos-tray/.build/release/AnalyticsTray   ← compiled binary
#   clients/macos-tray/AnalyticsTray/Resources/Info.plist
#   clients/macos-tray/dist/ToTally.app               ← assembled bundle
#
# Exit codes:
#   0   success
#   1   failure (no silent fallback to ~/Applications)
set -euo pipefail

BUNDLE_NAME="ToTally.app"
APP_NAME="ToTally"
BUNDLE_ID="com.token-tally.ToTally"
INSTALL_DIR="/Applications"

if [[ -t 1 ]]; then
  GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; RESET='\033[0m'
else
  GREEN=''; YELLOW=''; RED=''; RESET=''
fi

info()  { echo -e "  ${GREEN}✓${RESET}  $*"; }
warn()  { echo -e "  ${YELLOW}!${RESET}  $*"; }
err()   { echo -e "  ${RED}✗${RESET}  $*"; }

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Build the .app bundle into dist/ToTally.app.
# The Swift target is named "AnalyticsTray" by SwiftPM; we rename the binary
# to "ToTally" inside the bundle because macOS uses CFBundleExecutable (or the
# bundle name when that key is absent) to find the executable.
build_bundle() {
  local tray_dir="$1"

  echo "  Building Swift app (release)…"
  swift build \
    --package-path "${tray_dir}" \
    --configuration release \
    2>&1 | sed 's/^/    /'

  local binary="${tray_dir}/.build/release/AnalyticsTray"
  if [[ ! -f "${binary}" ]]; then
    err "Swift build succeeded but binary not found at: ${binary}"
    return 1
  fi

  # Assemble the bundle.
  local bundle_dir="${tray_dir}/dist/${BUNDLE_NAME}"
  local contents_dir="${bundle_dir}/Contents"
  local macos_dir="${contents_dir}/MacOS"
  local resources_dir="${contents_dir}/Resources"

  rm -rf "${bundle_dir}"
  mkdir -p "${macos_dir}" "${resources_dir}"

  # Rename binary from AnalyticsTray → ToTally so macOS finds it when there
  # is no explicit CFBundleExecutable key in Info.plist (macOS defaults to
  # the bundle directory name without the .app suffix).
  cp "${binary}" "${macos_dir}/ToTally"
  chmod 755 "${macos_dir}/ToTally"

  cp "${tray_dir}/AnalyticsTray/Resources/Info.plist" "${contents_dir}/Info.plist"

  # Strip the quarantine bit so the app launches without a Gatekeeper prompt.
  # This is safe for locally-built, locally-installed apps.
  xattr -cr "${bundle_dir}" 2>/dev/null || true

  info "Bundle assembled at ${bundle_dir}"
}

# Atomically replace /Applications/ToTally.app using a temp path so that a
# crash during install doesn't leave a half-overwritten bundle.
atomic_install() {
  local bundle_dir="$1"

  if [[ ! -w "${INSTALL_DIR}" ]]; then
    err "/Applications is not writable by the current user."
    err "Do NOT run 'sudo make install' — that runs the entire build chain as root."
    err ""
    err "Option A — admin-copy only the already-built bundle (preferred):"
    err "    sudo cp -R '${bundle_dir}' /Applications/ToTally.app"
    err ""
    err "Option B — install manually from Finder:"
    err "    open '${bundle_dir%/*}'"
    err "    then drag ToTally.app into /Applications when prompted."
    err ""
    err "(ToTally does NOT silently fall back to ~/Applications.)"
    return 1
  fi

  local tmp_path="${INSTALL_DIR}/${BUNDLE_NAME}.tmp"

  rm -rf "${tmp_path}"
  cp -R "${bundle_dir}" "${tmp_path}"
  rm -rf "${INSTALL_DIR:?}/${BUNDLE_NAME:?}"
  mv "${tmp_path}" "${INSTALL_DIR}/${BUNDLE_NAME}"

  info "Installed ${INSTALL_DIR}/${BUNDLE_NAME}"
}

# Return success when a ToTally process is currently running.
is_app_running() {
  if command -v pgrep &>/dev/null; then
    pgrep -x "${APP_NAME}" >/dev/null 2>&1
    return
  fi

  if command -v osascript &>/dev/null; then
    local running
    running=$(osascript -e \
      "tell application \"System Events\" to (name of processes) contains \"${APP_NAME}\"" \
      2>/dev/null) || running="false"
    [[ "${running}" == "true" ]]
    return
  fi

  return 1
}

# Wait up to ~5 seconds for ToTally to exit.
wait_for_app_exit() {
  local _
  for _ in {1..20}; do
    if ! is_app_running; then
      return 0
    fi
    sleep 0.25
  done

  return 1
}

# Stop a running instance of ToTally so the binary can be replaced. Prefer a
# graceful quit first, then force-kill if the menu bar app does not exit.
stop_if_running() {
  if ! is_app_running; then
    return 0
  fi

  echo "  Stopping running ToTally instance…"

  if command -v osascript &>/dev/null; then
    osascript -e "tell application id \"${BUNDLE_ID}\" to quit" 2>/dev/null || \
      osascript -e "tell application \"${APP_NAME}\" to quit" 2>/dev/null || \
      true
  fi

  if wait_for_app_exit; then
    info "Stopped running ToTally"
    return 0
  fi

  warn "ToTally did not quit; killing it…"
  if command -v pkill &>/dev/null; then
    pkill -x "${APP_NAME}" 2>/dev/null || true
  fi

  if wait_for_app_exit; then
    info "Killed running ToTally"
    return 0
  fi

  err "Could not stop running ToTally; aborting install to avoid replacing a live app."
  return 1
}

# Launch the freshly-installed app.
# The app's AppSettings.defaultLaunchAtLogin = true causes it to register
# itself as a login item on first launch via SMAppService.
launch_app() {
  echo "  Launching ToTally…"
  if open "${INSTALL_DIR}/${BUNDLE_NAME}" 2>/dev/null; then
    info "ToTally launched"
  else
    warn "Could not launch ToTally automatically — open it from /Applications"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  local repo_root="${1:?REPO_ROOT is required}"
  local tray_dir="${repo_root}/clients/macos-tray"

  if [[ ! -f "${tray_dir}/Package.swift" ]]; then
    err "clients/macos-tray/Package.swift not found (expected at: ${tray_dir}/Package.swift)"
    return 1
  fi

  build_bundle "${tray_dir}"
  stop_if_running
  atomic_install "${tray_dir}/dist/${BUNDLE_NAME}"
  launch_app
}

main "$@"
