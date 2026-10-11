#!/bin/bash
# Where releases come from, for every shell updater: docs/release-source.md.
#
# Sourced, never executed. One source, set in ~/.my-claw/.env (`myclaw release-key` writes both):
#   MY_CLAW_RELEASE_URL (+ MY_CLAW_RELEASE_KEY)   the neutral layout dl-hub serves:
#                                                 <url>/server/latest.json, <url>/server/<v>/<tarball>,
#                                                 <url>/app/latest.json, <url>/app/<v>/dist-web.tar.gz
#
# The key never reaches a command line, where ps would show it: curl reads its header from a
# config on stdin.

MY_CLAW_RELEASE_URL="${MY_CLAW_RELEASE_URL:-}"
MY_CLAW_RELEASE_KEY="${MY_CLAW_RELEASE_KEY:-}"

# Reads the two names out of a .env file; quotes and surrounding spaces are dropped. A template
# placeholder (your_..._here) is no value, as for the server's own loader.
read_release_env() {
  local key value
  [ -f "$1" ] || return 0
  while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" =~ ^# ]] && continue
    value="$(echo "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | sed 's/^["\'"'"']//;s/["\'"'"']$//')"
    [[ "$value" =~ ^[Yy][Oo][Uu][Rr]_[A-Za-z0-9_]+_[Hh][Ee][Rr][Ee]$ ]] && continue
    case "$key" in
      MY_CLAW_RELEASE_URL) MY_CLAW_RELEASE_URL="${value%/}" ;;
      MY_CLAW_RELEASE_KEY) MY_CLAW_RELEASE_KEY="$value" ;;
    esac
  done < "$1"
}

release_configured() {
  [ -n "$MY_CLAW_RELEASE_URL" ]
}

release_describe() {
  if release_configured; then echo "$MY_CLAW_RELEASE_URL"; else echo "none"; fi
}

# curl, with the key when there is one.
release_curl() {
  if [ -n "$MY_CLAW_RELEASE_KEY" ]; then
    printf 'header = "Authorization: Bearer %s"\n' "$MY_CLAW_RELEASE_KEY" | curl -K - "$@"
  else
    curl "$@"
  fi
}

# The newest server version, or nothing.
release_latest_server() {
  release_curl -fsS --max-time 30 "${MY_CLAW_RELEASE_URL}/server/latest.json" 2>/dev/null \
    | jq -r '.version // empty' 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' || true
}

release_server_url() {
  echo "${MY_CLAW_RELEASE_URL}/server/$1/my-claw-$1-linux-x64.tar.gz"
}

# The newest app release as its tag (v0.6.1) when it carries a web bundle, or nothing. A release
# without one is an app-only release (an APK rebuild) and leaves the installed bundle where it is.
release_latest_web() {
  release_curl -fsS --max-time 30 "${MY_CLAW_RELEASE_URL}/app/latest.json" 2>/dev/null \
    | jq -r 'select([(.files // [])[].name] | index("dist-web.tar.gz")) | "v" + .version' 2>/dev/null || true
}
