#!/bin/bash
set -euo pipefail

# Install my-claw from an extracted tarball.
# Usage: sudo ./install.sh [--user <username>]
# If --user is not given, the user is taken from $SUDO_USER, or asked.
#
# Root does the system side once: packages, /opt/my-claw and /var/log/my-claw handed to the
# service user, linger, the /usr/local/bin/myclaw stub. Everything else, units included, is the
# service user's (docs/install-layout.md), and the last step runs as that user.

if [ "$EUID" -ne 0 ]; then
  echo "Error: run with sudo or as root"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
APP_DIR="/opt/my-claw"

TARGET_USER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --user)
      shift
      TARGET_USER="${1:-}"
      shift
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: sudo ./install.sh [--user <username>]"
      exit 1
      ;;
  esac
done

if [ -z "$TARGET_USER" ]; then
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
    TARGET_USER="$SUDO_USER"
    echo "Detected user from sudo: ${TARGET_USER}"
  else
    read -r -p "Install my-claw for which user? " TARGET_USER
    if [ -z "$TARGET_USER" ]; then
      echo "Error: username required"
      exit 1
    fi
  fi
fi

if ! id -u "$TARGET_USER" >/dev/null 2>&1; then
  echo "Error: user '${TARGET_USER}' does not exist"
  exit 1
fi
if [ "$TARGET_USER" = "root" ]; then
  echo "Error: my-claw runs as an unprivileged user, with an agent that has a shell. Create one and pass --user."
  exit 1
fi

if [ -f /etc/my-claw/.install-meta ] && [ ! -L "${APP_DIR}/current" ]; then
  echo "An older my-claw install (root-owned, system units) is present."
  echo "It moves to the new layout by itself with the next update: run 'sudo my-claw-update', or wait for the timer."
  exit 1
fi

TARGET_UID="$(id -u "$TARGET_USER")"
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
VERSION="$(jq -r .version "${PROJECT_DIR}/package.json" 2>/dev/null || true)"
if [ -z "$VERSION" ] || [ "$VERSION" = "null" ]; then
  echo "Error: cannot read the version from ${PROJECT_DIR}/package.json (is jq installed?)"
  exit 1
fi

echo "Installing my-claw ${VERSION} for user: ${TARGET_USER}"
echo "Home directory: ${TARGET_HOME}"

# ---------------------------------------------------------------------------
# System packages
# ---------------------------------------------------------------------------
MISSING_BINS=""
for dep in jq curl ffmpeg chromium Xvfb x11vnc websockify; do
  if ! command -v "$dep" >/dev/null 2>&1; then
    MISSING_BINS="$MISSING_BINS $dep"
  fi
done
# The user manager needs a session bus (dbus-user-session on Debian/Ubuntu); a server image
# may lack it. Detected by the socket unit the package ships, not by the package name.
if [ ! -e /usr/lib/systemd/user/dbus.socket ] && [ ! -e /lib/systemd/user/dbus.socket ]; then
  MISSING_BINS="$MISSING_BINS dbus-user-session"
fi

if [ -n "$MISSING_BINS" ]; then
  echo ""
  echo "Missing dependencies:${MISSING_BINS}. Installing..."
  echo ""
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y jq curl ffmpeg chromium xvfb x11vnc websockify dbus-user-session
  elif command -v pacman >/dev/null 2>&1; then
    pacman -S --needed --noconfirm jq curl ffmpeg chromium xorg-server-xvfb x11vnc python-websockify
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y jq curl ffmpeg chromium Xvfb x11vnc python-websockify
  else
    echo "Warning: could not detect the package manager. Install by hand:"
    echo "  jq curl ffmpeg chromium Xvfb x11vnc websockify, and the systemd user session bus"
  fi
  echo ""
fi

# Runtimes are checked here only to fail early with a clear message; the service user's copy
# (~/.bun) counts, root's PATH rarely has it.
if ! command -v bun >/dev/null 2>&1 && [ ! -x "${TARGET_HOME}/.bun/bin/bun" ]; then
  echo "Error: bun is required. As ${TARGET_USER}: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1 && ! command -v python >/dev/null 2>&1; then
  echo "Error: python3 is required but not installed."
  exit 1
