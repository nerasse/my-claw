#!/bin/bash
# Installs the tarball built from this tree on a fresh machine and checks what a new owner gets:
#   tests-install/run.sh debian12|ubuntu2404 [--keep]
# Build the tarball first: packaging/build-tar.sh. docs/install-test.md
set -euo pipefail
cd "$(dirname "$0")"
machine="${1:?usage: run.sh debian12|ubuntu2404 [--keep]}"
keep="${2:-}"
C=(docker compose -f compose.yml)
tarball="$(ls -1t ../dist/my-claw-*-linux-x64.tar.gz 2>/dev/null | head -1)"
[ -n "$tarball" ] || { echo "no tarball in dist/: run packaging/build-tar.sh"; exit 1; }
name="$(basename "$tarball" .tar.gz)"

fail() { echo "FAIL [$machine] $*"; exit 1; }
ok() { echo "ok   [$machine] $*"; }
on() { "${C[@]}" exec -T "$machine" bash -c "$1"; }
# The service user's shell, with its systemd manager reachable.
as_claw() { "${C[@]}" exec -T -u claw -e XDG_RUNTIME_DIR=/run/user/1000 "$machine" bash -lc "$1"; }

cleanup() { [ "$keep" = "--keep" ] || "${C[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

"${C[@]}" up -d --build "$machine" >/dev/null
for _ in $(seq 1 60); do
  state="$(on 'systemctl is-system-running 2>/dev/null' || true)"
  case "$state" in running|degraded) break ;; esac
  sleep 1
done
ok "systemd is up ($state)"

# 1. The install, one command, as root on a machine with nothing on it.
on "rm -rf /root/x && mkdir /root/x && tar -xzf /dist/${name}.tar.gz -C /root/x" || fail "extract"
on "cd /root/x/${name} && ./packaging/install.sh --user claw" > "/tmp/install-${machine}.log" 2>&1 \
  || { tail -40 "/tmp/install-${machine}.log"; fail "install.sh"; }
ok "install.sh ($(wc -l < "/tmp/install-${machine}.log") lines of output)"

# 2. What runs, and what does not.
for unit in my-claw my-claw-xvfb my-claw-chromium my-claw-browser-sidecar my-claw-vnc my-claw-novnc; do
  [ "$(as_claw "systemctl --user is-active ${unit}.service" || true)" = "active" ] || fail "${unit} is not active"
done
ok "server, display, browser, sidecar, VNC, noVNC active"
[ "$(as_claw 'systemctl --user is-enabled my-claw-whisper.service' || true)" != "enabled" ] || fail "whisper enabled on a fresh install"
[ "$(as_claw 'systemctl --user is-active my-claw-whisper.service' || true)" != "active" ] || fail "whisper running on a fresh install"
ok "local Whisper neither enabled nor running"
as_claw 'edge-tts --help >/dev/null 2>&1 || ~/.my-claw/runtime/venv/bin/edge-tts --help >/dev/null' || fail "edge-tts missing"
ok "edge-tts installed"

# 3. The first device: the installer printed a code, and the device it is for answers /health.
grep -q "^Code " "/tmp/install-${machine}.log" || fail "no pairing code printed"
grep -q "/pair#" "/tmp/install-${machine}.log" || fail "no pairing link printed"
health="$(as_claw 'd=$(jq -r ".channels[\"my-claw-app\"].devices | to_entries[0] | \"\(.key) \(.value.token)\"" ~/.my-claw/config.json); curl -fsS "http://127.0.0.1:8080/health?device=${d% *}&token=${d#* }"')" || fail "/health"
[ "$health" = '{"activeRun":false}' ] || fail "/health answered $health"
ok "pairing code printed, its device answers /health"

# 4. The browser, driven through the sidecar.
nav="$(as_claw 'curl -fsS -X POST -H "content-type: application/json" -d "{\"url\":\"data:text/html,<title>claw</title>ok\"}" http://127.0.0.1:9223/navigate')" || fail "sidecar navigate"
echo "$nav" | grep -q '"pageId"' || fail "sidecar navigate answered $nav"
ok "the sidecar drives Chromium"

# 5. Local voice on demand: switching speech-to-text to local enables Whisper, back to cloud stops it.
set_stt() { as_claw "tmp=\$(mktemp) && jq '.voice.stt.mode = \"$1\"' ~/.my-claw/config.json > \$tmp && cat \$tmp > ~/.my-claw/config.json && rm \$tmp"; }
wait_enabled() {
  # Up to five minutes: the first switch to local installs faster-whisper before starting the unit.
  for _ in $(seq 1 300); do
    [ "$(as_claw 'systemctl --user is-enabled my-claw-whisper.service' || true)" = "$1" ] && return 0
    sleep 1
  done
  return 1
}
set_stt local && wait_enabled enabled || fail "whisper not enabled after switching to local"
as_claw 'test -x ~/.my-claw/runtime/whisper/bin/python' || fail "faster-whisper was not installed into its venv"
answered=""
for _ in $(seq 1 60); do
  answered="$(as_claw 'curl -fsS http://127.0.0.1:8000/health' 2>/dev/null || true)"
  [ -n "$answered" ] && break
  sleep 1
done
[ -n "$answered" ] || fail "local Whisper does not answer on :8000"
ok "switching to local installed faster-whisper, then started Whisper ($answered)"
set_stt cloud && wait_enabled disabled || fail "whisper not disabled after switching back to cloud"
ok "Whisper follows the speech-to-text mode"

# 6. An update: the same tarball, forced, through the real updater (swap, units, health gate).
as_claw "myclaw update --file /dist/${name}.tar.gz --force" > "/tmp/update-${machine}.log" 2>&1 \
  || { tail -30 "/tmp/update-${machine}.log"; fail "myclaw update"; }
[ "$(as_claw 'systemctl --user is-active my-claw.service' || true)" = "active" ] || fail "my-claw down after the update"
[ "$(as_claw 'systemctl --user is-enabled my-claw-whisper.service' || true)" != "enabled" ] || fail "the update enabled whisper"
ok "update applied, server up, whisper still off"

echo "PASS [$machine]"
