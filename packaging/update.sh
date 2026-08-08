#!/bin/bash
set -euo pipefail

# Update my-claw from Forgejo Package Registry
# Usage: sudo my-claw-update [version]
# If no version provided, fetches latest.
#
# Failure-safety model:
# - Everything destructive happens as late as possible: download, extract, verify and
#   stage the full new tree BEFORE any service is stopped or any file of the current
#   install is touched.
# - The current install is swapped out via rename(2) (same filesystem), and kept as
#   ${APP_DIR}.prev until the next successful update — manual rollback is one `mv` away.
# - An EXIT trap removes temp artifacts and, if anything fails after the stop point,
#   restores the previous tree and restarts services. The machine never stays down.

if [ "$EUID" -ne 0 ]; then
  echo "Error: run as root or with sudo"
  exit 1
fi

# ---------------------------------------------------------------------------
# Install metadata + credentials
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# Single-instance lock: two concurrent updates would interleave swaps and
# service restarts into an unrecoverable state.
# ---------------------------------------------------------------------------
LOCK_FILE="/var/lock/my-claw-update.lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Error: another my-claw update is already running (lock: ${LOCK_FILE})"
  exit 1
fi

# ---------------------------------------------------------------------------
# Resolve version
# ---------------------------------------------------------------------------
OWNER="claw"
PACKAGE="my-claw"
VERSION="${1:-latest}"

if [ "$VERSION" = "latest" ]; then
  echo "Checking latest version..."
  VERSION=$(curl -fsS --user "${FORGEJO_USER:-neras}:${FORGEJO_TOKEN}" \
    -H "Accept: application/json" \
    "${FORGEJO_URL}/api/v1/packages/${OWNER}" | \
    jq -r --arg pkg "${PACKAGE}" '.[] | select(.name == $pkg and .type == "generic") | .version' | \
    sort -V | tail -1)
  if [ -z "$VERSION" ] || [ "$VERSION" = "null" ]; then
    echo "Error: could not determine latest version"
    exit 1
  fi
  echo "Latest version: ${VERSION}"
fi

TAR_FILE="my-claw-${VERSION}-linux-x64.tar.gz"
URL="${FORGEJO_URL}/api/packages/${OWNER}/generic/${PACKAGE}/${VERSION}/${TAR_FILE}"

# ---------------------------------------------------------------------------
# Disk space preflight.
# /var/tmp (disk-backed) instead of /tmp: /tmp is a RAM tmpfs on typical installs
# and a ~1GB extraction can eat it entirely (seen in production: tar ENOSPC).
# ---------------------------------------------------------------------------
TMP_BASE="/var/tmp"
avail_bytes() { df --output=avail -B1 "$1" 2>/dev/null | tail -1 | tr -d ' ' || true; }

# Stale artifacts from previous failed/killed updates are the most common reason
# space runs out — sweep them first, they are always safe to delete under the lock.
clean_stale_artifacts() {
  rm -rf "${TMP_BASE}"/my-claw-update.* 2>/dev/null || true
  rm -rf "${APP_DIR}".staging-* 2>/dev/null || true
}
clean_stale_artifacts

# `|| true`: the registry may not answer HEAD at all — under `set -e` a failing
# command substitution in an assignment silently kills the whole script.
TARBALL_BYTES=$(curl -fsSI --user "${FORGEJO_USER:-neras}:${FORGEJO_TOKEN}" "$URL" 2>/dev/null \
  | tr -d '\r' | awk 'tolower($1)=="content-length:" {print $2}' | tail -1 || true)
# No Content-Length (HEAD unsupported or proxy stripped it): assume a conservative 500MB tarball.
[ -n "${TARBALL_BYTES:-}" ] || TARBALL_BYTES=$((500 * 1024 * 1024))

# tarball + extracted tree (~4x compressed size, node_modules dominated) in TMP_BASE,
# plus one staged copy of the extracted tree next to APP_DIR.
NEED_TMP=$((TARBALL_BYTES * 5))
NEED_APP=$((TARBALL_BYTES * 4))

