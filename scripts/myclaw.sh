#!/bin/bash
set -uo pipefail

# myclaw — CLI wrapper for my-claw service management
# Usage: myclaw <command>
# Commands: start, stop, restart, status, dev, update

SERVICES="my-claw-xvfb my-claw-chromium my-claw-whisper my-claw-vnc my-claw-novnc my-claw"
APP_SERVICES="my-claw my-claw-whisper my-claw-chromium my-claw-vnc my-claw-novnc my-claw-xvfb"

cmd="${1:-}"

# Resolve absolute bun path (not always in root PATH)
resolve_bun() {
  local bun_path=""
  if command -v bun >/dev/null 2>&1; then
    bun_path="$(command -v bun)"
  fi
  if [ -z "$bun_path" ] && [ -f /etc/my-claw/.install-meta ]; then
    local target_user=""
    while IFS='=' read -r key value; do
      case "$key" in USER) target_user="$value" ;; esac
    done < /etc/my-claw/.install-meta
    if [ -n "$target_user" ] && [ -x "/home/${target_user}/.bun/bin/bun" ]; then
      bun_path="/home/${target_user}/.bun/bin/bun"
    elif [ -n "$target_user" ] && [ -x "$(eval echo "~${target_user}")/.bun/bin/bun" ]; then
      bun_path="$(eval echo "~${target_user}")/.bun/bin/bun"
    fi
  fi
  echo "$bun_path"
}

BUN_BIN="$(resolve_bun)"

usage() {
  echo "Usage: myclaw <command>"
  echo ""
  echo "Commands:"
  echo "  start     Start my-claw and all dependencies"
  echo "  stop      Stop my-claw and all dependencies"
  echo "  restart   Restart all services"
  echo "  status    Show status of my-claw service"
  echo "  dev       Stop services and run development mode (bun --watch)"
  echo "  update    Update to latest release"
  echo ""
  echo "Examples:"
  echo "  myclaw start"
  echo "  myclaw status"
  echo "  sudo myclaw restart"
  exit 1
}

require_sudo() {
  if [ "$EUID" -ne 0 ]; then
    echo "Error: 'myclaw $cmd' requires sudo"
    echo "Run: sudo myclaw $cmd"
    exit 1
  fi
}

start_services() {
  require_sudo

  # Detect target user from install metadata
  TARGET_USER=""
  if [ -f /etc/my-claw/.install-meta ]; then
    while IFS='=' read -r key value; do
      case "$key" in USER) TARGET_USER="$value" ;; esac
    done < /etc/my-claw/.install-meta
  fi

  # Kill stale user processes blocking our resources
  if [ -n "$TARGET_USER" ]; then
    # Stop any user-level systemd service that might hold :99
    su - "$TARGET_USER" -c "systemctl --user stop xvfb.service 2>/dev/null || true" 2>/dev/null || true

    for pid in $(pgrep -u "$TARGET_USER" -f "Xvfb :99" 2>/dev/null || true); do
      echo "  Killing stale Xvfb :99 (PID $pid)..."
      kill -9 "$pid" 2>/dev/null || true
    done
    for pid in $(pgrep -u "$TARGET_USER" -f "chromium.*9222" 2>/dev/null || true); do
      echo "  Killing stale Chromium CDP (PID $pid)..."
      kill -9 "$pid" 2>/dev/null || true
    done
    for pid in $(pgrep -u "$TARGET_USER" -f "faster-whisper-server.*8000" 2>/dev/null || true); do
      echo "  Killing stale Whisper server (PID $pid)..."
      kill -9 "$pid" 2>/dev/null || true
    done
  fi

  echo "Starting my-claw services..."
  for svc in $SERVICES; do
    echo "  Starting ${svc}..."
    systemctl start "${svc}.service" 2>/dev/null || true
  done
  echo ""
  echo "Done. Check: myclaw status"
}

stop_services() {
  require_sudo
  echo "Stopping my-claw services..."
  for svc in $APP_SERVICES; do
    echo "  Stopping ${svc}..."
    systemctl stop "${svc}.service" 2>/dev/null || true
  done
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
  systemctl status my-claw.service --no-pager || true
  echo ""
  echo "=== All services ==="
  systemctl list-units --type=service --state=running "my-claw*" --no-pager || true
}

dev_mode() {
  MAIN="my-claw"
  DEPS="my-claw-xvfb my-claw-chromium my-claw-whisper my-claw-vnc my-claw-novnc"
  WAS_MAIN_ACTIVE=""

  # Stop main app if running
  if systemctl is-active --quiet "${MAIN}.service" 2>/dev/null; then
    WAS_MAIN_ACTIVE="yes"
    echo ""
    echo "Stopping ${MAIN} for development mode..."
    sudo systemctl stop "${MAIN}.service"
    echo "  Stopped ${MAIN}"
  fi

  # Ensure dependencies are running
  MISSING_DEPS=""
  for svc in $DEPS; do
    if ! systemctl is-active --quiet "${svc}.service" 2>/dev/null; then
      MISSING_DEPS="$MISSING_DEPS ${svc}"
    fi
  done

  if [ -n "$MISSING_DEPS" ]; then
    echo ""
    echo "Starting missing dependencies..."
    for svc in $MISSING_DEPS; do
      echo "  Starting ${svc}..."
      sudo systemctl start "${svc}.service" 2>/dev/null || true
    done
  fi

  # Trap Ctrl+C to offer restart of main service
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
      read -p "Restart ${MAIN} systemd service? [Y/n] " REPLY
      REPLY="${REPLY:-y}"
      if [[ "$REPLY" =~ ^[Yy]$ ]]; then
        echo "Starting ${MAIN}..."
        sudo systemctl start "${MAIN}.service"
        echo "Done. Check: myclaw status"
      else
        echo "${MAIN} not started. Run 'myclaw start' to relaunch."
      fi
    fi
    exit 0
  }

  trap cleanup INT TERM EXIT

  # Ensure app sees the correct home directory (sudo changes HOME to /root)
  local dev_home=""
  if [ -f /etc/my-claw/.install-meta ]; then
    while IFS='=' read -r key value; do
      case "$key" in HOME) dev_home="$value" ;; esac
    done < /etc/my-claw/.install-meta
  fi
  if [ -z "$dev_home" ] && [ -n "${SUDO_USER:-}" ]; then
    dev_home="$(eval echo "~${SUDO_USER}")"
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
  trap "kill $BUN_PID 2>/dev/null; cleanup" INT
  wait $BUN_PID
  cleanup
}

run_update() {
  require_sudo
  if command -v my-claw-update >/dev/null 2>&1; then
    exec my-claw-update
  else
    echo "Error: my-claw-update not found."
    echo "Install my-claw first."
    exit 1
  fi
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
  dev)
    dev_mode
    ;;
  update)
    run_update
    ;;
  *)
    usage
    ;;
esac
