#!/bin/sh
# Run by my-claw-chromium.service before Chromium starts (docs/browser.md).
#
# 1. A Chromium still on the CDP port that the unit does not manage is stale: it would hold the
#    port and the profile lock, and the unit's own browser could not start.
# 2. A browser that went down hard (a kill, a crash, the machine) leaves its profile marked
#    "Crashed", and Chromium then ignores --restore-last-session: it opens a blank page and the
#    windows the agents and the owner had open are gone. Marking the exit clean first is what makes
#    the restore happen after a hard stop too (measured on Chromium 147: without it, a kill -9 lost
#    every tab; with it, they all came back). Chromium is not running at this point, so nothing
#    else is writing the file.
set -u
profile="${1:?usage: chromium-prestart.sh <user-data-dir>}"
# Overridable for the tests only, which must never be able to reach the machine's real browser.
unit="${MY_CLAW_CHROMIUM_UNIT:-my-claw-chromium.service}"
port="${MY_CLAW_CDP_PORT:-9222}"

# Only ever useful while the unit starts (it is "activating" then). Run by hand next to a browser
# the unit is running, the kill below would take that browser down with every tab in it -- which
# is exactly what happened the one time it was run by hand (2026-09-27). So it refuses.
if [ "$(systemctl --user is-active "$unit" 2>/dev/null)" = "active" ]; then
  echo "${unit} is running: nothing to prepare, and nothing is killed." >&2
  exit 0
fi

for pid in $(pgrep -u "$(id -un)" -f "chromium.*--remote-debugging-port=${port}( |\$)" 2>/dev/null || true); do
  kill -9 "$pid" 2>/dev/null || true
done

prefs="${profile}/Default/Preferences"
if [ -f "$prefs" ]; then
  sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/' "$prefs" || true
fi
exit 0
