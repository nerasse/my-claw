#!/bin/bash
set -euo pipefail

# Uninstall my-claw
# Usage: sudo ./uninstall.sh

if [ "$EUID" -ne 0 ]; then
  echo "Error: run as root or with sudo"
  exit 1
fi

# Read install metadata
META_FILE="/etc/my-claw/.install-meta"
if [ ! -f "$META_FILE" ]; then
  echo "Warning: ${META_FILE} not found. Using defaults."
  TARGET_USER=""
  APP_DIR="/opt/my-claw"
else
  TARGET_USER=""
  APP_DIR=""
  while IFS='=' read -r key value; do
    case "$key" in
      USER) TARGET_USER="$value" ;;
      APP_DIR) APP_DIR="$value" ;;
    esac
  done < "$META_FILE"
fi

echo "Uninstalling my-claw..."

# Stop and disable services
for svc in my-claw my-claw-browser-sidecar my-claw-whisper my-claw-chromium my-claw-xvfb my-claw-vnc my-claw-novnc; do
  systemctl stop "${svc}.service" 2>/dev/null || true
  systemctl disable "${svc}.service" 2>/dev/null || true
done

# Remove files
rm -f /usr/local/bin/myclaw
rm -f /usr/local/bin/my-claw-update
rm -f /etc/systemd/system/my-claw*.service
rm -rf /opt/my-claw
rm -rf /etc/my-claw
rm -rf /var/log/my-claw

systemctl daemon-reload

echo "my-claw uninstalled."

if [ -n "$TARGET_USER" ]; then
  echo ""
  echo "Note: user data at ~${TARGET_USER}/.my-claw/ was NOT removed."
  echo "To remove it manually: rm -rf ~${TARGET_USER}/.my-claw/"
fi
