#!/bin/bash
# The web client bundle, for whoever is updating this machine.
#
# Sourced, never executed: both updaters need the same steps, and a second copy of them is how
# the timer and the manual command start disagreeing about what "up to date" means.
#   - packaging/auto-update.sh, once the server is already current
#   - packaging/update.sh, after a successful server update and after the health check
#
# The caller must have TARGET_HOME set and the release source read (packaging/release-source.sh,
# sourced below; its variables come from the caller's environment or read_release_env).
# WEB_LOG_PREFIX names who is talking in the journal, and defaults to something true either way.
#
# Nothing here is allowed to fail the caller. The manual updater rolls the server back on any
# non-zero exit, and a bundle that could not be downloaded is not a reason to undo a good server
# update: every path returns 0 and says what happened.
#
# No health gate on this half, on purpose: the server resolves the bundle directory per request,
# so installing one is a download and a symlink flip. There is no swap window to protect, and
# `myclaw web use <version>` is the rollback.

# shellcheck source=/dev/null
. "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/release-source.sh"

WEB_KEEP="${WEB_KEEP:-3}"
MYCLAW_BIN="${MYCLAW_BIN:-/usr/local/bin/myclaw}"

# Deletes the oldest bundles once more than WEB_KEEP are installed. `myclaw web rm` is what does
# it, because it refuses to delete the one `current` points at; the version just installed is
# skipped outright so a stale symlink can never turn retention into a 404.
prune_web_bundles() {
  local web_dir="$1" keep="$2"
  local prefix="${WEB_LOG_PREFIX:-my-claw update}"
  local versions=()
  while IFS= read -r name; do
    [ -n "$name" ] && versions+=("$name")
  done < <(find "$web_dir" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | grep -v '^\.' | sort -V)

  local drop=$(( ${#versions[@]} - WEB_KEEP ))
  [ "$drop" -gt 0 ] || return 0
  for version in "${versions[@]}"; do
    [ "$drop" -gt 0 ] || break
    [ "$version" = "$keep" ] && continue
    local removed=""
    if removed="$("$MYCLAW_BIN" web rm "$version" 2>&1)"; then
      echo "${prefix}: pruned web bundle ${version}"
    else
      echo "Warning: could not prune web bundle ${version}: ${removed}"
    fi
    drop=$(( drop - 1 ))
  done
}

update_web_bundle() {
  local prefix="${WEB_LOG_PREFIX:-my-claw update}"
  local config_file="${TARGET_HOME}/.my-claw/config.json"
  local web_dir="${TARGET_HOME}/.my-claw/web"

  [ -f "$config_file" ] || return 0
  [ -x "$MYCLAW_BIN" ] || return 0
  local enabled
  enabled="$(jq -r '.channels["my-claw-app"].web.enabled // false' "$config_file" 2>/dev/null || echo false)"
  [ "$enabled" = "true" ] || return 0

  local current=""
  if [ -L "${web_dir}/current" ]; then
    current="$(basename "$(readlink "${web_dir}/current")")"
  fi

  # A release with no dist-web.tar.gz is an app-only release (an APK rebuild): skipping it is
  # what stops the bundle from chasing a tag that has nothing to install.
  local latest
  latest="$(release_latest_web)"
  if [ -z "$latest" ]; then
    echo "Warning: could not resolve the latest web bundle — leaving ${current:-none} in place"
    return 0
  fi

  if [ "$current" = "$latest" ]; then
    echo "${prefix}: web bundle up to date (${current})"
    return 0
  fi

  echo "${prefix}: installing web bundle ${latest} (current ${current:-none})..."
  # myclaw drops to the service user by itself, and the CLI reads the token out of that user's
  # own .env: no credential ever reaches a command line, where ps would show it.
  #
  # Its output is captured and re-emitted rather than inherited: the drop goes through `su`,
  # pam_systemd moves the child into its own login session scope, and everything it prints is
  # journalled under that scope instead of this unit. A failure would otherwise read as
  # "failed to install" with the reason filed somewhere nobody looks.
  local output=""
  if ! output="$("$MYCLAW_BIN" web install "$latest" 2>&1)"; then
    echo "Warning: web bundle ${latest} failed to install — leaving ${current:-none} in place"
    [ -n "$output" ] && echo "$output"
    return 0
  fi
  [ -n "$output" ] && echo "$output"

  prune_web_bundles "$web_dir" "$latest"
  return 0
}

# One entry point for a caller that only knows it wants the bundle current: finds the helper's
# own directory-independent state, runs the update in a subshell with `set -e` off, and can
# never take the caller down with it.
web_bundle_step() {
  ( set +e; update_web_bundle ) || true
  return 0
}
