#!/bin/bash
set -uo pipefail

# my-claw auto-update: the maintenance gate, fired every 15 minutes by the user timer.
# 1. Compares the installed version against the latest in the Forgejo registry.
# 2. Skips while an agent run is in flight: the updater's swap window stops services
#    and a live conversation must never be yanked out from under the agent.
# 3. Delegates to packaging/update.sh, which owns the lock, the atomic flip, the rollback
#    and the health check. This script only ever decides.
# 4. Once the server is current, brings the web client bundle to the latest app release.
#
# Fail-open rule: the updater may always run when the server is DOWN (it restarts the
# service, so an update can only help). When the server is up but cannot answer the
# health gate (channel disabled, no paired device), be conservative and retry later.
#
# Root only ever runs this from the legacy system timer, on an install that has not moved to
# user units yet. Its one job there is the same gate, then handing over to the updater, which
# migrates the install (or, when it cannot, updates it the old way).

# Overridable for the packaging tests only; an install always lives here.
APP_DIR="${MY_CLAW_APP_DIR:-/opt/my-claw}"
command -v jq >/dev/null 2>&1 || { echo "Error: jq not found" >&2; exit 1; }

if [ "$EUID" -eq 0 ]; then
  if [ ! -f /etc/my-claw/.install-meta ] || [ -L "${APP_DIR}/current" ]; then
    echo "Error: the legacy system timer is running on a migrated install; disable my-claw-auto-update.timer at the system level" >&2
    exit 1
  fi
  META_FILE="/etc/my-claw/.install-meta"
  ENV_FILE="/etc/my-claw/.env"
  TREE="$APP_DIR"
  UPDATER="/usr/local/bin/my-claw-update"
  UPDATE_LOCK="/var/lock/my-claw-update.lock"
  SYSCTL=(systemctl)
else
  META_FILE="${APP_DIR}/.install-meta"
  TREE="${APP_DIR}/current"
  UPDATER="${TREE}/packaging/update.sh"
  UPDATE_LOCK="${APP_DIR}/.update.lock"
  SYSCTL=(systemctl --user)
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"
fi
[ -f "$META_FILE" ] || { echo "Error: ${META_FILE} missing, install my-claw first" >&2; exit 1; }

TARGET_USER=""
TARGET_HOME=""
while IFS='=' read -r key value; do
  case "$key" in
    USER) TARGET_USER="$value" ;;
    HOME) TARGET_HOME="$value" ;;
  esac
done < "$META_FILE"
[ -n "$TARGET_HOME" ] || { echo "Error: corrupt install metadata in ${META_FILE}" >&2; exit 1; }
if [ "$EUID" -ne 0 ]; then
  ENV_FILE="${TARGET_HOME}/.my-claw/.env"
fi

FORGEJO_URL=""
FORGEJO_TOKEN=""
if [ -f "$ENV_FILE" ]; then
  while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" =~ ^# ]] && continue
    value="$(echo "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | sed 's/^["\'"'"']//;s/["\'"'"']$//')"
    case "$key" in
      FORGEJO_URL) FORGEJO_URL="$value" ;;
      FORGEJO_TOKEN) FORGEJO_TOKEN="$value" ;;
      FORGEJO_USER) FORGEJO_USER="$value" ;;
    esac
  done < "$ENV_FILE"
fi

# An update already under way (a `myclaw update`, or the previous tick still swapping) stops the
# server, which the gate below reads as a free pass: the updater would start again only to die on
# its own lock and leave this unit failed. Asked first, on the lock the updater takes.
if [ -e "$UPDATE_LOCK" ] && command -v flock >/dev/null 2>&1; then
  if ! flock -n "$UPDATE_LOCK" true 2>/dev/null; then
    echo "my-claw auto-update: an update is already running, retrying in 15 minutes"
    exit 0
  fi
fi

INSTALLED="$(jq -r .version "${TREE}/package.json" 2>/dev/null || true)"
if [ -z "$INSTALLED" ] || [ "$INSTALLED" = "null" ]; then
  echo "Error: cannot read the installed version from ${TREE}/package.json" >&2
  exit 1
fi