check_space() {
  local dir="$1" need="$2" label="$3"
  local have
  have=$(avail_bytes "$dir")
  if [ -z "$have" ] || [ "$have" -lt "$need" ]; then
    echo "Error: not enough space in ${label} (${dir}): need $((need / 1024 / 1024)) MB, have $(( ${have:-0} / 1024 / 1024)) MB" >&2
    return 1
  fi
}

if ! check_space "$TMP_BASE" "$NEED_TMP" "temp dir"; then
  # Best-effort sweep of known my-claw runtime debris in /tmp and TMP_BASE before
  # giving up — old media/screenshots left by crashed runs, never live data.
  echo "Attempting cleanup of stale my-claw temp files..."
  find /tmp "$TMP_BASE" -maxdepth 1 \( -name 'my-claw-*' -o -name 'tts-*' -o -name 'browser-*.png' \) \
    -mmin +60 -exec rm -rf {} + 2>/dev/null || true
  check_space "$TMP_BASE" "$NEED_TMP" "temp dir" || exit 1
fi
check_space "$(dirname "$APP_DIR")" "$NEED_APP" "app dir parent" || exit 1

# ---------------------------------------------------------------------------
# Failure handling: from here on, every exit path cleans temp files; once
# services are stopped, every failure path restores the old tree and restarts.
# ---------------------------------------------------------------------------
TMP_DIR="$(mktemp -d "${TMP_BASE}/my-claw-update.XXXXXX")"
STAGING_DIR="${APP_DIR}.staging-$$"
PREV_DIR="${APP_DIR}.prev"
SERVICES_STOPPED=0
SWAPPED=0

start_services() {
  systemctl start my-claw-xvfb.service 2>/dev/null || true
  systemctl start my-claw-chromium.service 2>/dev/null || true
  [ -n "${NODE_PATH:-}" ] && systemctl start my-claw-browser-sidecar.service 2>/dev/null || true
  systemctl start my-claw-whisper.service 2>/dev/null || true
  systemctl start my-claw-vnc.service 2>/dev/null || true
  systemctl start my-claw-novnc.service 2>/dev/null || true
  systemctl start my-claw.service 2>/dev/null || true
}

stop_services() {
  for svc in my-claw my-claw-browser-sidecar my-claw-whisper my-claw-chromium my-claw-vnc my-claw-novnc; do
    systemctl stop "${svc}.service" 2>/dev/null || true
  done
}

on_exit() {
  local code=$?
  rm -rf "$TMP_DIR" "$STAGING_DIR" 2>/dev/null || true
  if [ "$code" -ne 0 ]; then
    echo "" >&2
    echo "Update FAILED (exit ${code})." >&2
    if [ "$SWAPPED" -eq 1 ] && [ -d "$PREV_DIR" ]; then
      echo "Rolling back to previous version..." >&2
      # Services may be running on the broken new tree (failed health check) —
      # never yank a tree out from under live processes.
      stop_services
      rm -rf "$APP_DIR" 2>/dev/null || true
      mv "$PREV_DIR" "$APP_DIR"
      echo "Rollback done." >&2
    fi
    if [ "$SERVICES_STOPPED" -eq 1 ]; then
      echo "Restarting services..." >&2
      start_services
      echo "Services restarted on the previous version." >&2
    fi
  fi
  exit "$code"
}
trap on_exit EXIT

# ---------------------------------------------------------------------------
# Download + extract + verify (services still running)
# ---------------------------------------------------------------------------
echo "Downloading ${TAR_FILE}..."
curl -fsSL --user "${FORGEJO_USER:-neras}:${FORGEJO_TOKEN}" "$URL" -o "${TMP_DIR}/${TAR_FILE}"

echo "Extracting..."
tar xzf "${TMP_DIR}/${TAR_FILE}" -C "${TMP_DIR}"
EXTRACT_DIR="${TMP_DIR}/my-claw-${VERSION}-linux-x64"

