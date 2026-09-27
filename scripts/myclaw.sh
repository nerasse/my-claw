#!/bin/bash
set -uo pipefail

# myclaw: CLI wrapper for my-claw service management
# Usage: myclaw <command>
#
# my-claw belongs to its service user and runs under that user's systemd manager
# (docs/install-layout.md): every command here is a `systemctl --user` call or a script of the
# tree, run as that user. Root gets dropped to the owner of the tree first, so `sudo myclaw`
# keeps working. An install that has not moved yet (root-owned tree, system units) is driven the
# old way, with sudo, until its next update moves it.

APP_DIR="/opt/my-claw"
START_ORDER="my-claw-xvfb my-claw-chromium my-claw-browser-sidecar my-claw-whisper my-claw-vnc my-claw-novnc my-claw"
STOP_ORDER="my-claw my-claw-whisper my-claw-browser-sidecar my-claw-vnc my-claw-novnc"
# The browser and the display it draws on. They hold the owner's work (open tabs, a sign-in, a form
# stopped at its e-mail code), so stop and restart leave them running unless asked: two restarts on
# the night of 2026-09-26 killed two applications at that screen. Xvfb is part of it because
# Chromium requires it: stopping the display takes the browser down with it. docs/browser.md.
BROWSER_ORDER="my-claw-chromium my-claw-xvfb"

cmd="${1:-}"
WITH_BROWSER=0
for arg in "$@"; do
  [ "$arg" = "--with-browser" ] && WITH_BROWSER=1
done

if [ -L "${APP_DIR}/current" ]; then
  MODE="user"
  TREE="${APP_DIR}/current"
  META_FILE="${APP_DIR}/.install-meta"
  SYSCTL=(systemctl --user)
else
  MODE="legacy"
  TREE="$APP_DIR"
  META_FILE="/etc/my-claw/.install-meta"
  SYSCTL=(systemctl)
fi

TARGET_USER=""
TARGET_HOME=""
if [ -f "$META_FILE" ]; then
  while IFS='=' read -r key value; do
    case "$key" in
      USER) TARGET_USER="$value" ;;
      HOME) TARGET_HOME="$value" ;;
    esac
  done < "$META_FILE"
fi

if [ "$MODE" = "user" ]; then
  owner="$(stat -c %U "$APP_DIR")"
  if [ "$EUID" -eq 0 ] && [ "$owner" != "root" ]; then
    uid="$(id -u "$owner")"
    exec runuser -u "$owner" -- env "HOME=$(getent passwd "$owner" | cut -d: -f6)" \
      "XDG_RUNTIME_DIR=/run/user/${uid}" "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus" \
      "$0" "$@"
  fi
  if [ -n "$TARGET_USER" ] && [ "$(id -un)" != "$TARGET_USER" ]; then
    echo "Error: my-claw belongs to ${TARGET_USER}; run 'myclaw' as that user (or with sudo)."
    exit 1
  fi
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"
fi

# Resolve absolute bun path (not always in root PATH)
resolve_bun() {
  local bun_path=""
  if command -v bun >/dev/null 2>&1; then
    bun_path="$(command -v bun)"
  fi
  if [ -z "$bun_path" ] && [ -n "$TARGET_HOME" ] && [ -x "${TARGET_HOME}/.bun/bin/bun" ]; then
    bun_path="${TARGET_HOME}/.bun/bin/bun"
  fi
  echo "$bun_path"
}

BUN_BIN="$(resolve_bun)"

resolve_entry() {
  if [ -f "${TREE}/src/index.ts" ]; then
    echo "${TREE}/src/index.ts"
  elif [ -f "$(pwd)/src/index.ts" ]; then
    echo "$(pwd)/src/index.ts"
  else
    echo "${TREE}/src/index.ts"
  fi
}

# Forward `myclaw codex|claude|device|web ...` to the app entrypoint. What they write (auth
# tokens, config.json) must be owned by the service user; a legacy install invoked as root drops
# to that user (su preserves the TTY for the interactive `claude login`).
run_cli() {
  local provider="$1"; shift
  local entry; entry="$(resolve_entry)"
  if [ "$EUID" -eq 0 ]; then
    if [ -z "$TARGET_USER" ]; then
      echo "Error: cannot determine the service user; run 'myclaw $provider ...' as that user (not root)."
      exit 1
    fi
    local ubun="${TARGET_HOME}/.bun/bin/bun"
    [ -x "$ubun" ] || ubun="bun"
    exec su - "$TARGET_USER" -c "'$ubun' run '$entry' $provider $*"
  fi
  local bun_bin="$BUN_BIN"; [ -n "$bun_bin" ] || bun_bin="bun"
  exec "$bun_bin" run "$entry" "$provider" "$@"
}

