#!/bin/bash
set -euo pipefail

# Install my-claw from tarball
# Usage: sudo ./install.sh [--user <username>]
# If --user not provided, detects from $SUDO_USER or asks

if [ "$EUID" -ne 0 ]; then
  echo "Error: run with sudo or as root"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Parse --user flag
TARGET_USER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --user)
      shift
      TARGET_USER="${1:-}"
      shift
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: sudo ./install.sh [--user <username>]"
      exit 1
      ;;
  esac
done

# Detect target user
if [ -z "$TARGET_USER" ]; then
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
    TARGET_USER="$SUDO_USER"
    echo "Detected user from sudo: ${TARGET_USER}"
  else
    read -p "Install my-claw for which user? " TARGET_USER
    if [ -z "$TARGET_USER" ]; then
      echo "Error: username required"
      exit 1
    fi
  fi
fi

if ! id -u "$TARGET_USER" >/dev/null 2>&1; then
  echo "Error: user '${TARGET_USER}' does not exist"
  exit 1
fi

TARGET_HOME="$(eval echo "~$TARGET_USER")"
BUN_PATH="$(command -v bun || true)"
PYTHON_PATH="$(command -v python3 || command -v python || true)"

if [ -z "$BUN_PATH" ]; then
  echo "Error: bun is required but not installed."
  echo "Install it: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

if [ -z "$PYTHON_PATH" ]; then
  echo "Error: python3 is required but not installed."
  exit 1
fi

echo "Installing my-claw for user: ${TARGET_USER}"
echo "Home directory: ${TARGET_HOME}"
echo "Bun path: ${BUN_PATH}"

# Check and auto-install deps
MISSING_BINS=""
for dep in ffmpeg chromium Xvfb x11vnc websockify; do
  if ! command -v "$dep" >/dev/null 2>&1; then
    MISSING_BINS="$MISSING_BINS $dep"
  fi
done

if [ -n "$MISSING_BINS" ]; then
  echo ""
  echo "Missing dependencies detected. Auto-installing..."
  echo ""

  if command -v apt-get >/dev/null 2>&1; then
    echo "Detected: apt-get"
    apt-get update
    apt-get install -y ffmpeg chromium xvfb x11vnc websockify
  elif command -v pacman >/dev/null 2>&1; then
    echo "Detected: pacman"
    pacman -S --needed --noconfirm ffmpeg chromium xorg-server-xvfb x11vnc python-websockify
  elif command -v dnf >/dev/null 2>&1; then
    echo "Detected: dnf"
    dnf install -y ffmpeg chromium Xvfb x11vnc python-websockify
  else
    echo "Warning: could not detect package manager. Install manually:"
    echo "  ffmpeg, chromium, Xvfb, x11vnc, websockify"
  fi
  echo ""
fi

# Create directories
mkdir -p /etc/my-claw
mkdir -p "${TARGET_HOME}/.my-claw"
mkdir -p /var/log/my-claw
chown "${TARGET_USER}:${TARGET_USER}" "${TARGET_HOME}/.my-claw"
chown -R "${TARGET_USER}:${TARGET_USER}" /var/log/my-claw

# Install app to /opt
APP_DIR="/opt/my-claw"
mkdir -p "${APP_DIR}"
rm -rf "${APP_DIR}"/*
cp -r "${SCRIPT_DIR}"/* "${APP_DIR}/"
chown -R root:root "${APP_DIR}"

# Install config templates
if [ ! -f /etc/my-claw/config.json ]; then
  cp "${SCRIPT_DIR}/etc/config.json" /etc/my-claw/
  chmod 644 /etc/my-claw/config.json
  echo "Installed config template to /etc/my-claw/config.json"
fi

if [ ! -f /etc/my-claw/.env ]; then
  cp "${SCRIPT_DIR}/etc/.env.example" /etc/my-claw/.env
  chmod 600 /etc/my-claw/.env
  echo "Installed env template to /etc/my-claw/.env"
fi

# Install config in user home (where the app reads it)
if [ ! -f "${TARGET_HOME}/.my-claw/config.json" ]; then
  cp "${SCRIPT_DIR}/etc/config.json" "${TARGET_HOME}/.my-claw/"
  chmod 644 "${TARGET_HOME}/.my-claw/config.json"
  chown "${TARGET_USER}:${TARGET_USER}" "${TARGET_HOME}/.my-claw/config.json"
fi

# Generate systemd services from templates
for template in "${SCRIPT_DIR}/templates/"*.service; do
  [ -e "$template" ] || continue
  svc_name="$(basename "$template")"
  sed -e "s|{{USER}}|${TARGET_USER}|g" \
      -e "s|{{HOME}}|${TARGET_HOME}|g" \
      -e "s|{{BUN}}|${BUN_PATH}|g" \
      -e "s|{{PYTHON}}|${PYTHON_PATH}|g" \
      -e "s|{{APP_DIR}}|${APP_DIR}|g" \
      "$template" > "/etc/systemd/system/${svc_name}"
  chmod 644 "/etc/systemd/system/${svc_name}"
done

# Install update script
cp "${SCRIPT_DIR}/update.sh" /usr/local/bin/my-claw-update
chmod 755 /usr/local/bin/my-claw-update

# Install CLI wrapper
cp "${APP_DIR}/scripts/myclaw.sh" /usr/local/bin/myclaw
chmod 755 /usr/local/bin/myclaw

# Store install metadata for update/uninstall
mkdir -p /etc/my-claw
cat > /etc/my-claw/.install-meta <<EOF
USER=${TARGET_USER}
HOME=${TARGET_HOME}
APP_DIR=${APP_DIR}
EOF
chmod 644 /etc/my-claw/.install-meta

# Reload systemd
systemctl daemon-reload

# Enable services
systemctl enable my-claw-xvfb.service
systemctl enable my-claw-chromium.service
systemctl enable my-claw-whisper.service
systemctl enable my-claw-vnc.service
systemctl enable my-claw-novnc.service
systemctl enable my-claw.service

echo ""
echo "my-claw installed for user: ${TARGET_USER}"
echo "Next steps:"
echo "  1. Edit /etc/my-claw/.env with your secrets"
echo "  2. Edit ${TARGET_HOME}/.my-claw/config.json if needed"
echo "  3. Start: sudo systemctl start my-claw"
echo "  4. Check: sudo systemctl status my-claw"
echo ""
echo "Update later with: sudo my-claw-update"
