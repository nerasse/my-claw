#!/bin/bash
set -uo pipefail

# Dev wrapper for my-claw
# Usage: bun run dev (via package.json)
# Stops systemd services before dev, offers restart after.

SERVICES="my-claw my-claw-whisper my-claw-chromium my-claw-xvfb my-claw-vnc my-claw-novnc"

# Check if any my-claw service is active
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

# Trap Ctrl+C and other exits to offer service restart
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
      echo "Done. Check: sudo systemctl status my-claw"
    else
      echo "Services not started. Start manually with:"
      echo "  sudo systemctl start my-claw"
    fi
  fi
  exit 0
}

trap cleanup INT TERM EXIT

echo "Starting my-claw in development mode..."
echo "Press Ctrl+C to stop"
echo ""

# Run the actual dev server
exec bun run --watch src/index.ts
