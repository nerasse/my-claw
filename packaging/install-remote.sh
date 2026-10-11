#!/bin/bash
set -euo pipefail

# Installs my-claw from its release source (docs/release-source.md), with a release key:
#   curl -fsSL -H "Authorization: Bearer <key>" https://dl.kssimi.fr/my-claw/install.sh | sudo bash
# Served by dl-hub, the script carries the source and the key it was fetched with (DL_HUB_URL and
# DL_HUB_KEY, written under the shebang). Options win over them: --key <key>, --url <release url>,
# --version <x.y.z> (default: latest); so do MY_CLAW_RELEASE_KEY and MY_CLAW_RELEASE_URL.
#
# Nothing but bash, curl and tar is assumed: jq and the rest come with install.sh.

RELEASE_URL="${MY_CLAW_RELEASE_URL:-${DL_HUB_URL:-https://dl.kssimi.fr/my-claw}}"
RELEASE_KEY="${MY_CLAW_RELEASE_KEY:-${DL_HUB_KEY:-}}"
VERSION="latest"

while [ $# -gt 0 ]; do
  case "$1" in
    --key) RELEASE_KEY="${2:-}"; shift 2 ;;
    --url) RELEASE_URL="${2:-}"; shift 2 ;;
    --version) VERSION="${2:-}"; shift 2 ;;
    *) echo "Error: unknown option $1" >&2; exit 1 ;;
  esac
done
RELEASE_URL="${RELEASE_URL%/}"

# The key reaches curl through a config on stdin, never its command line.
fetch() {
  if [ -n "$RELEASE_KEY" ]; then
    printf 'header = "Authorization: Bearer %s"\n' "$RELEASE_KEY" | curl -K - "$@"
  else
    curl "$@"
  fi
}

if [ "$VERSION" = "latest" ]; then
  echo "Fetching the latest version from ${RELEASE_URL}..."
  latest_json="$(fetch -fsS "${RELEASE_URL}/server/latest.json")" || {
    echo "Error: ${RELEASE_URL} refused the request. Check the release key (--key)." >&2
    exit 1
  }
  VERSION="$(printf '%s' "$latest_json" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([0-9]*\.[0-9]*\.[0-9]*\)".*/\1/p')"
  [ -n "$VERSION" ] || { echo "Error: could not read the latest version" >&2; exit 1; }
fi
echo "Version: ${VERSION}"

TAR_FILE="my-claw-${VERSION}-linux-x64.tar.gz"
TMP_DIR="$(mktemp -d /var/tmp/my-claw-install.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Downloading ${TAR_FILE}..."
fetch -fsSL "${RELEASE_URL}/server/${VERSION}/${TAR_FILE}" -o "${TMP_DIR}/${TAR_FILE}"

echo "Extracting..."
tar xzf "${TMP_DIR}/${TAR_FILE}" -C "${TMP_DIR}"

# install.sh writes the source into the service user's .env, so updates use it from then on.
export MY_CLAW_RELEASE_URL="$RELEASE_URL" MY_CLAW_RELEASE_KEY="$RELEASE_KEY"
cd "${TMP_DIR}/my-claw-${VERSION}-linux-x64"
if [ "$EUID" -ne 0 ]; then
  echo "Root required. Running with sudo..."
  sudo --preserve-env=MY_CLAW_RELEASE_URL,MY_CLAW_RELEASE_KEY ./packaging/install.sh
else
  ./packaging/install.sh
fi

echo ""
echo "Installed my-claw ${VERSION}"
