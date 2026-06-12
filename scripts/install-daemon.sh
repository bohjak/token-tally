#!/usr/bin/env bash
# scripts/install-daemon.sh — Install and start the token-tally drain daemon.
#
# Registers the daemon with the platform init system so it starts automatically
# on login and restarts on crash:
#   macOS  → ~/Library/LaunchAgents/com.token-tally.daemon.plist  (launchd)
#   Linux  → ~/.config/systemd/user/token-tally-daemon.service    (systemd --user)
#
# If neither launchd nor systemd is available the script warns and exits 0 so
# the installer can continue; users can start the daemon manually with:
#   token-tally daemon
#
# Arguments:
#   $1  BIN_PATH — absolute path to the token-tally binary
#   $2  LOG_DIR  — absolute path to the log directory for daemon stdout/stderr
#
# Exit codes:
#   0   success or non-fatal skip (launchd/systemd unavailable)
#   1   hard failure (plist/unit write failed, launchctl/systemctl failed)
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
# macOS — launchd
# ---------------------------------------------------------------------------

install_macos() {
  local bin_path="$1"
  local log_dir="$2"

  local plist_dir="${HOME}/Library/LaunchAgents"
  local plist_label="com.token-tally.daemon"
  local plist_path="${plist_dir}/${plist_label}.plist"
  local log_path="${log_dir}/daemon.log"

  mkdir -p "${plist_dir}" "${log_dir}"

  # Write the launchd plist. ThrottleInterval caps the rate at which launchd
  # will respawn the daemon after an unexpected exit, avoiding a tight restart
  # loop if the binary fails immediately (e.g. DB locked at startup).
  cat > "${plist_path}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${plist_label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${bin_path}</string>
        <string>daemon</string>
        <string>--interval</string>
        <string>30s</string>
        <string>--max-files</string>
        <string>200</string>
        <string>--max-time</string>
        <string>30s</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>StandardOutPath</key>
    <string>${log_path}</string>
    <key>StandardErrorPath</key>
    <string>${log_path}</string>
</dict>
</plist>
EOF

  info "Launchd plist written to ${plist_path}"

  # Unload any previously registered agent, then bootstrap with the new plist.
  # macOS 14 deprecated launchctl load/unload in favour of bootstrap/bootout;
  # using the modern API avoids deprecation warnings in system logs.
  # bootout is idempotent: it exits non-zero if the service was never loaded,
  # so we always suppress its exit code.
  local launchd_domain
  launchd_domain="gui/$(id -u)"
  local service_target="${launchd_domain}/${plist_label}"

  launchctl bootout "${service_target}" 2>/dev/null || true

  # launchctl bootout can return before launchd has fully removed the service.
  # Bootstrapping immediately in that window can fail with a misleading
  # "Bootstrap failed: 5: Input/output error" even though retrying moments later
  # succeeds. Wait briefly for the service target to disappear before loading
  # the freshly written plist.
  local _
  for _ in {1..20}; do
    if ! launchctl print "${service_target}" >/dev/null 2>&1; then
      break
    fi
    sleep 0.1
  done

  if launchctl bootstrap "${launchd_domain}" "${plist_path}"; then
    info "Daemon registered with launchd (starts at login, restarts on crash)"
    info "Logs: ${log_path}"
    return 0
  fi

  # A failed bootstrap may still have registered the service. Treat that as a
  # degraded success so reinstall remains idempotent and users are not told to
  # start a daemon that launchd is already managing.
  if launchctl print "${service_target}" >/dev/null 2>&1; then
    warn "launchctl bootstrap reported an error, but the daemon is loaded"
    info "Logs: ${log_path}"
    return 0
  fi

  err "launchctl bootstrap failed — daemon plist written but not loaded"
  warn "Start manually with: token-tally daemon"
  return 1
}

# ---------------------------------------------------------------------------
# Linux — systemd --user
# ---------------------------------------------------------------------------

install_linux() {
  local bin_path="$1"
  local log_dir="$2"

  local unit_dir="${HOME}/.config/systemd/user"
  local unit_path="${unit_dir}/token-tally-daemon.service"

  mkdir -p "${unit_dir}" "${log_dir}"

  cat > "${unit_path}" <<EOF
[Unit]
Description=token-tally drain daemon
After=default.target

[Service]
ExecStart=${bin_path} daemon --interval 30s --max-files 200 --max-time 30s
Restart=on-failure
RestartSec=30s
StandardOutput=append:${log_dir}/daemon.log
StandardError=append:${log_dir}/daemon.log

[Install]
WantedBy=default.target
EOF

  info "Systemd unit written to ${unit_path}"

  if ! command -v systemctl &>/dev/null; then
    warn "systemctl not found — unit written but not enabled"
    warn "Start manually with: token-tally daemon"
    return 0
  fi

  systemctl --user daemon-reload || true

  if systemctl --user enable --now token-tally-daemon 2>/dev/null; then
    info "Daemon enabled and started via systemd --user"
    info "Logs: journalctl --user -u token-tally-daemon -f"
    return 0
  else
    warn "systemctl enable failed — unit written but not started"
    warn "Start manually with: systemctl --user start token-tally-daemon"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  local bin_path="${1:?BIN_PATH is required}"
  local log_dir="${2:?LOG_DIR is required}"

  if [[ ! -x "${bin_path}" ]]; then
    err "Binary not found or not executable: ${bin_path}"
    return 1
  fi

  case "$(uname -s)" in
    Darwin)
      install_macos "${bin_path}" "${log_dir}"
      ;;
    Linux)
      install_linux "${bin_path}" "${log_dir}"
      ;;
    *)
      warn "Unrecognised platform ($(uname -s)) — daemon not registered automatically"
      warn "Start manually with: token-tally daemon"
      # Non-fatal: other platforms still get the CLI, just no auto-start.
      return 0
      ;;
  esac
}

main "$@"
