#!/bin/bash
# Where releases come from, for every shell updater: docs/release-source.md.
#
# Sourced, never executed. One source, set in ~/.my-claw/.env:
#   MY_CLAW_RELEASE_URL (+ MY_CLAW_RELEASE_KEY)   the neutral layout dl-hub serves:
#                                                 <url>/server/latest.json, <url>/server/<v>/<tarball>,
#                                                 <url>/app/latest.json, <url>/app/<v>/dist-web.tar.gz
#   FORGEJO_URL + FORGEJO_TOKEN                   the forge itself, for the installs set up before
#                                                 keys existed; removed once none is left
#
# The credential never reaches a command line, where ps would show it: curl reads its header from
# a config on stdin.

MY_CLAW_RELEASE_URL="${MY_CLAW_RELEASE_URL:-}"
MY_CLAW_RELEASE_KEY="${MY_CLAW_RELEASE_KEY:-}"
FORGEJO_URL="${FORGEJO_URL:-}"
FORGEJO_TOKEN="${FORGEJO_TOKEN:-}"

# Reads the four names out of a .env file; quotes and surrounding spaces are dropped.
read_release_env() {
  local key value
  [ -f "$1" ] || return 0
  while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" =~ ^# ]] && continue
    value="$(echo "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | sed 's/^["\'"'"']//;s/["\'"'"']$//')"
    case "$key" in
      MY_CLAW_RELEASE_URL) MY_CLAW_RELEASE_URL="${value%/}" ;;
      MY_CLAW_RELEASE_KEY) MY_CLAW_RELEASE_KEY="$value" ;;
      FORGEJO_URL) FORGEJO_URL="${value%/}" ;;
      FORGEJO_TOKEN) FORGEJO_TOKEN="$value" ;;
    esac
  done < "$1"
}

# "hub", "forge", or nothing when no source is set.
release_kind() {
  if [ -n "$MY_CLAW_RELEASE_URL" ]; then
    echo hub
  elif [ -n "$FORGEJO_URL" ] && [ -n "$FORGEJO_TOKEN" ]; then
    echo forge
  fi
}

release_configured() {
  [ -n "$(release_kind)" ]
}

release_describe() {
  case "$(release_kind)" in
    hub) echo "${MY_CLAW_RELEASE_URL}" ;;
    forge) echo "${FORGEJO_URL} (direct, no release key yet)" ;;
    *) echo "none" ;;
  esac
}

# curl, with the source's credential when it has one.
release_curl() {
  case "$(release_kind)" in
    hub)
      if [ -n "$MY_CLAW_RELEASE_KEY" ]; then
        printf 'header = "Authorization: Bearer %s"\n' "$MY_CLAW_RELEASE_KEY" | curl -K - "$@"
      else
        curl "$@"
      fi
      ;;
    forge) printf 'header = "Authorization: token %s"\n' "$FORGEJO_TOKEN" | curl -K - "$@" ;;
    *) return 1 ;;
  esac
}

# The newest server version, or nothing.
release_latest_server() {
  case "$(release_kind)" in
    hub)
      release_curl -fsS --max-time 30 "${MY_CLAW_RELEASE_URL}/server/latest.json" 2>/dev/null \
        | jq -r '.version // empty' 2>/dev/null || true
      ;;
    forge)
      release_curl -fsS --max-time 30 -H "Accept: application/json" \
        "${FORGEJO_URL}/api/v1/packages/claw?type=generic&q=my-claw&limit=50" 2>/dev/null \
        | jq -r '.[] | select(.name == "my-claw" and .type == "generic") | .version' 2>/dev/null \
        | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1 || true
      ;;
  esac
}

release_server_url() {
  local version="$1" file="my-claw-$1-linux-x64.tar.gz"
  case "$(release_kind)" in
    hub) echo "${MY_CLAW_RELEASE_URL}/server/${version}/${file}" ;;
    forge) echo "${FORGEJO_URL}/api/packages/claw/generic/my-claw/${version}/${file}" ;;
  esac
}

# The newest app release carrying a web bundle, as its tag (v0.6.1), or nothing. A release without
# one is an app-only release (an APK rebuild) and leaves the installed bundle where it is.
release_latest_web() {
  case "$(release_kind)" in
    hub)
      release_curl -fsS --max-time 30 "${MY_CLAW_RELEASE_URL}/app/latest.json" 2>/dev/null \
        | jq -r 'select([(.files // [])[].name] | index("dist-web.tar.gz")) | "v" + .version' 2>/dev/null || true
      ;;
    forge)
      release_curl -fsS --max-time 30 -H "Accept: application/json" \
        "${FORGEJO_URL}/api/v1/repos/claw/my-claw-app/releases?limit=20" 2>/dev/null \
        | jq -r '.[] | select(.draft == false and .prerelease == false)
                     | select([(.assets // [])[].name] | index("dist-web.tar.gz"))
                     | .tag_name' 2>/dev/null | sort -V | tail -1 || true
      ;;
  esac
}

# The installs set up before keys existed trade their forge token for a release key, on their own:
# the hub checks the token with the forge and answers a key (dl-hub, /<product>/key/exchange).
# Only the forge the hub fronts ever sends its token there: a fork's token never leaves for it.
RELEASE_HUB_URL="${MY_CLAW_HUB_URL:-https://dl.kssimi.fr/my-claw}"
RELEASE_HUB_FORGE="${MY_CLAW_HUB_FORGE:-https://git.kssimi.fr}"

# Writes the two lines into an .env in place, every other line kept. mktemp makes the file 600.
release_write_env() {
  local file="$1" url="$2" key="$3" tmp
  tmp="$(mktemp "${file}.XXXXXX")" || return 1
  {
    grep -Ev '^(MY_CLAW_RELEASE_URL|MY_CLAW_RELEASE_KEY)=' "$file" || true
    printf 'MY_CLAW_RELEASE_URL=%s\nMY_CLAW_RELEASE_KEY=%s\n' "$url" "$key"
  } > "$tmp" && mv "$tmp" "$file" || { rm -f "$tmp"; return 1; }
}

# 0 when this install has just been given a key (written into <env file> and in effect for the rest
# of the run), 1 when nothing changed: not a forge install, another forge, or the hub said no. The
# next run asks again; FORGEJO_TOKEN stays where it is.
release_migrate() {
  local file="$1" answer key
  [ "$(release_kind)" = forge ] || return 1
  [ "${FORGEJO_URL%/}" = "${RELEASE_HUB_FORGE%/}" ] || return 1
  [ -f "$file" ] && [ -w "$file" ] || return 1
  answer="$(release_curl -fsS --max-time 30 -X POST \
    --data-urlencode "machine=$(hostname 2>/dev/null || echo unknown)" \
    "${RELEASE_HUB_URL%/}/key/exchange" 2>/dev/null)" || return 1
  key="$(printf '%s' "$answer" | jq -r '.key // empty' 2>/dev/null || true)"
  [[ "$key" =~ ^dlh_[A-Za-z0-9_-]+$ ]] || return 1
  release_write_env "$file" "${RELEASE_HUB_URL%/}" "$key" || return 1
  MY_CLAW_RELEASE_URL="${RELEASE_HUB_URL%/}"
  MY_CLAW_RELEASE_KEY="$key"
}
