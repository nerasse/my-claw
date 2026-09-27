#!/bin/bash
set -euo pipefail

# my-claw updater. Runs as the service user; nothing here needs root.
#
# Usage: update.sh [version|latest] [--force] [--file <tarball>] [--with-browser]
#        update.sh --activate      render the current tree's user units, start, health gate
#
# Layout (docs/install-layout.md): /opt/my-claw belongs to the service user.
#   current -> releases/<version>     the live tree, every unit points through this link
#   prev    -> releases/<previous>    the rollback, kept until the next successful update
#   releases/<version>/               one directory per installed release
#   .install-meta  .update.lock
#
# Failure-safety model:
# - Everything destructive happens as late as possible: download, extract, verify and stage the
#   full new tree BEFORE any service is stopped.
# - The live tree changes by re-pointing `current` (one rename(2)): there is no moment where
#   /opt/my-claw/current does not exist. Rollback is the same rename the other way.
# - An EXIT trap removes temp artifacts and, past the stop point, flips back to the previous
#   release, re-renders its units and restarts. The machine never stays down.
#
# Root appears in exactly two places, both about installs that predate user units:
# - `migrate_legacy_install`: the one-time move of a root-owned tree under system units to a
#   user-owned tree under user units. It runs once, from the legacy system timer, and hands over.
# - `install_legacy_root`: the previous root updater, kept so an install whose migration failed
#   (or whose service user is root) still receives the next release. Goes away with `templates/`.

APP_DIR="/opt/my-claw"
# Tests point the user-side flow at a scratch layout. Root ignores it: the migration and the
# legacy updater only ever act on the real install.
if [ "$EUID" -ne 0 ] && [ -n "${MY_CLAW_APP_DIR:-}" ]; then
  APP_DIR="$MY_CLAW_APP_DIR"
fi
LEGACY_META="/etc/my-claw/.install-meta"
LEGACY_ENV="/etc/my-claw/.env"
MIGRATION_STAMP="/etc/my-claw/.migration-failed"
OWNER="claw"
PACKAGE="my-claw"
TMP_BASE="/var/tmp"

# Restart order matters: the browser stack before the server that talks to it. Xvfb is not
# stopped across an update, a display that survives makes the restart shorter and keeps VNC alive.
#
# Chromium is not stopped either, unless asked (--with-browser). It holds the owner's work: open
# tabs, a sign-in, an application stopped at the screen of its e-mail code. Two updates on the night
# of 2026-09-26 killed two applications at exactly that screen. Nothing in a release needs a new
# Chromium: the binary is the system's, and the sidecar, which is ours, re-adopts every open tab
# when it restarts (a page id is the CDP target id). A changed browser unit or an upgraded binary is
# announced below instead, and applies at the browser's next start. docs/browser.md.
START_ORDER="my-claw-xvfb my-claw-chromium my-claw-browser-sidecar my-claw-whisper my-claw-vnc my-claw-novnc my-claw"
STOP_ORDER="my-claw my-claw-browser-sidecar my-claw-whisper my-claw-vnc my-claw-novnc"
BROWSER_UNIT="my-claw-chromium"
WITH_BROWSER=0

warn() { echo "$*" >&2; }
die() { echo "Error: $*" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: $(basename "$0") [version|latest] [--force] [--file <tarball>] [--with-browser]
       $(basename "$0") --activate

  version      install this release instead of the latest (a pin never moves the web bundle)
  --force      reinstall even when this version is already running
  --file PATH  install from a local tarball instead of the registry
  --with-browser  restart Chromium too (its open tabs are restored, but a page mid-form is lost)
  --activate   render the user units of the current tree, enable, start, health-check
EOF
}

# ---------------------------------------------------------------------------
# Metadata and credentials
# ---------------------------------------------------------------------------
TARGET_USER=""
TARGET_HOME=""
read_meta() {
  local key value
  while IFS='=' read -r key value; do
    case "$key" in
      USER) TARGET_USER="$value" ;;
      HOME) TARGET_HOME="$value" ;;
      APP_DIR) if [ -n "$value" ]; then APP_DIR="$value"; fi ;;
    esac
  done < "$1"
  if [ -z "$TARGET_USER" ] || [ -z "$TARGET_HOME" ]; then
    die "corrupt install metadata in $1"
  fi
}

FORGEJO_URL=""
FORGEJO_TOKEN=""
read_registry_env() {
  local key value
  [ -f "$1" ] || return 0
  while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" =~ ^# ]] && continue
    value="$(echo "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | sed 's/^["\'"'"']//;s/["\'"'"']$//')"
    case "$key" in
      FORGEJO_URL) FORGEJO_URL="$value" ;;
      FORGEJO_TOKEN) FORGEJO_TOKEN="$value" ;;
      FORGEJO_USER) FORGEJO_USER="$value" ;;
    esac
  done < "$1"
}

require_registry() {
  if [ -z "$FORGEJO_URL" ] || [ -z "$FORGEJO_TOKEN" ]; then
    die "FORGEJO_URL and FORGEJO_TOKEN are needed to reach the registry (${TARGET_HOME}/.my-claw/.env)"
  fi
}

# ---------------------------------------------------------------------------
# systemd, either flavour
#
# SYSCTL is the command that talks to the manager owning the units: `systemctl --user` for the
# service user, plain `systemctl` for a legacy root install. Everything below goes through it.
# ---------------------------------------------------------------------------
SYSCTL=(systemctl --user)
UNIT_DIR=""
UNIT_SRC="units"

