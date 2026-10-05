#!/bin/bash
# One container, five processes: the display, the browser on it, the sidecar driving the browser,
# VNC and noVNC to watch it. Any of them dying ends the container, and compose restarts it whole:
# the same restart the bare-metal units get one by one. docs/compose.md
set -u
export DISPLAY=:99

# /tmp is shared with my-claw (screenshots): a lock left by the last run would stop Xvfb.
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
# TCP, without access control, on the compose network only (never published): my-claw's xdotool
# reaches the display at browser:99 to close a native dialog.
Xvfb :99 -screen 0 1920x1080x24 -listen tcp -ac -noreset &
for _ in $(seq 1 50); do [ -S /tmp/.X11-unix/X99 ] && break; sleep 0.1; done

profile="${HOME}/.config/chromium"
mkdir -p "$profile"
sh /app/packaging/chromium-prestart.sh "$profile"
# The flags of my-claw-chromium.service. --no-sandbox: Docker's default seccomp profile refuses the
# namespaces Chromium's own sandbox needs; the container is the boundary here.
chromium --user-data-dir="$profile" --restore-last-session --no-sandbox \
  --use-gl=angle --use-angle=swiftshader --disable-dev-shm-usage \
  --lang="${BROWSER_LANG:-fr-FR}" --accept-lang="${BROWSER_ACCEPT_LANG:-fr-FR,fr}" \
  --remote-debugging-port=9222 --window-size=1920,1080 &

# VNC takes over the browser and every session signed in it: a password, as on bare metal
# (update.sh), created once in the home volume my-claw shares, so the app's Browser page shows it.
pwfile="${HOME}/.vnc/passwd"
if [ ! -s "$pwfile" ]; then
  mkdir -p "${HOME}/.vnc" && chmod 700 "${HOME}/.vnc"
  x11vnc -storepasswd "$(head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-8)" "$pwfile" >/dev/null 2>&1
  chmod 600 "$pwfile"
fi
x11vnc -display :99 -rfbport 5900 -rfbauth "$pwfile" -forever -shared -noxdamage -noxkb -xkb -noxrecord -noxfixes -noxrandr -quiet &
websockify --web /usr/share/novnc 6080 localhost:5900 &
# Listening on the compose network: my-claw reaches it at browser:9223. Not published.
HOST=0.0.0.0 PORT=9223 CDP_URL=http://127.0.0.1:9222 node /app/sidecar/server.mjs &

wait -n
status=$?
echo "browser: a process exited ($status), stopping the container for compose to restart it" >&2
exit "$status"