usage() {
  echo "Usage: myclaw <command>"
  echo ""
  echo "Commands:"
  echo "  start     Start my-claw and all dependencies"
  echo "  stop      Stop my-claw and its services; the browser keeps running (--with-browser: stop it too)"
  echo "  restart   Restart my-claw and its services; the browser keeps running (--with-browser: restart it too)"
  echo "  status    Show status of my-claw service"
  echo "  logs      Follow the server log"
  echo "  dev       Stop the service and run development mode (bun --watch) from the current directory"
  echo "  device    Pair and revoke app/browser devices (add, ls, rm, disable, enable)"
  echo "  web       Install and switch the web client bundle (install, ls, use, rm)"
  echo "  update    Update to the latest release, web client bundle included (or myclaw update <version>); the browser keeps running (--with-browser)"
  echo "  codex     ChatGPT/Codex auth: myclaw codex <login|status|logout>"
  echo "  claude    Claude subscription auth: myclaw claude <login|set-token <token>|status|logout>"
  echo ""
  echo "Examples:"
  echo "  myclaw status"
  echo "  myclaw update"
  echo "  myclaw codex login"
  exit 1
}

require_sudo() {
  if [ "$MODE" = "legacy" ] && [ "$EUID" -ne 0 ]; then
    echo "Error: 'myclaw $cmd' requires sudo on this install"
    echo "Run: sudo myclaw $cmd"
    exit 1
  fi
}

# A process is stale when nothing manages it: its unit is not running. `myclaw start` used to kill
# every Chromium on the CDP port, including the one its own unit was running, open tabs and all.
kill_stale() {
  local user="${TARGET_USER:-$(id -un)}" pid
  if ! "${SYSCTL[@]}" is-active --quiet my-claw-xvfb.service 2>/dev/null; then
    for pid in $(pgrep -u "$user" -f "Xvfb :99" 2>/dev/null || true); do
      echo "  Killing stale Xvfb :99 (PID $pid)..."
      kill -9 "$pid" 2>/dev/null || true
    done
  fi
  if ! "${SYSCTL[@]}" is-active --quiet my-claw-chromium.service 2>/dev/null; then
    for pid in $(pgrep -u "$user" -f "chromium.*9222" 2>/dev/null || true); do
      echo "  Killing stale Chromium CDP (PID $pid)..."
      kill -9 "$pid" 2>/dev/null || true
    done
  fi
  if ! "${SYSCTL[@]}" is-active --quiet my-claw-whisper.service 2>/dev/null; then
    for pid in $(pgrep -u "$user" -f "whisper-server.py" 2>/dev/null || true); do
      echo "  Killing stale Whisper server (PID $pid)..."
      kill -9 "$pid" 2>/dev/null || true
    done
  fi
}

start_services() {
  require_sudo
  kill_stale
  echo "Starting my-claw services..."
  for svc in $START_ORDER; do
    echo "  Starting ${svc}..."
    "${SYSCTL[@]}" start "${svc}.service" 2>/dev/null || true
  done
  echo ""
  echo "Done. Check: myclaw status"
}

stop_services() {
  require_sudo
  echo "Stopping my-claw services..."
  for svc in $STOP_ORDER; do
    echo "  Stopping ${svc}..."
    "${SYSCTL[@]}" stop "${svc}.service" 2>/dev/null || true
  done
  if [ "$WITH_BROWSER" -eq 1 ]; then
    for svc in $BROWSER_ORDER; do
      echo "  Stopping ${svc}..."
      "${SYSCTL[@]}" stop "${svc}.service" 2>/dev/null || true
    done
  else
    echo "  Browser left running (its tabs are the owner's work): add --with-browser to stop it too."
  fi
  echo "Done."
}

restart_services() {
  require_sudo
  stop_services
  echo ""
  start_services
}

show_status() {
  echo "=== my-claw status ==="
  "${SYSCTL[@]}" status my-claw.service --no-pager || true
  echo ""
  echo "=== All services ==="
  "${SYSCTL[@]}" list-units --type=service --state=running "my-claw*" --no-pager || true
}