# `systemctl --user` needs the user's bus. A user unit and a login shell have it; a shell the
# server spawned, or runuser from root, may not.
ensure_user_bus() {
  local uid
  uid="$(id -u)"
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/${uid}}"
  export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"
}

use_user_manager() {
  SYSCTL=(systemctl --user)
  UNIT_DIR="${TARGET_HOME}/.config/systemd/user"
  UNIT_SRC="units"
  ensure_user_bus
}

use_system_manager() {
  SYSCTL=(systemctl)
  UNIT_DIR="/etc/systemd/system"
  UNIT_SRC="templates"
}

BUN_PATH=""
NODE_PATH=""
PYTHON_PATH=""
resolve_runtimes() {
  BUN_PATH="$(command -v bun || true)"
  if [ -z "$BUN_PATH" ] && [ -x "${TARGET_HOME}/.bun/bin/bun" ]; then
    BUN_PATH="${TARGET_HOME}/.bun/bin/bun"
  fi
  PYTHON_PATH="$(command -v python3 || command -v python || true)"
  # Node runs the browser sidecar (Playwright connectOverCDP hangs under Bun).
  NODE_PATH="$(command -v node || true)"
  if [ -z "$NODE_PATH" ]; then
    NODE_PATH="$(ls -1 "${TARGET_HOME}"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1 || true)"
  fi
  [ -n "$BUN_PATH" ] || die "bun not found: cannot run my-claw"
  if [ -z "$NODE_PATH" ]; then
    warn "WARNING: node not found. The browser sidecar needs it; skipping the sidecar unit."
    warn "         Install Node.js and run 'myclaw update --force' to enable browsing."
  fi
}

