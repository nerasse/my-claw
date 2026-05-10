#!/bin/bash
set -euo pipefail

# Quick install script for my-claw from Forgejo Package Registry
# Usage: curl -fsSL https://git.kssimi.fr/claw/my-claw/raw/main/packaging/install-remote.sh | bash
# Or with token: FORGEJO_TOKEN=xxx bash install-remote.sh [version]

FORGEJO_URL="${FORGEJO_URL:-https://git.kssimi.fr}"
FORGEJO_TOKEN="${FORGEJO_TOKEN:-}"
OWNER="claw"
PACKAGE="my-claw"
VERSION="${1:-latest}"

if [ -z "$FORGEJO_TOKEN" ]; then
  echo "Error: FORGEJO_TOKEN is required."
  echo "Get one from ${FORGEJO_URL}/user/settings/applications"
  echo "Then run: FORGEJO_TOKEN=your_token bash install-remote.sh"
  exit 1
fi

if [ "$VERSION" = "latest" ]; then
  echo "Fetching latest version..."
  VERSION=$(curl -fsS -H "Authorization: token ${FORGEJO_TOKEN}" \
    "${FORGEJO_URL}/api/packages/${OWNER}/generic/${PACKAGE}" | \
    jq -r '.[] | select(.type == "generic") | .version' | \
    sort -V | tail -1)
  if [ -z "$VERSION" ] || [ "$VERSION" = "null" ]; then
    echo "Error: could not determine latest version"
    exit 1
  fi
  echo "Latest version: ${VERSION}"
fi

TAR_FILE="my-claw-${VERSION}-linux-x64.tar.gz"
URL="${FORGEJO_URL}/api/packages/${OWNER}/generic/${PACKAGE}/${VERSION}/${TAR_FILE}"
TMP_DIR="$(mktemp -d)"

echo "Downloading ${TAR_FILE}..."
curl -fsSL -H "Authorization: token ${FORGEJO_TOKEN}" "$URL" -o "${TMP_DIR}/${TAR_FILE}"

echo "Extracting..."
tar xzf "${TMP_DIR}/${TAR_FILE}" -C "${TMP_DIR}"

echo "Installing..."
cd "${TMP_DIR}/my-claw-${VERSION}-linux-x64"
if [ "$EUID" -ne 0 ]; then
  echo "Root required. Running with sudo..."
  sudo ./packaging/install.sh "$@"
else
  ./packaging/install.sh "$@"
fi

rm -rf "$TMP_DIR"

echo ""
echo "Installed my-claw ${VERSION}"