# The health gate only exists while the server is up; a dead server is a free pass. Returns 0
# when the update may proceed, 1 when this round must be skipped (the reason is printed).
run_gate() {
  local config_file port device did token health active
  if ! "${SYSCTL[@]}" is-active --quiet my-claw.service 2>/dev/null; then
    return 0
  fi
  config_file="${TARGET_HOME}/.my-claw/config.json"
  [ -f "$config_file" ] || return 0
  port="$(jq -r '.channels["my-claw-app"].port // 8080' "$config_file" 2>/dev/null || echo 8080)"
  device="$(jq -r '.channels["my-claw-app"].devices | to_entries[] | select(.value.enabled != false and ((.value.token | length) > 0)) | "\(.key)\t\(.value.token)"' "$config_file" 2>/dev/null | head -1 || true)"
  if [ -z "$device" ]; then
    echo "Warning: no enabled my-claw-app device to ask the health gate, skipping this round"
    return 1
  fi
  did="${device%%$'\t'*}"
  token="${device#*$'\t'}"
  health="$(curl -fsS --max-time 5 "http://127.0.0.1:${port}/health?device=${did}&token=${token}" 2>/dev/null || true)"
  # Not `.activeRun // "unknown"`: jq's alternative operator treats false as absent, so the
  # idle answer, the one case that must let the update through, read as unknown and the gate
  # never opened. Ask for the type instead, and let anything else be unknown.
  active="$(echo "$health" | jq -r 'if (.activeRun | type) == "boolean" then (.activeRun | tostring) else "unknown" end' 2>/dev/null || echo unknown)"
  [ -n "$active" ] || active="unknown"
  if [ "$active" = "true" ]; then
    echo "my-claw auto-update: an agent run is in flight, retrying in 15 minutes"
    return 1
  fi
  if [ "$active" != "false" ]; then
    echo "Warning: health gate unreachable, skipping this round"
    return 1
  fi
  return 0
}

# Legacy root: a release that ships user units is installed, and the machine has not moved yet.
# The move stops the server like an update does, so it waits for the same idle moment; the
# updater decides whether the move is possible here.
if [ "$EUID" -eq 0 ] && [ -d "${TREE}/units" ] && [ "$TARGET_USER" != "root" ]; then
  stamp="/etc/my-claw/.migration-failed"
  if [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$INSTALLED" ]; then
    echo "my-claw auto-update: ${INSTALLED} is installed under the legacy layout, moving to user units..."
    run_gate || exit 0
    exec "$UPDATER"
  fi
fi

if [ -z "$FORGEJO_URL" ] || [ -z "$FORGEJO_TOKEN" ]; then
  echo "Warning: FORGEJO_URL/FORGEJO_TOKEN missing in ${ENV_FILE}, cannot check the registry"
  exit 0
fi

# ---------------------------------------------------------------------------
# The web client bundle
#
# A second artifact, released from the app repository and served straight off
# ${TARGET_HOME}/.my-claw/web/current by the running server. The steps live in
# packaging/web-bundle.sh, shared with the manual updater so the timer and
# `myclaw update` can never disagree about what "up to date" means.
# ---------------------------------------------------------------------------

# shellcheck disable=SC2034  # read by web-bundle.sh, sourced just below
WEB_LOG_PREFIX="my-claw auto-update"
WEB_HELPER="${TREE}/packaging/web-bundle.sh"
if [ -f "$WEB_HELPER" ]; then
  # shellcheck source=/dev/null
  . "$WEB_HELPER"
else
  echo "Warning: ${WEB_HELPER} missing, the web bundle is left alone this round"
  web_bundle_step() { return 0; }
fi

echo "my-claw auto-update: installed ${INSTALLED}, checking registry..."
LATEST="$(curl -fsS --max-time 30 --user "${FORGEJO_USER:-neras}:${FORGEJO_TOKEN}" \
  -H "Accept: application/json" \
  "${FORGEJO_URL}/api/v1/packages/claw" 2>/dev/null | \
  jq -r --arg pkg "my-claw" '.[] | select(.name == $pkg and .type == "generic") | .version' | \
  sort -V | tail -1 || true)"
if [ -z "$LATEST" ] || [ "$LATEST" = "null" ]; then
  echo "Warning: could not resolve the latest version, retrying in 15 minutes"
  exit 0
fi

# The bundle is only ever updated behind a current server. The two version independently and
# nothing checks that a given pair speaks the same protocol, so the ordering rule is that the
# bundle never gets ahead: a bundle sending frames the deployed server does not know yields
# buttons that die in silence, while a bundle one release behind merely lacks a feature.
if [ "$INSTALLED" = "$LATEST" ]; then
  echo "my-claw auto-update: up to date (${INSTALLED})"
  web_bundle_step
  exit 0
fi
echo "my-claw auto-update: ${LATEST} available (installed ${INSTALLED})"
run_gate || exit 0

echo "my-claw auto-update: installing ${LATEST}..."
exec "$UPDATER"