# Write the units of a tree into UNIT_DIR, drop the ones this release no longer ships, reload,
# enable. $1 is the tree, $2 the path units must point at ({{APP_DIR}}): the `current` link for
# the user layout, the tree itself for the legacy one.
render_units() {
  local tree="$1" app_path="$2" src name template existing shipped=""
  src="${tree}/${UNIT_SRC}"
  [ -d "$src" ] || die "${src} missing: this release cannot be activated with this layout"
  mkdir -p "$UNIT_DIR"
  for template in "$src"/*.service "$src"/*.timer; do
    [ -e "$template" ] || continue
    name="$(basename "$template")"
    # The sidecar unit is useless (and flaps under Restart=always) without node.
    if [ "$name" = "my-claw-browser-sidecar.service" ] && [ -z "$NODE_PATH" ]; then
      continue
    fi
    sed -e "s|{{USER}}|${TARGET_USER}|g" \
        -e "s|{{HOME}}|${TARGET_HOME}|g" \
        -e "s|{{BUN}}|${BUN_PATH}|g" \
        -e "s|{{NODE}}|${NODE_PATH}|g" \
        -e "s|{{PYTHON}}|${PYTHON_PATH}|g" \
        -e "s|{{APP_DIR}}|${app_path}|g" \
        "$template" > "${UNIT_DIR}/${name}.tmp"
    chmod 644 "${UNIT_DIR}/${name}.tmp"
    mv -f "${UNIT_DIR}/${name}.tmp" "${UNIT_DIR}/${name}"
    shipped="${shipped} ${name}"
  done
  # The units on the machine are exactly the units of the running release: one it stopped
  # shipping (or the sidecar without node) is disabled and removed, not left to flap.
  for existing in "$UNIT_DIR"/my-claw*.service "$UNIT_DIR"/my-claw*.timer; do
    [ -e "$existing" ] || continue
    name="$(basename "$existing")"
    case " ${shipped} " in *" ${name} "*) continue ;; esac
    "${SYSCTL[@]}" disable --now "$name" >/dev/null 2>&1 || true
    rm -f "$existing"
  done
  "${SYSCTL[@]}" daemon-reload
  for name in $shipped; do
    "${SYSCTL[@]}" enable "$name" >/dev/null 2>&1 || true
  done
}

start_services() {
  local svc
  for svc in $START_ORDER; do
    if [ "$svc" = "my-claw-browser-sidecar" ] && [ -z "$NODE_PATH" ]; then
      continue
    fi
    "${SYSCTL[@]}" start "${svc}.service" 2>/dev/null || true
  done
  # The timer checks the registry on the installed cadence; start it on its own clock so the
  # first check does not wait for a reboot.
  "${SYSCTL[@]}" enable my-claw-auto-update.timer >/dev/null 2>&1 || true
  "${SYSCTL[@]}" start my-claw-auto-update.timer 2>/dev/null || true
}

stop_services() {
  local svc
  for svc in $STOP_ORDER; do
    "${SYSCTL[@]}" stop "${svc}.service" 2>/dev/null || true
  done
  if [ "$WITH_BROWSER" -eq 1 ]; then
    "${SYSCTL[@]}" stop "${BROWSER_UNIT}.service" 2>/dev/null || true
  fi
}

# The rendered browser unit, to tell whether a release changed it.
browser_unit_sum() {
  sha256sum "${UNIT_DIR}/${BROWSER_UNIT}.service" 2>/dev/null | cut -d' ' -f1 || true
}

# What the running browser would need a restart for, said once at the end instead of done behind
# the owner's back: a unit this release changed, or a binary the system upgraded under it.
report_browser() {
  local before="$1" after pid exe
  [ "$WITH_BROWSER" -eq 0 ] || return 0
  "${SYSCTL[@]}" is-active --quiet "${BROWSER_UNIT}.service" 2>/dev/null || return 0
  after="$(browser_unit_sum)"
  if [ -n "$before" ] && [ "$before" != "$after" ]; then
    echo "Browser left running: this release changed its unit, which applies at Chromium's next start."
    echo "  Apply it when no task is using the browser: myclaw restart --with-browser"
  fi
  pid="$("${SYSCTL[@]}" show -p MainPID --value "${BROWSER_UNIT}.service" 2>/dev/null || true)"
  if [ -n "$pid" ] && [ "$pid" != "0" ]; then
    exe="$(readlink "/proc/${pid}/exe" 2>/dev/null || true)"
    case "$exe" in
      *" (deleted)")
        echo "Browser left running: Chromium was upgraded on this machine while it ran."
        echo "  It keeps working; restart it when no task is using it: myclaw restart --with-browser"
        ;;
    esac
  fi
}

# Catch a build that boots and dies immediately, while the rollback is still warm. Three
# consecutive OK samples avoid flagging a slow start.
health_gate() {
  local ok=0 _
  echo "Waiting for my-claw to become healthy..."
  for _ in $(seq 1 15); do
    sleep 2
    if "${SYSCTL[@]}" is-active --quiet my-claw.service; then
      ok=$((ok + 1))
      if [ "$ok" -ge 3 ]; then
        return 0
      fi
    else
      ok=0
    fi
  done
  return 1
}

# ---------------------------------------------------------------------------
# The web client bundle
#
# Sourced from the tree rather than reimplemented: packaging/web-bundle.sh is the same code the
# 15-minute timer runs, so `myclaw update` and the timer cannot end up with two ideas of what
# "up to date" means. Sourced lazily at each call site, because between the two the live tree
# changed and the new release's helper is the one that should run.
#
# Never allowed to fail this script: past the swap point, any non-zero exit rolls the server
# back, and a bundle that could not be downloaded is not a reason to undo a good server update.
# ---------------------------------------------------------------------------
web_bundle_now() {
  local helper="$1/packaging/web-bundle.sh"
  if [ ! -f "$helper" ]; then
    echo "Warning: ${helper} missing, the web bundle is left alone"
    return 0
  fi
  if [ -z "$FORGEJO_URL" ] || [ -z "$FORGEJO_TOKEN" ]; then
    echo "No registry credentials yet, the web bundle will follow once FORGEJO_TOKEN is set"
    return 0
  fi
  (
    set +e
    # shellcheck source=/dev/null
    . "$helper"
    WEB_LOG_PREFIX="my-claw update" update_web_bundle
  ) || true
  return 0
}

# ---------------------------------------------------------------------------
# Fetch: download (or copy), extract, verify. Services keep running through all of it.
# Sets TMP_DIR and EXTRACT_DIR.
# ---------------------------------------------------------------------------
TMP_DIR=""
EXTRACT_DIR=""
avail_bytes() { df --output=avail -B1 "$1" 2>/dev/null | tail -1 | tr -d ' ' || true; }

check_space() {
  local dir="$1" need="$2" label="$3" have
  have="$(avail_bytes "$dir")"
  if [ -z "$have" ] || [ "$have" -lt "$need" ]; then
    warn "Error: not enough space in ${label} (${dir}): need $((need / 1024 / 1024)) MB, have $(( ${have:-0} / 1024 / 1024)) MB"
    return 1
  fi
}

fetch_payload() {
  local version="$1" file="$2" stage_parent="$3"
  local tar_file url tarball_bytes need_tmp need_app required payload_version
  if [ -n "$file" ]; then
    tar_file="$(basename "$file")"
    tarball_bytes="$(stat -c %s "$file")"
  else
    tar_file="my-claw-${version}-linux-x64.tar.gz"
    url="${FORGEJO_URL}/api/packages/${OWNER}/generic/${PACKAGE}/${version}/${tar_file}"
    # `|| true`: the registry may not answer HEAD at all. Under `set -e` a failing command
    # substitution in an assignment silently kills the whole script.
    tarball_bytes="$(curl -fsSI --user "${FORGEJO_USER:-neras}:${FORGEJO_TOKEN}" "$url" 2>/dev/null \
      | tr -d '\r' | awk 'tolower($1)=="content-length:" {print $2}' | tail -1 || true)"
    # No Content-Length (HEAD unsupported or proxy stripped it): assume a conservative 500MB tarball.
    [ -n "${tarball_bytes:-}" ] || tarball_bytes=$((500 * 1024 * 1024))
  fi

  # /var/tmp (disk-backed) instead of /tmp: /tmp is a RAM tmpfs on typical installs and a ~1GB
  # extraction can eat it entirely (seen in production: tar ENOSPC). Tarball plus extracted tree
  # (~4x, node_modules dominated) there, plus one staged copy of the tree next to the releases.
  need_tmp=$((tarball_bytes * 5))
  need_app=$((tarball_bytes * 4))
  if ! check_space "$TMP_BASE" "$need_tmp" "temp dir"; then
    # Best-effort sweep of known my-claw runtime debris before giving up: old media and
    # screenshots left by crashed runs, never live data.
    echo "Attempting cleanup of stale my-claw temp files..."
    find /tmp "$TMP_BASE" -maxdepth 1 \( -name 'my-claw-*' -o -name 'tts-*' -o -name 'browser-*.png' \) \
      -mmin +60 -exec rm -rf {} + 2>/dev/null || true
    check_space "$TMP_BASE" "$need_tmp" "temp dir" || exit 1
  fi
  check_space "$stage_parent" "$need_app" "app dir" || exit 1

  TMP_DIR="$(mktemp -d "${TMP_BASE}/my-claw-update.XXXXXX")"
  if [ -n "$file" ]; then
    echo "Copying ${tar_file}..."
    cp "$file" "${TMP_DIR}/${tar_file}"
  else
    echo "Downloading ${tar_file}..."
    curl -fsSL --user "${FORGEJO_USER:-neras}:${FORGEJO_TOKEN}" "$url" -o "${TMP_DIR}/${tar_file}"
  fi

  echo "Extracting..."
  tar xzf "${TMP_DIR}/${tar_file}" -C "${TMP_DIR}"
  EXTRACT_DIR="${TMP_DIR}/my-claw-${version}-linux-x64"

  echo "Verifying payload..."
  [ -d "$EXTRACT_DIR" ] || die "expected directory missing in tarball: $(basename "$EXTRACT_DIR")"
  for required in package.json src/index.ts node_modules scripts/myclaw.sh packaging/update.sh \
      packaging/auto-update.sh packaging/web-bundle.sh packaging/myclaw-stub.sh \
      units units/my-claw.service units/my-claw-auto-update.timer; do
    [ -e "${EXTRACT_DIR}/${required}" ] || die "tarball is missing '${required}', refusing to install a broken payload"
  done
  payload_version="$(jq -r .version "${EXTRACT_DIR}/package.json" 2>/dev/null || echo "")"
  [ "$payload_version" = "$version" ] || die "payload version '${payload_version}' does not match requested '${version}'"
}

RESOLVED_VERSION=""
resolve_latest() {
  local latest
  echo "Checking latest version..."
  latest="$(curl -fsS --user "${FORGEJO_USER:-neras}:${FORGEJO_TOKEN}" \
    -H "Accept: application/json" \
    "${FORGEJO_URL}/api/v1/packages/${OWNER}" | \
    jq -r --arg pkg "${PACKAGE}" '.[] | select(.name == $pkg and .type == "generic") | .version' | \
    sort -V | tail -1)"
  if [ -z "$latest" ] || [ "$latest" = "null" ]; then
    die "could not determine latest version"
  fi
  echo "Latest version: ${latest}"
  RESOLVED_VERSION="$latest"
}

# The top-level directory of the tarball names the release. `head -1` closes the pipe on tar,
# whose SIGPIPE would otherwise fail the substitution under pipefail.
version_in_tarball() {
  local first
  first="$(tar tzf "$1" 2>/dev/null | head -1 || true)"
  echo "$first" | cut -d/ -f1 | sed -e 's/^my-claw-//' -e 's/-linux-x64$//'
}

# Resolve the version to install, from --file, a pin, or the registry. Sets VERSION and
# WANTS_LATEST for the caller.
resolve_version() {
  local file="$1"
  if [ -n "$file" ]; then
    [ -f "$file" ] || die "no such file: ${file}"
    VERSION="$(version_in_tarball "$file")"
    [ -n "$VERSION" ] || die "cannot read a version out of ${file}"
    WANTS_LATEST=0
  elif [ "$VERSION" = "latest" ]; then
    require_registry
    resolve_latest
    VERSION="$RESOLVED_VERSION"
  else
    require_registry
  fi
}

# ---------------------------------------------------------------------------
# The user layout: flip `current`, prev is the rollback
# ---------------------------------------------------------------------------
flip_link() {
  local name="$1" target="$2"
  ln -sfn "$target" "${APP_DIR}/${name}.tmp"
  mv -T "${APP_DIR}/${name}.tmp" "${APP_DIR}/${name}"
}

prune_releases() {
  local keep_cur keep_prev d rel
  keep_cur="$(readlink "${APP_DIR}/current" || true)"
  keep_prev="$(readlink "${APP_DIR}/prev" 2>/dev/null || true)"
  for d in "${APP_DIR}"/releases/*; do
    [ -d "$d" ] || continue
    rel="releases/$(basename "$d")"
    case "$rel" in "$keep_cur"|"$keep_prev") continue ;; esac
    rm -rf "$d"
  done
}

STAGING_DIR=""
SERVICES_STOPPED=0
FLIPPED=0
OLD_CURRENT=""
OLD_PREV=""
NEW_RELEASE=""

on_exit_user() {
  local code=$?
  rm -rf "$TMP_DIR" "$STAGING_DIR" 2>/dev/null || true
  if [ "$code" -ne 0 ]; then
    warn ""
    warn "Update FAILED (exit ${code})."
    if [ "$FLIPPED" -eq 1 ]; then
      warn "Rolling back to ${OLD_CURRENT}..."
      # Services may be running on the broken new tree (failed health check): never yank a tree
      # out from under live processes.
      stop_services
      flip_link current "$OLD_CURRENT" || true
      if [ -n "$OLD_PREV" ]; then
        flip_link prev "$OLD_PREV" || true
      else
        rm -f "${APP_DIR}/prev"
      fi
      render_units "${APP_DIR}/current" "${APP_DIR}/current" || true
      if [ -n "$NEW_RELEASE" ] && [ "$NEW_RELEASE" != "$OLD_CURRENT" ]; then
        rm -rf "${APP_DIR:?}/${NEW_RELEASE}" 2>/dev/null || true
      fi
      warn "Rollback done."
    fi
    if [ "$SERVICES_STOPPED" -eq 1 ]; then
      warn "Restarting services..."
      start_services
      warn "Services restarted on the previous version."
    fi
  fi
  exit "$code"
}

install_user() {
  local force="$1" file="$2"
  local installed replaced

  use_user_manager
  exec 9>"${APP_DIR}/.update.lock"
  if ! flock -n 9; then
    die "another my-claw update is already running (lock: ${APP_DIR}/.update.lock)"
  fi
  resolve_version "$file"

  # Idempotence: reinstalling the running version is a pure loss. It moves the live tree into
  # `prev`, wiping the rollback that exists to catch the next failed update, and stops services
  # to land on byte-identical code. Skip it and say so; --force overrides, for repairing an
  # install whose files got corrupted in place.
  installed="$(jq -r .version "${APP_DIR}/current/package.json" 2>/dev/null || true)"
  if [ "$force" -eq 0 ] && [ "$installed" = "$VERSION" ]; then
    echo "Already on my-claw ${VERSION}, nothing to install."
    echo "Re-run with --force to install ${VERSION} anyway."
    # The server being current is exactly when the bundle is allowed to move, and a run of this
    # command is a request to be up to date, not a request to swap a tree.
    if [ "$WANTS_LATEST" -eq 1 ]; then
      web_bundle_now "${APP_DIR}/current"
    fi
    exit 0
  fi

  # Stale artifacts from previous failed/killed updates are the most common reason space runs
  # out. Sweep them first, they are always safe to delete under the lock.
  rm -rf "${TMP_BASE}"/my-claw-update.* "${APP_DIR}"/releases/.staging-* 2>/dev/null || true

  trap on_exit_user EXIT
  fetch_payload "$VERSION" "$file" "$APP_DIR"
  resolve_runtimes

  # Stage on the same filesystem as the releases so the final move is rename(2), not a slow copy
  # with a wide failure window.
  echo "Staging..."
  STAGING_DIR="${APP_DIR}/releases/.staging-$$"
  cp -a "$EXTRACT_DIR" "$STAGING_DIR"

  # -------------------------------------------------------------------------
  # Swap window: keep it as short as possible. Everything below is local fs and systemd work.
  # -------------------------------------------------------------------------
  OLD_CURRENT="$(readlink "${APP_DIR}/current")"
  OLD_PREV="$(readlink "${APP_DIR}/prev" 2>/dev/null || true)"
  NEW_RELEASE="releases/${VERSION}"
  BROWSER_UNIT_BEFORE="$(browser_unit_sum)"

  echo "Stopping services..."
  SERVICES_STOPPED=1
  stop_services

  echo "Installing..."
  if [ -d "${APP_DIR}/${NEW_RELEASE}" ]; then
    # A --force of the running version, or a leftover of a failed attempt: the directory name
    # is taken, so the old one moves aside and stays the rollback.
    replaced="${NEW_RELEASE}.replaced-$(date +%s)"
    mv "${APP_DIR}/${NEW_RELEASE}" "${APP_DIR}/${replaced}"
    if [ "$OLD_CURRENT" = "$NEW_RELEASE" ]; then
      flip_link current "$replaced"
      OLD_CURRENT="$replaced"
    fi
    if [ "$OLD_PREV" = "$NEW_RELEASE" ]; then
      OLD_PREV=""
    fi
  fi
  mv "$STAGING_DIR" "${APP_DIR}/${NEW_RELEASE}"
  STAGING_DIR=""
  flip_link current "$NEW_RELEASE"
  FLIPPED=1
  flip_link prev "$OLD_CURRENT"

  render_units "${APP_DIR}/current" "${APP_DIR}/current"
  echo "Starting services..."
  start_services
  if ! health_gate; then
    # Non-zero exit routes through the trap: flip back to prev, its units, restart.
    die "my-claw.service did not stay up after the update"
  fi

  # The server is new and healthy, so the bundle may follow it. After the swap, so a rollback
  # never leaves a bundle in front of an older server; after the health check, for the same reason.
  if [ "$WANTS_LATEST" -eq 1 ]; then
    web_bundle_now "${APP_DIR}/current"
  else
    echo "Pinned version: leaving the web bundle where it is (run without a version to move it)"
  fi

  prune_releases
  report_browser "$BROWSER_UNIT_BEFORE"
  echo ""
  echo "Updated to my-claw ${VERSION}"
  echo "Previous version kept at ${APP_DIR}/prev (rollback: myclaw update $(jq -r .version "${APP_DIR}/prev/package.json" 2>/dev/null || echo '<version>'))"
  echo "Check status: myclaw status"
}

activate_current() {
  use_user_manager
  resolve_runtimes
  render_units "${APP_DIR}/current" "${APP_DIR}/current"
  echo "Starting services..."
  start_services
  if ! health_gate; then
    die "my-claw.service did not stay up (journalctl --user -u my-claw.service, /var/log/my-claw/my-claw.log)"
  fi
  web_bundle_now "${APP_DIR}/current"
  echo "my-claw $(jq -r .version "${APP_DIR}/current/package.json" 2>/dev/null) is running as $(id -un)."
}

# ---------------------------------------------------------------------------
# Legacy root install: a root-owned tree under system units. The previous updater, same
# behaviour, for the installs that cannot migrate (service user is root, or a failed migration
# waiting for the release that fixes it). Removed together with `templates/`.
# ---------------------------------------------------------------------------
LEGACY_PREV=""
LEGACY_SWAPPED=0

on_exit_legacy() {
  local code=$?
  rm -rf "$TMP_DIR" "$STAGING_DIR" 2>/dev/null || true
  if [ "$code" -ne 0 ]; then
    warn ""
    warn "Update FAILED (exit ${code})."
    if [ "$LEGACY_SWAPPED" -eq 1 ] && [ -d "$LEGACY_PREV" ]; then
      warn "Rolling back to previous version..."
      stop_services
      rm -rf "$APP_DIR" 2>/dev/null || true
      mv "$LEGACY_PREV" "$APP_DIR"
      warn "Rollback done."
    fi
    if [ "$SERVICES_STOPPED" -eq 1 ]; then
      warn "Restarting services..."
      start_services
      warn "Services restarted on the previous version."
    fi
  fi
  exit "$code"
}

# The scripts root runs live outside the tree. Write a temp then rename: cp onto the same inode
# this running script is read from executes garbage mid-update once the file grows.
install_legacy_bin() {
  local tree="$1" pair src dst
  for pair in "packaging/update.sh:my-claw-update" "packaging/auto-update.sh:my-claw-auto-update" "scripts/myclaw.sh:myclaw"; do
    src="${tree}/${pair%%:*}"
    dst="/usr/local/bin/${pair##*:}"
    cp "$src" "${dst}.new"
    chmod 755 "${dst}.new"
    mv -f "${dst}.new" "$dst"
  done
}

install_legacy_root() {
  local force="$1" file="$2"
  local installed

  use_system_manager
  exec 9>"/var/lock/my-claw-update.lock"
  if ! flock -n 9; then
    die "another my-claw update is already running (lock: /var/lock/my-claw-update.lock)"
  fi
  resolve_version "$file"

  installed="$(jq -r .version "${APP_DIR}/package.json" 2>/dev/null || true)"
  if [ "$force" -eq 0 ] && [ "$installed" = "$VERSION" ]; then
    echo "Already on my-claw ${VERSION}, nothing to install."
    if [ "$WANTS_LATEST" -eq 1 ]; then
      web_bundle_now "$APP_DIR"
    fi
    exit 0
  fi

  rm -rf "${TMP_BASE}"/my-claw-update.* "${APP_DIR}".staging-* 2>/dev/null || true
  trap on_exit_legacy EXIT
  fetch_payload "$VERSION" "$file" "$(dirname "$APP_DIR")"
  resolve_runtimes

  echo "Staging..."
  STAGING_DIR="${APP_DIR}.staging-$$"
  cp -a "$EXTRACT_DIR" "$STAGING_DIR"
  chown -R root:root "$STAGING_DIR"

  echo "Stopping services..."
  SERVICES_STOPPED=1
  stop_services

  echo "Installing..."
  LEGACY_PREV="${APP_DIR}.prev"
  rm -rf "$LEGACY_PREV"
  if [ -d "$APP_DIR" ]; then
    mv "$APP_DIR" "$LEGACY_PREV"
    # Armed the moment the live tree is moved away: a failure between the two mv calls must
    # still restore it even though the new tree is not in place yet.
    LEGACY_SWAPPED=1
  fi
  mv "$STAGING_DIR" "$APP_DIR"
  STAGING_DIR=""

  render_units "$APP_DIR" "$APP_DIR"
  install_legacy_bin "$APP_DIR"

  echo "Starting services..."
  start_services
  if ! health_gate; then
    die "my-claw.service did not stay up after the update"
  fi
  if [ "$WANTS_LATEST" -eq 1 ]; then
    web_bundle_now "$APP_DIR"
  fi
  echo ""
  echo "Updated to my-claw ${VERSION} (legacy root layout)"
  echo "Previous version kept at ${LEGACY_PREV}"
}

# ---------------------------------------------------------------------------
# Migration: root-owned tree + system units -> user-owned tree + user units. Once.
# ---------------------------------------------------------------------------
wait_user_bus() {
  local uid="$1" _
  for _ in $(seq 1 30); do
    if [ -S "/run/user/${uid}/bus" ]; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

# Keys root held that the user's file lacks are appended; a key present in both keeps the user's
# value, that file is the one the app edits from chat and the more recent of the two. Root's copy
# is kept untouched under /etc/my-claw.migrated for the owner to compare and delete.
merge_env() {
  local src="$1" dst="$2" line key added=0
  [ -f "$src" ] || return 0
  touch "$dst"
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*= ]] || continue
    key="${BASH_REMATCH[1]}"
    if grep -qE "^[[:space:]]*${key}[[:space:]]*=" "$dst"; then
      echo "  ${key}: kept the value already in ${dst}"
      continue
    fi
    if [ "$added" -eq 0 ]; then
      printf '\n# Moved here from /etc/my-claw/.env when this install switched to user units.\n' >> "$dst"
      added=1
    fi
    printf '%s\n' "$line" >> "$dst"
  done < "$src"
}

migration_possible() {
  [ -f "$LEGACY_META" ] || return 1
  [ ! -L "${APP_DIR}/current" ] || return 1
  [ -d "${APP_DIR}/units" ] || return 1
  [ -f "${APP_DIR}/packaging/myclaw-stub.sh" ] || return 1
  [ "$TARGET_USER" != "root" ] || return 1
  command -v loginctl >/dev/null 2>&1 || return 1
  command -v runuser >/dev/null 2>&1 || return 1
  if [ -f "$MIGRATION_STAMP" ] && [ "$(cat "$MIGRATION_STAMP")" = "$(jq -r .version "${APP_DIR}/package.json" 2>/dev/null)" ]; then
    return 1
  fi
  return 0
}

MIGRATION_VERSION=""
MIGRATION_UID=""
MIGRATION_STAGING=""
MIGRATION_PHASE="pre"

user_ctl() {
  runuser -u "$TARGET_USER" -- env "XDG_RUNTIME_DIR=/run/user/${MIGRATION_UID}" \
    "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${MIGRATION_UID}/bus" systemctl --user "$@"
}

rollback_migration() {
  local svc
  MIGRATION_PHASE="rolledback"
  warn "Restoring system units and the root-owned layout..."
  # Whatever the user manager managed to start must go, or it fights the system units for the ports.
  for svc in $STOP_ORDER my-claw-xvfb my-claw-auto-update; do
    user_ctl disable --now "${svc}.service" >/dev/null 2>&1 || true
  done
  user_ctl disable --now my-claw-auto-update.timer >/dev/null 2>&1 || true
  rm -f "${TARGET_HOME}/.config/systemd/user"/my-claw*.service "${TARGET_HOME}/.config/systemd/user"/my-claw*.timer
  user_ctl daemon-reload >/dev/null 2>&1 || true

  # The tree is either already under the new container, or still in the staging container if the
  # failure hit between the two moves.
  if [ -d "${APP_DIR}/releases/${MIGRATION_VERSION}" ]; then
    mv "$APP_DIR" "${APP_DIR}.rollback-$$"
    mv "${APP_DIR}.rollback-$$/releases/${MIGRATION_VERSION}" "$APP_DIR"
    rm -rf "${APP_DIR}.rollback-$$"
  elif [ -n "$MIGRATION_STAGING" ] && [ -d "${MIGRATION_STAGING}/releases/${MIGRATION_VERSION}" ]; then
    mv "${MIGRATION_STAGING}/releases/${MIGRATION_VERSION}" "$APP_DIR"
    rm -rf "$MIGRATION_STAGING"
  fi
  chown -R root:root "$APP_DIR"
  if [ -d /etc/my-claw.migrated ]; then
    rm -rf /etc/my-claw
    mv /etc/my-claw.migrated /etc/my-claw
  fi
  mkdir -p /etc/my-claw
  printf 'USER=%s\nHOME=%s\nAPP_DIR=%s\n' "$TARGET_USER" "$TARGET_HOME" "$APP_DIR" > "$LEGACY_META"
  chmod 644 "$LEGACY_META"

  use_system_manager
  render_units "$APP_DIR" "$APP_DIR"
  install_legacy_bin "$APP_DIR"
  start_services
  echo "$MIGRATION_VERSION" > "$MIGRATION_STAMP"
  warn "Back on system units, on the same release. The migration is retried with the next release; remove ${MIGRATION_STAMP} to retry now."
  warn "Please report the output above: this is the case the migration was not supposed to hit."
}

on_exit_migration() {
  local code=$?
  if [ "$code" -ne 0 ] && [ "$MIGRATION_PHASE" = "moved" ]; then
    warn ""
    warn "Migration FAILED (exit ${code}) after the tree moved."
    rollback_migration || warn "Rollback itself failed; the tree is under ${APP_DIR} or ${MIGRATION_STAGING}, metadata in ${LEGACY_META}."
  fi
  exit "$code"
}

migrate_legacy_install() {
  local svc
  read_meta "$LEGACY_META"
  MIGRATION_VERSION="$(jq -r .version "${APP_DIR}/package.json" 2>/dev/null || true)"
  if [ -z "$MIGRATION_VERSION" ] || [ "$MIGRATION_VERSION" = "null" ]; then
    die "cannot read the installed version from ${APP_DIR}/package.json"
  fi
  MIGRATION_UID="$(id -u "$TARGET_USER")"
  echo "my-claw ${MIGRATION_VERSION}: moving this install to systemd user units, owned by ${TARGET_USER} (one time)."

  # ---- preflight, nothing changed yet -------------------------------------------------------
  resolve_runtimes
  loginctl enable-linger "$TARGET_USER"
  if ! wait_user_bus "$MIGRATION_UID"; then
    # The user manager needs a session bus. Debian and Ubuntu ship it in dbus-user-session, and
    # a server image may lack it.
    if command -v apt-get >/dev/null 2>&1; then
      echo "No session bus for ${TARGET_USER}, installing dbus-user-session..."
      apt-get install -y dbus-user-session
      systemctl restart "user@${MIGRATION_UID}.service" 2>/dev/null || true
      wait_user_bus "$MIGRATION_UID" || die "still no session bus at /run/user/${MIGRATION_UID}/bus"
    else
      die "no session bus at /run/user/${MIGRATION_UID}/bus: install dbus-user-session (or your distribution's equivalent) and re-run"
    fi
  fi
  trap on_exit_migration EXIT

  # ---- point of no return: services stop, the tree moves ------------------------------------
  echo "Stopping system units..."
  for svc in $STOP_ORDER my-claw-xvfb; do
    systemctl stop "${svc}.service" 2>/dev/null || true
  done
  systemctl disable --now my-claw-auto-update.timer 2>/dev/null || true
  # Not stopped: my-claw-auto-update.service may be the very unit running this script.
  for svc in $STOP_ORDER my-claw-xvfb my-claw-auto-update; do
    systemctl disable "${svc}.service" 2>/dev/null || true
  done

  echo "Moving the tree to ${APP_DIR}/releases/${MIGRATION_VERSION}..."
  MIGRATION_STAGING="${APP_DIR}.migrating-$$"
  MIGRATION_PHASE="moved"
  mkdir -p "${MIGRATION_STAGING}/releases"
  mv "$APP_DIR" "${MIGRATION_STAGING}/releases/${MIGRATION_VERSION}"
  ln -s "releases/${MIGRATION_VERSION}" "${MIGRATION_STAGING}/current"
  mv "$MIGRATION_STAGING" "$APP_DIR"
  MIGRATION_STAGING=""
  printf 'USER=%s\nHOME=%s\nAPP_DIR=%s\n' "$TARGET_USER" "$TARGET_HOME" "$APP_DIR" > "${APP_DIR}/.install-meta"

  mkdir -p /var/log/my-claw "${TARGET_HOME}/.my-claw" "${TARGET_HOME}/.config/systemd/user"
  chown -R "${TARGET_USER}:${TARGET_USER}" "$APP_DIR" /var/log/my-claw
  chown "${TARGET_USER}:${TARGET_USER}" "${TARGET_HOME}/.my-claw" "${TARGET_HOME}/.config" \
    "${TARGET_HOME}/.config/systemd" "${TARGET_HOME}/.config/systemd/user"

  echo "Moving secrets to ${TARGET_HOME}/.my-claw/.env..."
  merge_env "$LEGACY_ENV" "${TARGET_HOME}/.my-claw/.env"
  chown "${TARGET_USER}:${TARGET_USER}" "${TARGET_HOME}/.my-claw/.env"
  chmod 600 "${TARGET_HOME}/.my-claw/.env"
  if [ -d /etc/my-claw ]; then
    rm -rf /etc/my-claw.migrated
    mv /etc/my-claw /etc/my-claw.migrated
    chmod 700 /etc/my-claw.migrated
  fi

  rm -f /etc/systemd/system/my-claw*.service /etc/systemd/system/my-claw*.timer
  systemctl daemon-reload
  install -m 755 -o root -g root "${APP_DIR}/current/packaging/myclaw-stub.sh" /usr/local/bin/myclaw

  echo "Activating user units as ${TARGET_USER}..."
  if runuser -u "$TARGET_USER" -- env "HOME=${TARGET_HOME}" "XDG_RUNTIME_DIR=/run/user/${MIGRATION_UID}" \
       "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${MIGRATION_UID}/bus" \
       "${APP_DIR}/current/packaging/update.sh" --activate; then
    MIGRATION_PHASE="done"
    # The legacy rollback tree predates user units and could never be activated again.
    rm -rf "${APP_DIR}.prev" "${APP_DIR}".staging-* 2>/dev/null || true
    # This script may be /usr/local/bin/my-claw-update itself: bash holds the inode, unlink is safe.
    rm -f /usr/local/bin/my-claw-update /usr/local/bin/my-claw-auto-update
    rm -f /var/lock/my-claw-update.lock 2>/dev/null || true
    echo ""
    echo "my-claw ${MIGRATION_VERSION} now runs as ${TARGET_USER} under systemd user units."
    echo "  status:  myclaw status                (or: systemctl --user status my-claw, as ${TARGET_USER})"
    echo "  update:  myclaw update                (no sudo needed anymore)"
    echo "  secrets: ${TARGET_HOME}/.my-claw/.env  (root's copy kept in /etc/my-claw.migrated)"
    return 0
  fi
  warn "Activation under user units failed."
  rollback_migration
  return 1
}

# ---------------------------------------------------------------------------
# Entry
# ---------------------------------------------------------------------------
ORIG_ARGS=("$@")
VERSION="latest"
FORCE=0
FILE=""
MODE="update"
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1 ;;
    --file) shift; FILE="${1:-}"; [ -n "$FILE" ] || die "--file needs a path" ;;
    --activate) MODE="activate" ;;
    --with-browser) WITH_BROWSER=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) usage >&2; die "unknown option: $1" ;;
    *) VERSION="$1" ;;
  esac
  shift
done
WANTS_LATEST=0
if [ "$VERSION" = "latest" ]; then
  WANTS_LATEST=1
fi
command -v jq >/dev/null 2>&1 || die "jq not found"

if [ "$EUID" -eq 0 ]; then
  if [ -f "$LEGACY_META" ] && [ ! -L "${APP_DIR}/current" ]; then
    read_meta "$LEGACY_META"
    if migration_possible; then
      migrate_legacy_install
      exit $?
    fi
    if [ "$TARGET_USER" = "root" ]; then
      warn "my-claw runs as root here; user units need an unprivileged service user. Staying on the legacy layout."
    fi
    read_registry_env "$LEGACY_ENV"
    install_legacy_root "$FORCE" "$FILE"
    exit $?
  fi
  # A migrated install: drop to the owner of the tree, so `sudo myclaw update` keeps working and
  # nothing inside a user-owned tree ever runs as root.
  [ -L "${APP_DIR}/current" ] || die "${APP_DIR} is not a my-claw install (no current release). Run install.sh first."
  owner="$(stat -c %U "$APP_DIR")"
  [ "$owner" != "root" ] || die "${APP_DIR} is owned by root but carries no legacy metadata; run install.sh"
  uid="$(id -u "$owner")"
  exec runuser -u "$owner" -- env "HOME=$(getent passwd "$owner" | cut -d: -f6)" \
    "XDG_RUNTIME_DIR=/run/user/${uid}" "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus" \
    "${APP_DIR}/current/packaging/update.sh" ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"}
fi

[ -f "${APP_DIR}/.install-meta" ] || die "${APP_DIR}/.install-meta not found. Install my-claw first."
read_meta "${APP_DIR}/.install-meta"
if [ "$(id -un)" != "$TARGET_USER" ]; then
  die "my-claw belongs to ${TARGET_USER}; run this as ${TARGET_USER} (or with sudo, which drops to that user)"
fi
read_registry_env "${TARGET_HOME}/.my-claw/.env"

case "$MODE" in
  activate) activate_current ;;
  update) install_user "$FORCE" "$FILE" ;;
esac