echo "Verifying payload..."
if [ ! -d "$EXTRACT_DIR" ]; then
  echo "Error: expected directory missing in tarball: $(basename "$EXTRACT_DIR")" >&2
  exit 1
fi
for required in package.json src/index.ts node_modules scripts/myclaw.sh packaging/update.sh templates; do
  if [ ! -e "${EXTRACT_DIR}/${required}" ]; then
    echo "Error: tarball is missing '${required}' — refusing to install a broken payload" >&2
    exit 1
  fi
done
PAYLOAD_VERSION=$(jq -r .version "${EXTRACT_DIR}/package.json" 2>/dev/null || echo "")
if [ "$PAYLOAD_VERSION" != "$VERSION" ]; then
  echo "Error: payload version '${PAYLOAD_VERSION}' does not match requested '${VERSION}'" >&2
  exit 1
fi

# Resolve runtime paths early: needed by the trap's start_services and the templates.
BUN_PATH="$(command -v bun || true)"
PYTHON_PATH="$(command -v python3 || command -v python || true)"
# Node runs the browser sidecar (Playwright connectOverCDP hangs under Bun).
NODE_PATH="$(command -v node || true)"
if [ -z "$NODE_PATH" ]; then
  NODE_PATH="$(ls -1 "${TARGET_HOME}"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1 || true)"
fi
if [ -z "$BUN_PATH" ] && [ -x "${TARGET_HOME}/.bun/bin/bun" ]; then
  BUN_PATH="${TARGET_HOME}/.bun/bin/bun"
fi
if [ -z "$BUN_PATH" ]; then
  echo "Error: bun not found — cannot run my-claw" >&2
  exit 1
fi
if [ -z "$NODE_PATH" ]; then
  echo "WARNING: node not found — the browser sidecar needs it; skipping the sidecar service." >&2
  echo "         Install Node.js and re-run the update to enable browsing." >&2
fi

# Stage the new tree on the same filesystem as APP_DIR so the final swap is rename(2),
# not a slow copy with a wide failure window.
echo "Staging..."
cp -r "$EXTRACT_DIR" "$STAGING_DIR"
chown -R root:root "$STAGING_DIR"

# Backup existing config before overwrite
if [ -f "${TARGET_HOME}/.my-claw/config.json" ]; then
  cp "${TARGET_HOME}/.my-claw/config.json" "${TMP_DIR}/config.json.backup"
fi
if [ -f /etc/my-claw/config.json ]; then
  cp /etc/my-claw/config.json "${TMP_DIR}/config.json.sys.backup"
fi

# ---------------------------------------------------------------------------
# Swap window: keep it as short as possible — everything below is fast local fs
# and systemd work; the heavy network/disk work is already done.
# ---------------------------------------------------------------------------
echo "Stopping services..."
SERVICES_STOPPED=1
stop_services

echo "Installing..."
rm -rf "$PREV_DIR"
if [ -d "$APP_DIR" ]; then
  mv "$APP_DIR" "$PREV_DIR"
  # Swap is "armed" the moment the live tree is moved away: a failure between the two
  # mv calls must still restore PREV_DIR even though the new tree isn't in place yet.
  SWAPPED=1
fi
mv "$STAGING_DIR" "$APP_DIR"

# Restore config if it existed
if [ -f "${TMP_DIR}/config.json.backup" ]; then
  cp "${TMP_DIR}/config.json.backup" "${TARGET_HOME}/.my-claw/config.json"
  chown "${TARGET_USER}:${TARGET_USER}" "${TARGET_HOME}/.my-claw/config.json"
fi
if [ -f "${TMP_DIR}/config.json.sys.backup" ]; then
  cp "${TMP_DIR}/config.json.sys.backup" /etc/my-claw/config.json
fi

