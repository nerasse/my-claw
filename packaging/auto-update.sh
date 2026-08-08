#!/bin/bash
set -uo pipefail

# my-claw-auto-update — maintenance gate, fired every 15 minutes by the systemd timer.
# 1. Compares the installed version against the latest in the Forgejo registry.
# 2. Skips while an agent run is in flight: the updater's swap window stops services
#    and a live conversation must never be yanked out from under the agent.
# 3. Delegates to my-claw-update, which owns the lock, the atomic swap, the rollback
#    and the health check. This script only ever decides.
#
# Fail-open rule: the updater may always run when the server is DOWN (it restarts the
# service, so an update can only help). When the server is up but cannot answer the
# health gate (channel disabled, no paired device), be conservative and retry later.

META_FILE="/etc/my-claw/.install-meta"
ENV_FILE="/etc/my-claw/.env"

if [ "$EUID" -ne 0 ]; then
  echo "Error: my-claw-auto-update must run as root (systemd timer)" >&2
  exit 1
fi
[ -f "$META_FILE" ] || { echo "Error: ${META_FILE} missing — install my-claw first" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "Error: ${ENV_FILE} missing" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "Error: jq not found" >&2; exit 1; }

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
[ -n "$APP_DIR" ] || { echo "Error: corrupt install metadata in ${META_FILE}" >&2; exit 1; }

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
if [ -z "$FORGEJO_URL" ] || [ -z "$FORGEJO_TOKEN" ]; then
  echo "Error: FORGEJO_URL/FORGEJO_TOKEN missing in ${ENV_FILE}" >&2
  exit 1
fi

INSTALLED="$(jq -r .version "$APP_DIR/package.json" 2>/dev/null || true)"
if [ -z "$INSTALLED" ] || [ "$INSTALLED" = "null" ]; then
  echo "Error: cannot read the installed version from ${APP_DIR}/package.json" >&2
  exit 1
fi

echo "my-claw auto-update: installed ${INSTALLED}, checking registry..."
LATEST="$(curl -fsS --max-time 30 --user "${FORGEJO_USER:-neras}:${FORGEJO_TOKEN}" \
  -H "Accept: application/json" \
  "${FORGEJO_URL}/api/v1/packages/claw" 2>/dev/null | \
  jq -r --arg pkg "my-claw" '.[] | select(.name == $pkg and .type == "generic") | .version' | \
  sort -V | tail -1 || true)"
if [ -z "$LATEST" ] || [ "$LATEST" = "null" ]; then
  echo "Warning: could not resolve the latest version — retrying in 15 minutes"
  exit 0
fi

if [ "$INSTALLED" = "$LATEST" ]; then
  echo "my-claw auto-update: up to date (${INSTALLED})"
  exit 0
fi
echo "my-claw auto-update: ${LATEST} available (installed ${INSTALLED})"

# The health gate only exists while the server is up; a dead server is a free pass.
if systemctl is-active --quiet my-claw.service 2>/dev/null; then
  CONFIG_FILE="${TARGET_HOME}/.my-claw/config.json"
  if [ -f "$CONFIG_FILE" ]; then
    PORT="$(jq -r '.channels["my-claw-app"].port // 8080' "$CONFIG_FILE" 2>/dev/null || echo 8080)"
    DEVICE="$(jq -r '.channels["my-claw-app"].devices | to_entries[] | select(.value.enabled != false and ((.value.token | length) > 0)) | "\(.key)\t\(.value.token)"' "$CONFIG_FILE" 2>/dev/null | head -1 || true)"
    if [ -n "$DEVICE" ]; then
      DID="${DEVICE%%$'\t'*}"
      TOKEN="${DEVICE#*$'\t'}"
      HEALTH="$(curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/health?device=${DID}&token=${TOKEN}" 2>/dev/null || true)"
      # Not `.activeRun // "unknown"`: jq's alternative operator treats false as absent, so the
      # idle answer -- the one case that must let the update through -- read as unknown and the
      # gate never opened. Ask for the type instead, and let anything else be unknown.
      ACTIVE="$(echo "$HEALTH" | jq -r 'if (.activeRun | type) == "boolean" then (.activeRun | tostring) else "unknown" end' 2>/dev/null || echo unknown)"
      [ -n "$ACTIVE" ] || ACTIVE="unknown"
      if [ "$ACTIVE" = "true" ]; then
        echo "my-claw auto-update: ${LATEST} available, but an agent run is in flight — retrying in 15 minutes"
        exit 0
      fi
      if [ "$ACTIVE" != "false" ]; then
        echo "Warning: health gate unreachable — skipping this round"
        exit 0
      fi
    else
      echo "Warning: no enabled my-claw-app device to ask the health gate — skipping this round"
      exit 0
    fi
  fi
fi

echo "my-claw auto-update: installing ${LATEST}..."
exec my-claw-update
