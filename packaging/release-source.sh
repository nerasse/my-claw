#!/bin/bash
# Where releases come from, for every shell updater: docs/release-source.md.
#
# Sourced, never executed. One source, set in ~/.my-claw/.env (`myclaw release-key` writes it):
#   MY_CLAW_RELEASE_URL      https://github.com/<owner>/my-claw  -> the newest release, assets
#                            from the release page (no key, no API, no rate limit)
#                            anything else                       -> the neutral layout a
#                            self-hosted hub serves (<url>/server/latest.json, /server/<v>/...)
#   MY_CLAW_RELEASE_KEY      only for the neutral layout, never sent to GitHub
#   MY_CLAW_APP_RELEASE_URL  optional, when the app repo is not <server>-app
#
# The key never reaches a command line, where ps would show it: curl reads its header from a
# config on stdin.

MY_CLAW_RELEASE_URL="${MY_CLAW_RELEASE_URL:-}"
MY_CLAW_RELEASE_KEY="${MY_CLAW_RELEASE_KEY:-}"
MY_CLAW_APP_RELEASE_URL="${MY_CLAW_APP_RELEASE_URL:-}"

DEFAULT_RELEASE_URL="https://github.com/nerasse/my-claw"
LEGACY_RELEASE_URL="https://dl.kssimi.fr/my-claw"

release_normalize() {
  MY_CLAW_RELEASE_URL="${MY_CLAW_RELEASE_URL%/}"
  MY_CLAW_APP_RELEASE_URL="${MY_CLAW_APP_RELEASE_URL%/}"
  # The old hub is the same source as the GitHub repository now. Mapping it here is what makes an
  # install that still carries it in .env start reading GitHub, without a write that could fail.
  if [ "$MY_CLAW_RELEASE_URL" = "$LEGACY_RELEASE_URL" ]; then
    MY_CLAW_RELEASE_URL="$DEFAULT_RELEASE_URL"
    MY_CLAW_RELEASE_KEY=""
  fi
}

release_is_github() {
  case "$MY_CLAW_RELEASE_URL" in
    https://github.com/*) return 0 ;;
    *) return 1 ;;
  esac
}

release_github_repo() {
  release_is_github || return 1
  printf '%s\n' "$MY_CLAW_RELEASE_URL"
}

release_app_repo() {
  if [ -n "$MY_CLAW_APP_RELEASE_URL" ]; then
    printf '%s\n' "$MY_CLAW_APP_RELEASE_URL"
    return 0
  fi
  local repo
  repo="$(release_github_repo)" || return 1
  printf '%s-app\n' "$repo"
}

# Reads the names out of a .env file; quotes and surrounding spaces are dropped. A template
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
      MY_CLAW_APP_RELEASE_URL) MY_CLAW_APP_RELEASE_URL="${value%/}" ;;
    esac
  done < "$1"
  release_normalize
}

release_normalize

release_configured() {
  [ -n "$MY_CLAW_RELEASE_URL" ]
}

release_describe() {
  if release_configured; then echo "$MY_CLAW_RELEASE_URL"; else echo "none"; fi
}

# curl, with the key only when the source is the layout it belongs to. A redirect on GitHub ends
# on release-assets.githubusercontent.com, and a bearer must never follow it there.
release_curl() {
  if release_is_github; then
    curl -L "$@"
    return
  fi
  if [ -n "$MY_CLAW_RELEASE_KEY" ]; then
    printf 'header = "Authorization: Bearer %s"\n' "$MY_CLAW_RELEASE_KEY" | curl -K - "$@"
  else
    curl "$@"
  fi
}

# The tag of the newest release, as the /releases/latest redirect spells it.
release_github_latest_tag() {
  local repo="$1"
  curl -fsSI --max-time 30 "${repo}/releases/latest" 2>/dev/null \
    | tr -d '\r' | awk 'tolower($1)=="location:" {print $2}' | tail -1 | sed 's|.*/||'
}

# The newest server version, or nothing.
release_latest_server() {
  if release_is_github; then
    local tag
    tag="$(release_github_latest_tag "$(release_github_repo)")"
    printf '%s\n' "${tag#v}" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' || true
    return 0
  fi
  release_curl -fsS --max-time 30 "${MY_CLAW_RELEASE_URL}/server/latest.json" 2>/dev/null \
    | jq -r '.version // empty' 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' || true
}

release_server_url() {
  if release_is_github; then
    printf '%s/releases/download/v%s/my-claw-%s-linux-x64.tar.gz\n' "$MY_CLAW_RELEASE_URL" "$1" "$1"
    return 0
  fi
  printf '%s/server/%s/my-claw-%s-linux-x64.tar.gz\n' "$MY_CLAW_RELEASE_URL" "$1" "$1"
}

# The newest app release as its tag (v0.6.1) when it carries a web bundle, or nothing. A release
# without one is an app-only release (an APK rebuild) and leaves the installed bundle where it is.
release_latest_web() {
  if release_is_github; then
    local repo tag version
    repo="$(release_app_repo)" || return 0
    tag="$(release_github_latest_tag "$repo")"
    version="${tag#v}"
    [ -n "$version" ] || return 0
    if curl -fsSLI --max-time 30 "${repo}/releases/download/v${version}/dist-web.tar.gz" >/dev/null 2>&1; then
      printf 'v%s\n' "$version"
    fi
    return 0
  fi
  release_curl -fsS --max-time 30 "${MY_CLAW_RELEASE_URL}/app/latest.json" 2>/dev/null \
    | jq -r 'select([(.files // [])[].name] | index("dist-web.tar.gz")) | "v" + .version' 2>/dev/null || true
}
