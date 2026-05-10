#!/bin/bash
set -euo pipefail

# Update my-claw from Forgejo Package Registry
# Usage: sudo my-claw-update [version]
# If no version provided, fetches latest

if [ "$EUID" -ne 0 ]; then
  echo "Error: run as root or with sudo"
  exit 1
fi

# Read install metadata
META_FILE="/etc/my-claw/.install-meta"
if [ ! -f "$META_FILE" ]; then
  echo "Error: ${META_FILE} not found. Install my-claw first."
  exit 1
fi

TARGET_USER=""
TARGET_HOME=""
APP_DIR=""
while IFS='=' read -r key value; do
  case "$key" in
    USER) TARGET_USER="$value" ;;
    HOME) TARGET_HOME="$value" ;;
    APP_DIR) APP_DIR="$value" ;;
  esac
done < "$META_FILE"

if [ -z "$TARGET_USER" ] || [ -z "$TARGET_HOME" ] || [ -z "$APP_DIR" ]; then
  echo "Error: corrupt install metadata in ${META_FILE}"
  exit 1
fi

ENV_FILE="/etc/my-claw/.env"

# Read token and URL from env file
if [ ! -f "$ENV_FILE" ]; then
  echo "Error: ${ENV_FILE} not found."
  echo "Install my-claw first and configure ${ENV_FILE}"
  exit 1
fi

FORGEJO_URL=""
FORGEJO_TOKEN=""

while IFS='=' read -r key value; do
  [[ -z "$key" || "$key" =~ ^# ]] && continue
  value="$(echo "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | sed 's/^["\'"'"']//;s/["\'"'"']$//')"
  case "$key" in
    FORGEJO_URL) FORGEJO_URL="$value" ;;
    FORGEJO_TOKEN) FORGEJO_TOKEN="$value" ;;
  esac
done < "$ENV_FILE"

if [ -z "$FORGEJO_URL" ]; then
  echo "Error: FORGEJO_URL is empty or missing in ${ENV_FILE}"
  exit 1
fi

if [ -z "$FORGEJO_TOKEN" ]; then
  echo "Error: FORGEJO_TOKEN is empty or missing in ${ENV_FILE}"
  echo "Get a token from ${FORGEJO_URL}/user/settings/applications"
  exit 1
fi

OWNER="claw"
PACKAGE="my-claw"
VERSION="${1:-latest}"

if [ "$VERSION" = "latest" ]; then
  echo "Checking latest version..."
  VERSION=$(curl -fsS -H "Authorization: token ${FORGEJO_TOKEN}" \
    "${FORGEJO_URL}/api/packages/${OWNER}/generic/${PACKAGE}" | \
    jq -r '.[] | select(.type == "generic") | .version' | \
    sort -V | tail -1)
  if [ -z "$VERSION" ] || [ "$VERSION" = "null" ]; then
    echo "Error: could not determine latest version"
    exit 1
  fi
  echo "Latest version: ${VERSION}"
fi

TAR_FILE="my-claw-${VERSION}-linux-x64.tar.gz"
URL="${FORGEJO_URL}/api/packages/${OWNER}/generic/${PACKAGE}/${VERSION}/${TAR_FILE}"
TMP_DIR="$(mktemp -d)"

echo "Downloading ${TAR_FILE}..."
curl -fsSL -H "Authorization: token ${FORGEJO_TOKEN}" "$URL" -o "${TMP_DIR}/${TAR_FILE}"

echo "Extracting..."
tar xzf "${TMP_DIR}/${TAR_FILE}" -C "${TMP_DIR}"
EXTRACT_DIR="${TMP_DIR}/my-claw-${VERSION}-linux-x64"

# Backup existing config before overwrite
if [ -f "${TARGET_HOME}/.my-claw/config.json" ]; then
  cp "${TARGET_HOME}/.my-claw/config.json" "${TMP_DIR}/config.json.backup"
fi
if [ -f /etc/my-claw/config.json ]; then
  cp /etc/my-claw/config.json "${TMP_DIR}/config.json.sys.backup"
fi

echo "Stopping services..."
for svc in my-claw my-claw-whisper my-claw-chromium my-claw-vnc my-claw-novnc; do
  systemctl stop "${svc}.service" 2>/dev/null || true
done

echo "Installing..."
rm -rf "${APP_DIR}"/*
cp -r "${EXTRACT_DIR}"/* "${APP_DIR}/"
chown -R root:root "${APP_DIR}"

# Restore config if it existed
if [ -f "${TMP_DIR}/config.json.backup" ]; then
  cp "${TMP_DIR}/config.json.backup" "${TARGET_HOME}/.my-claw/config.json"
  chown "${TARGET_USER}:${TARGET_USER}" "${TARGET_HOME}/.my-claw/config.json"
fi
if [ -f "${TMP_DIR}/config.json.sys.backup" ]; then
  cp "${TMP_DIR}/config.json.sys.backup" /etc/my-claw/config.json
fi

# Regenerate systemd services from templates
BUN_PATH="$(command -v bun || true)"
PYTHON_PATH="$(command -v python3 || command -v python || true)"

for template in "${EXTRACT_DIR}/templates/"*.service; do
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

# Re-install update script
cp "${EXTRACT_DIR}/update.sh" /usr/local/bin/my-claw-update
chmod 755 /usr/local/bin/my-claw-update

# Re-install CLI wrapper
cp "${APP_DIR}/scripts/myclaw.sh" /usr/local/bin/myclaw
chmod 755 /usr/local/bin/myclaw

# Clean up temp dir
rm -rf "$TMP_DIR"

systemctl daemon-reload

echo "Starting services..."
systemctl start my-claw-xvfb.service
systemctl start my-claw-chromium.service
systemctl start my-claw-whisper.service
systemctl start my-claw-vnc.service
systemctl start my-claw-novnc.service
systemctl start my-claw.service

echo ""
echo "Updated to my-claw ${VERSION}"
echo "Check status: sudo systemctl status my-claw"
