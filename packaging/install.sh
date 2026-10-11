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
# Read without jq: on a fresh machine it is one of the packages this script is about to install.
VERSION="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "${PROJECT_DIR}/package.json" | head -1)"
if [ -z "$VERSION" ]; then
  echo "Error: cannot read the version from ${PROJECT_DIR}/package.json"
  exit 1
fi

echo "Installing my-claw ${VERSION} for user: ${TARGET_USER}"
echo "Home directory: ${TARGET_HOME}"

# ---------------------------------------------------------------------------
# System packages and runtimes: everything my-claw runs on, installed here, so a fresh VM needs
# nothing but this script (docs/setup-guide.md). Each step is skipped when already satisfied.
# ---------------------------------------------------------------------------
# Pinned: the versions CI and the compose images run.
BUN_VERSION="1.3.13"
NODE_VERSION="22.22.2"
NODE_SHA256="88fd1ce767091fd8d4a99fdb2356e98c819f93f3b1f8663853a2dee9b438068a"
# bun-linux-x64.zip needs AVX2; the baseline build runs on any x86_64. Both checked.
BUN_SHA256_X64="79c0771fa8b92c33aae41e15a0e0d307ea99d0e2f00317c71c6c53237a78e25a"
BUN_SHA256_BASELINE="9d8a24292a7068090205daac0a5a223f5f69736f5287e37bf88d3b4031edc750"
EDGE_TTS_VERSION="7.2.8"
# Chrome for Testing goes here when the distribution has no Chromium package (Ubuntu ships it
# only as a snap, which a systemd user unit cannot drive). Root-owned, outside /opt/my-claw, which
# belongs to the service user: /usr/bin/chromium must not point at a file the agent can rewrite.
CFT_DIR="/opt/my-claw-chromium"

if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  # novnc: the pages under /usr/share/novnc the noVNC unit serves. xdotool: unsticks a native dialog
  # on the browser's display. python3-venv: edge-tts and, when asked for, the local engines.
  APT_PACKAGES="jq curl ca-certificates unzip xz-utils procps ffmpeg xvfb x11vnc novnc websockify xdotool dbus-user-session python3 python3-venv fonts-liberation fonts-noto-color-emoji"
  # Captured, not piped into grep -q: grep exits at the first match, apt-cache takes a SIGPIPE, and
  # under pipefail the test reads false -- every Debian box got Chrome for Testing that way.
  chromium_policy="$(apt-cache policy chromium 2>/dev/null || true)"
  if [[ "$chromium_policy" == *"Candidate: "[0-9]* ]]; then
    APT_PACKAGES="${APT_PACKAGES} chromium"
  fi
  # shellcheck disable=SC2086
  apt-get install -y -qq --no-install-recommends $APT_PACKAGES
elif command -v pacman >/dev/null 2>&1; then
  pacman -S --needed --noconfirm jq curl unzip xz ffmpeg chromium xorg-server-xvfb x11vnc novnc python-websockify xdotool python
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y jq curl unzip xz ffmpeg chromium Xvfb x11vnc novnc python3-websockify xdotool python3
else
  echo "Warning: no apt, pacman or dnf. Install by hand: jq curl unzip ffmpeg chromium Xvfb x11vnc novnc websockify xdotool python3, and the systemd user session bus"
fi

# Node >= 20 runs the browser sidecar (playwright-core asks for it). Debian 12 ships 18: the
# official LTS build goes under /usr/local, checksum verified, when the machine has nothing newer.
node_ok() {
  "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' >/dev/null 2>&1
}
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ] || ! node_ok "$NODE_BIN"; then
  echo "Installing Node.js ${NODE_VERSION} under /usr/local..."
  node_tar="$(mktemp -d)/node.tar.xz"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o "$node_tar"
  echo "${NODE_SHA256}  ${node_tar}" | sha256sum -c --quiet
  rm -rf /usr/local/lib/my-claw-node
  mkdir -p /usr/local/lib/my-claw-node
  tar -xJf "$node_tar" -C /usr/local/lib/my-claw-node --strip-components=1
  rm -rf "$(dirname "$node_tar")"
  for bin in node npm npx; do ln -sfn "/usr/local/lib/my-claw-node/bin/${bin}" "/usr/local/bin/${bin}"; done
  NODE_BIN="/usr/local/bin/node"
fi

