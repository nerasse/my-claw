#!/bin/bash
set -euo pipefail

# Uninstall my-claw
# Usage: sudo ./uninstall.sh
#
# Handles both layouts: the current one (user-owned /opt/my-claw, systemd user units) and the
# legacy one (root-owned tree, system units, /etc/my-claw).

if [ "$EUID" -ne 0 ]; then
  echo "Error: run as root or with sudo"
  exit 1
fi

APP_DIR="/opt/my-claw"
TARGET_USER=""
TARGET_HOME=""
read_meta() {
  local key value
  while IFS='=' read -r key value; do
    case "$key" in
      USER) TARGET_USER="$value" ;;
      HOME) TARGET_HOME="$value" ;;
    esac
  done < "$1"
}
if [ -f "${APP_DIR}/.install-meta" ]; then
  read_meta "${APP_DIR}/.install-meta"
elif [ -f /etc/my-claw/.install-meta ]; then
  read_meta /etc/my-claw/.install-meta
else
  echo "Warning: no install metadata found. Removing what can be found."
fi

echo "Uninstalling my-claw..."

UNITS="my-claw my-claw-browser-sidecar my-claw-whisper my-claw-chromium my-claw-xvfb my-claw-vnc my-claw-novnc my-claw-auto-update"

# User units, if the service user is known and has a manager.
if [ -n "$TARGET_USER" ] && [ "$TARGET_USER" != "root" ] && id -u "$TARGET_USER" >/dev/null 2>&1; then
  uid="$(id -u "$TARGET_USER")"
  user_ctl() {
    runuser -u "$TARGET_USER" -- env "XDG_RUNTIME_DIR=/run/user/${uid}" \
      "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus" systemctl --user "$@"
  }
  for svc in $UNITS; do
    user_ctl disable --now "${svc}.service" >/dev/null 2>&1 || true
  done
  user_ctl disable --now my-claw-auto-update.timer >/dev/null 2>&1 || true
  if [ -n "$TARGET_HOME" ]; then
    rm -f "${TARGET_HOME}/.config/systemd/user"/my-claw*.service "${TARGET_HOME}/.config/systemd/user"/my-claw*.timer
  fi
  user_ctl daemon-reload >/dev/null 2>&1 || true
fi

# System units, legacy layout.
for svc in $UNITS; do
  systemctl stop "${svc}.service" 2>/dev/null || true
  systemctl disable "${svc}.service" 2>/dev/null || true
done
systemctl stop my-claw-auto-update.timer 2>/dev/null || true
systemctl disable my-claw-auto-update.timer 2>/dev/null || true
rm -f /etc/systemd/system/my-claw*.service /etc/systemd/system/my-claw*.timer
systemctl daemon-reload

rm -f /usr/local/bin/myclaw /usr/local/bin/my-claw-update /usr/local/bin/my-claw-auto-update
rm -rf "$APP_DIR" "${APP_DIR}".prev "${APP_DIR}".staging-* /etc/my-claw /etc/my-claw.migrated /var/log/my-claw
rm -f /var/lock/my-claw-update.lock

echo "my-claw uninstalled."
if [ -n "$TARGET_USER" ]; then
  echo ""
  echo "Kept: ${TARGET_HOME:-~${TARGET_USER}}/.my-claw/ (config, secrets, sessions). Remove it by hand for a clean slate."
  echo "Kept: linger for ${TARGET_USER} (other user services may rely on it): loginctl disable-linger ${TARGET_USER}"
fi
