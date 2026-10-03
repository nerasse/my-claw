#!/bin/sh
# First start: the templates, pointed at the compose neighbours. Every start: the web bundle, from
# the forge when a token is there. Then the server. docs/compose.md
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

env_value() {
  sed -n "s/^$1=//p" "${data}/.env" | tail -1
}
FORGEJO_URL="$(env_value FORGEJO_URL)"
FORGEJO_TOKEN="$(env_value FORGEJO_TOKEN)"
if [ -n "$FORGEJO_URL" ] && [ -n "$FORGEJO_TOKEN" ]; then
  export TARGET_HOME="$HOME" FORGEJO_URL FORGEJO_TOKEN MYCLAW_BIN=/usr/local/bin/myclaw WEB_LOG_PREFIX="my-claw"
  # shellcheck source=/dev/null
  . /app/packaging/web-bundle.sh
  web_bundle_step
else
  echo "my-claw: no FORGEJO_TOKEN in ${data}/.env, the web client is not installed (the app still connects)"
fi

exec bun run /app/src/index.ts
