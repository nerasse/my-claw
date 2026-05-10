#!/bin/bash
set -uo pipefail

# myclaw — CLI wrapper for my-claw service management
# Usage: myclaw <command>
# Commands: start, stop, restart, status, dev, update

SERVICES="my-claw-xvfb my-claw-chromium my-claw-whisper my-claw-vnc my-claw-novnc my-claw"
APP_SERVICES="my-claw my-claw-whisper my-claw-chromium my-claw-vnc my-claw-novnc my-claw-xvfb"

cmd="${1:-}"

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
  # Check if any service is active
  ACTIVE_SERVICES=""
  for svc in $SERVICES; do
    if systemctl is-active --quiet "${svc}.service" 2>/dev/null; then
      ACTIVE_SERVICES="$ACTIVE_SERVICES ${svc}"
    fi
  done

  if [ -n "$ACTIVE_SERVICES" ]; then
    echo ""
    echo "Systemd services are running:$ACTIVE_SERVICES"
    echo "Stopping them for development mode..."
    echo ""
    for svc in $ACTIVE_SERVICES; do
      sudo systemctl stop "${svc}.service"
      echo "  Stopped ${svc}"
    done
    echo ""
  fi

  # Trap Ctrl+C to offer restart
  cleanup() {
    echo ""
    echo ""
    echo "Development server stopped."
    if [ -n "$ACTIVE_SERVICES" ]; then
      echo ""
      read -p "Relaunch systemd services? [Y/n] " REPLY
      REPLY="${REPLY:-y}"
      if [[ "$REPLY" =~ ^[Yy]$ ]]; then
        echo "Starting services..."
        for svc in $SERVICES; do
          sudo systemctl start "${svc}.service" 2>/dev/null || true
        done
        echo "Done. Check: myclaw status"
      else
        echo "Services not started. Run 'myclaw start' to relaunch."
      fi
    fi
    exit 0
  }

  trap cleanup INT TERM EXIT

  echo "Starting my-claw in development mode..."
  echo "Press Ctrl+C to stop"
  echo ""

  exec bun run --watch src/index.ts
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
