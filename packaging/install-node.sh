#!/bin/bash
set -euo pipefail

# Installs the my-claw node client (docs/remote-nodes.md). Served by the my-claw it joins:
#
#   curl -fsSL 'https://myclaw.example/node/install.sh' | sudo sh -s -- --pair ABCD1234 --server wss://myclaw.example/node
#
# Run with sudo for the admin install (system service, dedicated myclaw-node account with
# passwordless sudo); without, for the user install (user service, the user's own rights).
# Options: --pair <code> --server <ws url> [--mode user|admin] [--name <name>] [--workdir <dir>]
#          [--version <v>] [--dir <config dir>]
#
# The binary comes from the my-claw being joined (/node/download), gated by the same claim code,
# so this machine needs no release key of its own. Re-run the same command to update.

PAIR_CODE="${MYCLAW_NODE_CODE:-}"
SERVER="${MYCLAW_NODE_SERVER:-}"
MODE=""
NAME=""
WORKDIR=""
VERSION=""
CONFIG_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --pair) PAIR_CODE="${2:-}"; shift 2 ;;
    --server) SERVER="${2:-}"; shift 2 ;;
    --mode) MODE="${2:-}"; shift 2 ;;
    --name) NAME="${2:-}"; shift 2 ;;
    --workdir) WORKDIR="${2:-}"; shift 2 ;;
    --version) VERSION="${2:-}"; shift 2 ;;
    --dir) CONFIG_DIR="${2:-}"; shift 2 ;;
    *) echo "Error: unknown option $1" >&2; exit 1 ;;
  esac
done

if [ -z "$PAIR_CODE" ] || [ -z "$SERVER" ]; then
  echo "Usage: install-node.sh --pair <code> --server <ws url> [--mode user|admin]" >&2
  echo "(mint the code with \`myclaw node add\` on the my-claw this machine joins)" >&2
  exit 1
fi
case "$SERVER" in
  ws://*|wss://*) ;;
  *) echo "Error: --server must be a ws:// or wss:// URL" >&2; exit 1 ;;
esac
SERVER="${SERVER%/}"

if [ -z "$MODE" ]; then
  if [ "$(id -u)" -eq 0 ]; then MODE="admin"; else MODE="user"; fi
fi
if [ "$MODE" = "admin" ] && [ "$(id -u)" -ne 0 ]; then
  echo "Error: the admin install needs root (sudo). Use --mode user otherwise." >&2
  exit 1
fi

case "$(uname -s)" in
  Linux) OS="linux" ;;
  Darwin) OS="darwin" ;;
  *) echo "Error: unsupported OS $(uname -s). On Windows use install-node.ps1." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) echo "Error: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
TARGET="${OS}-${ARCH}"

PAIR_ARGS=(--server "$SERVER" --code "$PAIR_CODE")
[ -n "$NAME" ] && PAIR_ARGS+=(--name "$NAME")
[ -n "$WORKDIR" ] && PAIR_ARGS+=(--workdir "$WORKDIR")

# wss://host/node -> https://host/node
HTTP_BASE="$(printf '%s' "$SERVER" | sed -e 's|^wss://|https://|' -e 's|^ws://|http://|')"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/myclaw-node-install.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Downloading the node client for ${TARGET}..."
QUERY="target=${TARGET}"
[ -n "$VERSION" ] && QUERY="${QUERY}&version=${VERSION}"
curl -fsSL -H "Authorization: Bearer ${PAIR_CODE}" "${HTTP_BASE}/download?${QUERY}" -o "${TMP_DIR}/myclaw-node" || {
  echo "Error: the download was refused. Is the code still valid (ten minutes, single use at pairing)?" >&2
  exit 1
}
chmod 755 "${TMP_DIR}/myclaw-node"
"${TMP_DIR}/myclaw-node" version >/dev/null || { echo "Error: the downloaded binary does not run on this machine" >&2; exit 1; }

# ---------------------------------------------------------------- admin install

install_admin_linux() {
  BIN=/usr/local/bin/myclaw-node
  CONFIG_DIR="${CONFIG_DIR:-/etc/my-claw-node}"

  if ! id -u myclaw-node >/dev/null 2>&1; then
    echo "Creating the myclaw-node system account..."
    useradd --system --home-dir /var/lib/my-claw-node --create-home --shell /usr/sbin/nologin myclaw-node
  fi

  install -m 755 "${TMP_DIR}/myclaw-node" "$BIN"
  mkdir -p "$CONFIG_DIR"
  chown myclaw-node:myclaw-node "$CONFIG_DIR"
  chmod 700 "$CONFIG_DIR"

  # The admin install is meant to do admin things: passwordless sudo for the service account.
  # This is root-equivalent by design -- remove the file to take it back.
  SUDOERS=/etc/sudoers.d/myclaw-node
  if [ ! -f "$SUDOERS" ]; then
    printf 'myclaw-node ALL=(ALL) NOPASSWD: ALL\n' > "$SUDOERS"
    chmod 440 "$SUDOERS"
    visudo -cf "$SUDOERS" >/dev/null || { rm -f "$SUDOERS"; echo "Error: sudoers file rejected" >&2; exit 1; }
    echo "Note: myclaw-node may sudo without a password (root-equivalent). Remove ${SUDOERS} to revoke."
  fi

  echo "Pairing..."
  sudo -u myclaw-node env MYCLAW_NODE_DIR="$CONFIG_DIR" "$BIN" pair "${PAIR_ARGS[@]}"

  cat > /etc/systemd/system/my-claw-node.service <<UNIT
[Unit]
Description=my-claw node (remote hands for a my-claw server)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=myclaw-node
Group=myclaw-node
Environment=MYCLAW_NODE_DIR=${CONFIG_DIR}
ExecStart=${BIN} run
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable --now my-claw-node.service
  echo "Service: my-claw-node.service (systemctl status my-claw-node)"
}

