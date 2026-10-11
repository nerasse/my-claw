#!/bin/sh
# First start: the templates, pointed at the compose neighbours. Every start: the web bundle, from
# the release source when one is set (docs/release-source.md). Then the server. docs/compose.md
set -eu
data="${HOME}/.my-claw"
mkdir -p "$data"

if [ ! -f "${data}/config.json" ]; then
  # Written into the file, not derived: what the server talks to is visible where it is changed.
  jq --arg novnc "${MYCLAW_NOVNC_URL:-http://localhost:6080/vnc.html?autoconnect=1}" '
      .browser.sidecarUrl = "http://browser:9223"
    | .browser.display = "browser:99"
    | .browser.novncUrl = $novnc
    | .browser.units = []' /app/etc/config.json > "${data}/config.json"
  chmod 600 "${data}/config.json"
  echo "my-claw: wrote ${data}/config.json for the compose install"
fi
if [ ! -f "${data}/.env" ]; then
  cp /app/etc/.env.example "${data}/.env"
  chmod 600 "${data}/.env"
fi

# The helpers are bash; this entrypoint is sh, so they run in a bash of their own.
code=0
TARGET_HOME="$HOME" MYCLAW_BIN=/usr/local/bin/myclaw WEB_LOG_PREFIX="my-claw" bash -c '
  . /app/packaging/release-source.sh
  read_release_env "${TARGET_HOME}/.my-claw/.env"
  release_configured || exit 3
  . /app/packaging/web-bundle.sh
  web_bundle_step' || code=$?
if [ "$code" = 3 ]; then
  echo "my-claw: no release source in ${data}/.env (myclaw release-key <key>), the web client is not installed (the app still connects)"
fi

exec bun run /app/src/index.ts