fi
if ! command -v node >/dev/null 2>&1 && ! ls "${TARGET_HOME}"/.nvm/versions/node/*/bin/node >/dev/null 2>&1; then
  echo "WARNING: node not found. The browser sidecar will be skipped (browsing disabled)."
  echo "         Install Node.js and run 'myclaw update --force' to enable it."
fi

# ---------------------------------------------------------------------------
# Directories, all owned by the service user
# ---------------------------------------------------------------------------
mkdir -p "${TARGET_HOME}/.my-claw" "${TARGET_HOME}/.config/systemd/user" /var/log/my-claw
chown "${TARGET_USER}:${TARGET_USER}" "${TARGET_HOME}/.my-claw" "${TARGET_HOME}/.config" \
  "${TARGET_HOME}/.config/systemd" "${TARGET_HOME}/.config/systemd/user"
chown -R "${TARGET_USER}:${TARGET_USER}" /var/log/my-claw

# Config and secrets live in the user's home, where the server reads them. 600: the config
# carries provider keys and every paired device's token, on a machine that runs an agent with
# a shell.
if [ ! -f "${TARGET_HOME}/.my-claw/config.json" ]; then
  cp "${PROJECT_DIR}/etc/config.json" "${TARGET_HOME}/.my-claw/config.json"
  echo "Installed config template to ${TARGET_HOME}/.my-claw/config.json"
fi
if [ ! -f "${TARGET_HOME}/.my-claw/.env" ]; then
  cp "${PROJECT_DIR}/etc/.env.example" "${TARGET_HOME}/.my-claw/.env"
  echo "Installed env template to ${TARGET_HOME}/.my-claw/.env"
fi
chmod 600 "${TARGET_HOME}/.my-claw/config.json" "${TARGET_HOME}/.my-claw/.env"
chown "${TARGET_USER}:${TARGET_USER}" "${TARGET_HOME}/.my-claw/config.json" "${TARGET_HOME}/.my-claw/.env"

# The tree: one release directory, `current` pointing at it. A reinstall of the same version
# replaces the directory; another version becomes current and the old one the rollback.
mkdir -p "${APP_DIR}/releases"
PREVIOUS=""
if [ -L "${APP_DIR}/current" ]; then
  PREVIOUS="$(readlink "${APP_DIR}/current")"
fi
rm -rf "${APP_DIR}/releases/${VERSION}" "${APP_DIR}"/releases/.staging-*
cp -a "$PROJECT_DIR" "${APP_DIR}/releases/.staging-$$"
mv "${APP_DIR}/releases/.staging-$$" "${APP_DIR}/releases/${VERSION}"
ln -sfn "releases/${VERSION}" "${APP_DIR}/current.tmp"
mv -T "${APP_DIR}/current.tmp" "${APP_DIR}/current"
if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "releases/${VERSION}" ] && [ -d "${APP_DIR}/${PREVIOUS}" ]; then
  ln -sfn "$PREVIOUS" "${APP_DIR}/prev.tmp"
  mv -T "${APP_DIR}/prev.tmp" "${APP_DIR}/prev"
fi
cat > "${APP_DIR}/.install-meta" <<EOF
USER=${TARGET_USER}
HOME=${TARGET_HOME}
APP_DIR=${APP_DIR}
EOF
chown -R "${TARGET_USER}:${TARGET_USER}" "$APP_DIR"

# The one file outside the user's ownership: a stub that forwards to the tree, dropping root
# to the service user first.
install -m 755 -o root -g root "${APP_DIR}/current/packaging/myclaw-stub.sh" /usr/local/bin/myclaw

# A hand-rolled login-session browser stack (~/.config/systemd/user/{xvfb,x11vnc,novnc,
# chromium-cdp}.service) squats :99, :5900 and :6080 and starves the units.
for unit in xvfb x11vnc novnc chromium-cdp; do
  [ -f "${TARGET_HOME}/.config/systemd/user/${unit}.service" ] || continue
  if runuser -u "${TARGET_USER}" -- env "XDG_RUNTIME_DIR=/run/user/${TARGET_UID}" \
    "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${TARGET_UID}/bus" \
    systemctl --user disable --now "${unit}.service" >/dev/null 2>&1; then
    echo "Disabled conflicting user unit: ${unit}.service"
  fi
done

# ---------------------------------------------------------------------------
# The user manager: started at boot without a login, and reachable now
# ---------------------------------------------------------------------------
loginctl enable-linger "$TARGET_USER"
for _ in $(seq 1 30); do
  [ -S "/run/user/${TARGET_UID}/bus" ] && break
  sleep 0.5
done
if [ ! -S "/run/user/${TARGET_UID}/bus" ]; then
  echo "Error: no session bus at /run/user/${TARGET_UID}/bus. Is dbus-user-session installed and systemd-logind running?"
  exit 1
fi

echo ""
echo "Activating as ${TARGET_USER}..."
runuser -u "$TARGET_USER" -- env "HOME=${TARGET_HOME}" "XDG_RUNTIME_DIR=/run/user/${TARGET_UID}" \
  "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${TARGET_UID}/bus" \
  "${APP_DIR}/current/packaging/update.sh" --activate

echo ""
echo "my-claw ${VERSION} installed for ${TARGET_USER}."
echo "Next steps (as ${TARGET_USER}, no sudo):"
echo "  1. Put your keys in ${TARGET_HOME}/.my-claw/.env (picked up live, no restart)"
echo "  2. Pair a device: myclaw device add"
echo "  3. Check: myclaw status"
echo ""
echo "Updates: myclaw update (the timer also checks every 15 minutes)"