install_admin_macos() {
  BIN=/usr/local/bin/myclaw-node
  CONFIG_DIR="${CONFIG_DIR:-/etc/my-claw-node}"

  if ! id -u myclaw-node >/dev/null 2>&1; then
    echo "Creating the myclaw-node account..."
    # Hidden system user with no shell, like the Linux one. First unused id from 350 downward.
    local uid=350
    while dscl . -list /Users UniqueID | awk '{print $2}' | grep -q "^${uid}$"; do uid=$((uid - 1)); done
    dscl . -create /Users/myclaw-node
    dscl . -create /Users/myclaw-node UserShell /usr/bin/false
    dscl . -create /Users/myclaw-node RealName "my-claw node"
    dscl . -create /Users/myclaw-node UniqueID "$uid"
    dscl . -create /Users/myclaw-node PrimaryGroupID 20
    dscl . -create /Users/myclaw-node NFSHomeDirectory /var/lib/my-claw-node
    mkdir -p /var/lib/my-claw-node && chown myclaw-node /var/lib/my-claw-node
  fi

  install -m 755 "${TMP_DIR}/myclaw-node" "$BIN"
  mkdir -p "$CONFIG_DIR"
  chown myclaw-node "$CONFIG_DIR"
  chmod 700 "$CONFIG_DIR"

  SUDOERS=/etc/sudoers.d/myclaw-node
  if [ ! -f "$SUDOERS" ]; then
    printf 'myclaw-node ALL=(ALL) NOPASSWD: ALL\n' > "$SUDOERS"
    chmod 440 "$SUDOERS"
    echo "Note: myclaw-node may sudo without a password (root-equivalent). Remove ${SUDOERS} to revoke."
  fi

  echo "Pairing..."
  sudo -u myclaw-node env MYCLAW_NODE_DIR="$CONFIG_DIR" "$BIN" pair "${PAIR_ARGS[@]}"

  PLIST=/Library/LaunchDaemons/fr.kssimi.myclaw-node.plist
  cat > "$PLIST" <<PLIST_END
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>fr.kssimi.myclaw-node</string>
  <key>UserName</key><string>myclaw-node</string>
  <key>EnvironmentVariables</key><dict><key>MYCLAW_NODE_DIR</key><string>${CONFIG_DIR}</string></dict>
  <key>ProgramArguments</key><array><string>${BIN}</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
PLIST_END
  chmod 644 "$PLIST"
  launchctl bootout system "$PLIST" >/dev/null 2>&1 || true
  launchctl bootstrap system "$PLIST"
  echo "Service: fr.kssimi.myclaw-node (launchctl print system/fr.kssimi.myclaw-node)"
}

# ----------------------------------------------------------------- user install

install_user_linux() {
  BIN="$HOME/.local/bin/myclaw-node"
  CONFIG_DIR="${CONFIG_DIR:-$HOME/.my-claw-node}"

  mkdir -p "$HOME/.local/bin"
  install -m 755 "${TMP_DIR}/myclaw-node" "$BIN"

  echo "Pairing..."
  "$BIN" pair "${PAIR_ARGS[@]}" --dir "$CONFIG_DIR"

  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/my-claw-node.service" <<UNIT
[Unit]
Description=my-claw node (remote hands for a my-claw server)
After=network-online.target

[Service]
Type=simple
ExecStart=${BIN} run
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT

  systemctl --user daemon-reload
  systemctl --user enable --now my-claw-node.service
  # Without linger the service dies with the last session; enabling it may need root.
  loginctl enable-linger "$USER" >/dev/null 2>&1 || sudo -n loginctl enable-linger "$USER" >/dev/null 2>&1 || \
    echo "Note: run \`sudo loginctl enable-linger $USER\` so the node survives logout."
  echo "Service: my-claw-node.service (systemctl --user status my-claw-node)"
}

install_user_macos() {
  BIN="$HOME/.local/bin/myclaw-node"
  CONFIG_DIR="${CONFIG_DIR:-$HOME/.my-claw-node}"

  mkdir -p "$HOME/.local/bin"
  install -m 755 "${TMP_DIR}/myclaw-node" "$BIN"

  echo "Pairing..."
  "$BIN" pair "${PAIR_ARGS[@]}" --dir "$CONFIG_DIR"

  PLIST="$HOME/Library/LaunchAgents/fr.kssimi.myclaw-node.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<PLIST_END
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>fr.kssimi.myclaw-node</string>
  <key>ProgramArguments</key><array><string>${BIN}</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
PLIST_END
  launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "Service: fr.kssimi.myclaw-node (launchctl print gui/$(id -u)/fr.kssimi.myclaw-node)"
}

# ---------------------------------------------------------------------- dispatch

if [ "$MODE" = "admin" ]; then
  if [ "$OS" = "linux" ]; then install_admin_linux; else install_admin_macos; fi
else
  if [ "$OS" = "linux" ]; then install_user_linux; else install_user_macos; fi
fi

echo ""
echo "Node installed and paired (${MODE} mode, ${TARGET})."
echo "Check it from the my-claw: myclaw node ls"