# Chromium: the package where there is one; otherwise Chrome for Testing, at the revision the
# sidecar's playwright-core was built against, with the libraries it needs.
if ! command -v chromium >/dev/null 2>&1; then
  echo "No Chromium package here: installing Chrome for Testing in ${CFT_DIR}..."
  PLAYWRIGHT_BROWSERS_PATH="$CFT_DIR" "$NODE_BIN" "${PROJECT_DIR}/node_modules/playwright-core/cli.js" install --with-deps chromium
  chrome="$(ls -1d "${CFT_DIR}"/chromium-[0-9]*/chrome-linux*/chrome 2>/dev/null | sort -V | tail -1)"
  [ -n "$chrome" ] || { echo "Error: Chrome for Testing did not install"; exit 1; }
  ln -sfn "$chrome" /usr/bin/chromium
fi

as_user() {
  runuser -u "$TARGET_USER" -- env "HOME=${TARGET_HOME}" "$@"
}

# Bun, the server's runtime, in the service user's home (where update.sh looks for it).
if ! command -v bun >/dev/null 2>&1 && [ ! -x "${TARGET_HOME}/.bun/bin/bun" ]; then
  echo "Installing Bun ${BUN_VERSION} for ${TARGET_USER}..."
  # The release zip, checksum verified, rather than a piped install script.
  bun_build="bun-linux-x64"
  bun_sha="$BUN_SHA256_X64"
  if ! grep -qw avx2 /proc/cpuinfo; then
    bun_build="bun-linux-x64-baseline"
    bun_sha="$BUN_SHA256_BASELINE"
  fi
  bun_tmp="$(mktemp -d)"
  curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${bun_build}.zip" -o "${bun_tmp}/bun.zip"
  echo "${bun_sha}  ${bun_tmp}/bun.zip" | sha256sum -c --quiet
  unzip -q "${bun_tmp}/bun.zip" -d "$bun_tmp"
  install -d -o "$TARGET_USER" -g "$TARGET_USER" "${TARGET_HOME}/.bun" "${TARGET_HOME}/.bun/bin"
  install -m 755 -o "$TARGET_USER" -g "$TARGET_USER" "${bun_tmp}/${bun_build}/bun" "${TARGET_HOME}/.bun/bin/bun"
  rm -rf "$bun_tmp"
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
# The release source install-remote.sh came from: written once, so updates use it from then on.
# docs/release-source.md
if [ -n "${MY_CLAW_RELEASE_URL:-}" ]; then
  for name in MY_CLAW_RELEASE_URL MY_CLAW_RELEASE_KEY; do
    sed -i "/^${name}=/d" "${TARGET_HOME}/.my-claw/.env"
    if [ -n "${!name:-}" ]; then
      printf '%s=%s\n' "$name" "${!name}" >> "${TARGET_HOME}/.my-claw/.env"
    fi
  done
  echo "Release source: ${MY_CLAW_RELEASE_URL}"
fi
chmod 600 "${TARGET_HOME}/.my-claw/config.json" "${TARGET_HOME}/.my-claw/.env"
chown "${TARGET_USER}:${TARGET_USER}" "${TARGET_HOME}/.my-claw/config.json" "${TARGET_HOME}/.my-claw/.env"

# edge-tts, the default (cloud) text-to-speech, in a venv the server's unit puts on its PATH.
if [ ! -x "${TARGET_HOME}/.my-claw/runtime/venv/bin/edge-tts" ]; then
  echo "Installing edge-tts for ${TARGET_USER}..."
  as_user python3 -m venv "${TARGET_HOME}/.my-claw/runtime/venv"
  as_user "${TARGET_HOME}/.my-claw/runtime/venv/bin/pip" install -q "edge-tts==${EDGE_TTS_VERSION}"
fi

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
# The first device, without knowing the device commands: a code, a link, a QR (docs/setup-guide.md).
PORT="$(jq -r '.channels["my-claw-app"].port // 8080' "${TARGET_HOME}/.my-claw/config.json" 2>/dev/null || echo 8080)"
HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
PUBLIC_URL="${MYCLAW_PUBLIC_URL:-http://${HOST_IP:-127.0.0.1}:${PORT}}"

echo "my-claw ${VERSION} installed for ${TARGET_USER}."
echo ""
/usr/local/bin/myclaw setup --url "$PUBLIC_URL" || echo "No pairing code yet: run 'myclaw setup' once my-claw is up (myclaw status)."
echo ""
echo "Behind a reverse proxy or a domain: myclaw setup --url https://claw.example.com"
echo "Open the link: the app walks you through the rest (model, voice, services)."
echo "Updates: automatic (every 15 minutes), or myclaw update"