# Regenerate systemd services from templates
GENERATED_SERVICES=""
for template in "${APP_DIR}/templates/"*.service; do
  [ -e "$template" ] || continue
  svc_name="$(basename "$template")"
  # The sidecar unit is useless (and flaps under Restart=always) without node — skip it.
  if [ "$svc_name" = "my-claw-browser-sidecar.service" ] && [ -z "$NODE_PATH" ]; then
    continue
  fi
  sed -e "s|{{USER}}|${TARGET_USER}|g" \
      -e "s|{{HOME}}|${TARGET_HOME}|g" \
      -e "s|{{BUN}}|${BUN_PATH}|g" \
      -e "s|{{NODE}}|${NODE_PATH}|g" \
      -e "s|{{PYTHON}}|${PYTHON_PATH}|g" \
      -e "s|{{APP_DIR}}|${APP_DIR}|g" \
      "$template" > "/etc/systemd/system/${svc_name}"
  chmod 644 "/etc/systemd/system/${svc_name}"
  GENERATED_SERVICES="${GENERATED_SERVICES} ${svc_name}"
done

# Timer units carry no placeholders, but regenerate them through the same path so a new or
# edited timer template is picked up on every update.
for template in "${APP_DIR}/templates/"*.timer; do
  [ -e "$template" ] || continue
  svc_name="$(basename "$template")"
  cp "$template" "/etc/systemd/system/${svc_name}"
  chmod 644 "/etc/systemd/system/${svc_name}"
  GENERATED_SERVICES="${GENERATED_SERVICES} ${svc_name}"
done

# Re-install update script atomically: cp onto the SAME inode this running script is still
# being read from executes garbage mid-update once the file grows; write a temp then rename.
cp "${APP_DIR}/packaging/update.sh" /usr/local/bin/my-claw-update.new
chmod 755 /usr/local/bin/my-claw-update.new
mv -f /usr/local/bin/my-claw-update.new /usr/local/bin/my-claw-update

# Re-install auto-update gate (same rename dance; a timer may fire mid-update).
cp "${APP_DIR}/packaging/auto-update.sh" /usr/local/bin/my-claw-auto-update.new
chmod 755 /usr/local/bin/my-claw-auto-update.new
mv -f /usr/local/bin/my-claw-auto-update.new /usr/local/bin/my-claw-auto-update

# Re-install CLI wrapper (same rename dance: myclaw wraps this updater and can be running).
cp "${APP_DIR}/scripts/myclaw.sh" /usr/local/bin/myclaw.new
chmod 755 /usr/local/bin/myclaw.new
mv -f /usr/local/bin/myclaw.new /usr/local/bin/myclaw

systemctl daemon-reload

# Enable regenerated units so a newly-added service template survives a reboot (previously a
# new unit would start once but never be enabled).
for svc in $GENERATED_SERVICES; do
  systemctl enable "$svc" >/dev/null 2>&1 || true
done
# The timer runs the auto-update gate on the installed cadence; start it on its own clock so
# the first check does not wait for a reboot.
systemctl enable my-claw-auto-update.timer >/dev/null 2>&1 || true
systemctl start my-claw-auto-update.timer 2>/dev/null || true

echo "Starting services..."
start_services

# Post-start health check: catch a new build that boots and dies immediately, while the
# rollback tree is still warm. 3 consecutive OK samples avoid flagging a slow start.
echo "Waiting for my-claw to become healthy..."
HEALTH_OK=0
for _ in $(seq 1 15); do
  sleep 2
  if systemctl is-active --quiet my-claw.service; then
    HEALTH_OK=$((HEALTH_OK + 1))
    [ "$HEALTH_OK" -ge 3 ] && break
  else
    HEALTH_OK=0
  fi
done
if [ "$HEALTH_OK" -lt 3 ]; then
  echo "Error: my-claw.service did not stay up after the update" >&2
  # Non-zero exit routes through the trap: rollback to PREV_DIR + service restart.
  exit 1
fi

echo ""
echo "Updated to my-claw ${VERSION}"
echo "Previous version kept at ${PREV_DIR} (manual rollback: stop services, swap dirs, start)"
echo "Check status: sudo systemctl status my-claw"