follow_logs() {
  exec tail -f /var/log/my-claw/my-claw.log
}

dev_mode() {
  MAIN="my-claw"
  DEPS="my-claw-xvfb my-claw-chromium my-claw-browser-sidecar my-claw-whisper my-claw-vnc my-claw-novnc"
  WAS_MAIN_ACTIVE=""
  local SUDO=""
  if [ "$MODE" = "legacy" ] && [ "$EUID" -ne 0 ]; then
    SUDO="sudo"
  fi

  if "${SYSCTL[@]}" is-active --quiet "${MAIN}.service" 2>/dev/null; then
    WAS_MAIN_ACTIVE="yes"
    echo ""
    echo "Stopping ${MAIN} for development mode..."
    $SUDO "${SYSCTL[@]}" stop "${MAIN}.service"
    echo "  Stopped ${MAIN}"
  fi

  MISSING_DEPS=""
  for svc in $DEPS; do
    if ! "${SYSCTL[@]}" is-active --quiet "${svc}.service" 2>/dev/null; then
      MISSING_DEPS="$MISSING_DEPS ${svc}"
    fi
  done
  if [ -n "$MISSING_DEPS" ]; then
    echo ""
    echo "Starting missing dependencies..."
    for svc in $MISSING_DEPS; do
      echo "  Starting ${svc}..."
      $SUDO "${SYSCTL[@]}" start "${svc}.service" 2>/dev/null || true
    done
  fi

  CLEANUP_DONE=""
  cleanup() {
    if [ -n "$CLEANUP_DONE" ]; then
      return
    fi
    CLEANUP_DONE="yes"
    echo ""
    echo ""
    echo "Development server stopped."
    if [ "$WAS_MAIN_ACTIVE" = "yes" ]; then
      echo ""
      read -r -p "Restart ${MAIN} service? [Y/n] " REPLY
      REPLY="${REPLY:-y}"
      if [[ "$REPLY" =~ ^[Yy]$ ]]; then
        echo "Starting ${MAIN}..."
        $SUDO "${SYSCTL[@]}" start "${MAIN}.service"
        echo "Done. Check: myclaw status"
      else
        echo "${MAIN} not started. Run 'myclaw start' to relaunch."
      fi
    fi
    exit 0
  }
  trap cleanup INT TERM EXIT

  # The app must see the service user's home (sudo changes HOME to /root).
  local dev_home="${TARGET_HOME:-}"
  if [ -z "$dev_home" ] && [ -n "${SUDO_USER:-}" ]; then
    dev_home="$(getent passwd "$SUDO_USER" | cut -d: -f6)"
  fi
  if [ -z "$dev_home" ]; then
    dev_home="${HOME}"
  fi

  echo ""
  echo "Dependencies active: ${DEPS}"
  echo "Main app stopped. Running dev server..."
  echo "Press Ctrl+C to stop"
  echo ""

  HOME="${dev_home}" "${BUN_BIN}" run --watch src/index.ts &
  BUN_PID=$!
  # shellcheck disable=SC2064  # the pid must expand now: it is the one to kill
  trap "kill $BUN_PID 2>/dev/null; cleanup" INT
  wait $BUN_PID
  cleanup
}

run_update() {
  if [ "$MODE" = "legacy" ]; then
    require_sudo
    if command -v my-claw-update >/dev/null 2>&1; then
      exec my-claw-update "$@"
    fi
    echo "Error: my-claw-update not found. Install my-claw first."
    exit 1
  fi
  # Arguments are forwarded: without them `myclaw update 0.4.1 --force` silently installed the
  # latest instead, and pinning a version was only reachable through the updater itself.
  exec "${TREE}/packaging/update.sh" "$@"
}

case "$cmd" in
  start)
    start_services
    ;;
  stop)
    stop_services
    ;;
  restart)
    restart_services
    ;;
  status)
    show_status
    ;;
  logs)
    follow_logs
    ;;
  dev)
    dev_mode
    ;;
  update)
    shift
    run_update "$@"
    ;;
  codex)
    shift
    run_cli codex "$@"
    ;;
  claude)
    shift
    run_cli claude "$@"
    ;;
  device)
    shift
    run_cli device "$@"
    ;;
  web)
    shift
    run_cli web "$@"
    ;;
  *)
    usage
    ;;
esac
