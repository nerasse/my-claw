#!/bin/bash
set -uo pipefail

# Dev wrapper for my-claw
# Usage: bun run dev (via package.json)
# Stops only my-claw app, keeps deps (xvfb, chromium, whisper, vnc, novnc).
# If deps are missing, starts them.

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

# Trap Ctrl+C and other exits to restart main service if it was active
cleanup() {
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
      echo "Done. Check: sudo systemctl status ${MAIN}"
    else
      echo "${MAIN} not started. Start manually with:"
      echo "  sudo systemctl start ${MAIN}"
    fi
  fi
  exit 0
}

trap cleanup INT TERM EXIT

echo ""
echo "Dependencies active: $DEPS"
echo "Main app stopped. Running dev server..."
echo "Press Ctrl+C to stop"
echo ""

exec "${BUN_BIN}" run --watch src/index.ts
