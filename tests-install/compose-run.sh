#!/bin/bash
# The compose install (docs/compose.md), built from this tree and checked as a new owner would use
# it: tests-install/compose-run.sh [--keep]. Ports 18080/16080/15900; `down -v` at the end.
set -euo pipefail
cd "$(dirname "$0")/.."
keep="${1:-}"
export MYCLAW_PORT=18080 VNC_WEB_PORT=16080 VNC_PORT=15900
C=(docker compose -p my-claw-compose-test -f packaging/compose/compose.yml)
machine=compose
fail() { echo "FAIL [$machine] $*"; exit 1; }
ok() { echo "ok   [$machine] $*"; }
in_claw() { "${C[@]}" exec -T my-claw sh -c "$1"; }
cleanup() { [ "$keep" = "--keep" ] || "${C[@]}" --profile whisper --profile searxng down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

"${C[@]}" up -d --build > /tmp/compose-up.log 2>&1 || { tail -20 /tmp/compose-up.log; fail "compose up"; }
for _ in $(seq 1 60); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/)" != "000" ] && break
  sleep 1
done
ok "my-claw and browser up"

# The first device, the compose way: the link names the published port, not the container's.
out="$(in_claw 'myclaw setup')" || fail "myclaw setup: $out"
echo "$out" | grep -q "http://localhost:18080/pair#" || fail "setup printed $(echo "$out" | grep '^Web')"
c="$(in_claw 'jq -r ".channels[\"my-claw-app\"].devices | to_entries[0] | \"\(.key) \(.value.token)\"" ~/.my-claw/config.json')"
[ "$(curl -fsS "http://127.0.0.1:18080/health?device=${c% *}&token=${c#* }")" = '{"activeRun":false}' ] || fail "/health"
ok "myclaw setup prints the published address; its device answers /health"

"${C[@]}" cp tests-install/ws-probe.ts my-claw:/tmp/ws-probe.ts >/dev/null
probe() { in_claw "bun /tmp/ws-probe.ts ${c% *} ${c#* } '$1' $2"; }
service() { echo "$1" | jq -r --arg id "$2" ".services[] | select(.id == \$id) | $3"; }

s="$(probe '{"type":"services.get"}' services.result)" || fail "services.get: $s"
[ "$(echo "$s" | jq -r .install)" = compose ] || fail "install kind"
[ "$(service "$s" browser .endpoint)" = http://browser:9223 ] || fail "browser endpoint $(service "$s" browser .endpoint)"
[ "$(service "$s" browser .health)" = up ] || fail "the browser does not answer"
[ "$(service "$s" stt .source)" = cloud ] || fail "stt not cloud by default"
echo "$s" | jq -e '.services[] | select(.id == "search") | .choices | index("self-hosted")' >/dev/null || fail "search cannot be self-hosted in compose"
ok "services.get: compose install, browser at browser:9223 and up, voice cloud"

nav="$(in_claw 'curl -fsS -X POST -H "content-type: application/json" -d "{\"url\":\"data:text/html,ok\"}" http://browser:9223/navigate')" || fail "navigate"
pid="$(echo "$nav" | jq -r .pageId)"
shot="$(in_claw "curl -fsS -X POST -H 'content-type: application/json' -d '{\"pageId\":\"$pid\"}' http://browser:9223/screenshot")"
in_claw "test -s $(echo "$shot" | jq -r .path)" || fail "the screenshot is not readable from my-claw"
in_claw 'DISPLAY=browser:99 xdotool search --onlyvisible --name . >/dev/null' || fail "xdotool cannot reach browser:99"
ok "browser driven from my-claw, screenshot shared, display reachable"

# Search self-hosted: the profile, then the choice from the app.
"${C[@]}" --profile searxng up -d searxng >/dev/null 2>&1
s="$(probe '{"type":"services.set","id":"search","source":"self-hosted"}' services.result)" || fail "services.set search: $s"
[ "$(service "$s" search .endpoint)" = http://searxng:8080 ] || fail "search endpoint"
for _ in $(seq 1 60); do
  in_claw 'curl -fsS "http://searxng:8080/search?q=bun&format=json" | jq -e ".results | length > 0" >/dev/null' 2>/dev/null && break
  sleep 2
done
in_claw 'curl -fsS "http://searxng:8080/search?q=bun&format=json" | jq -e ".results | length > 0" >/dev/null' || fail "searxng answers no JSON results"
ok "search set to this server from the app; SearXNG answers JSON"

# Local speech-to-text: the profile, then the choice; the server finds whisper:8000.
"${C[@]}" --profile whisper up -d --build whisper >/dev/null 2>&1 || fail "whisper profile"
s="$(probe '{"type":"services.set","id":"stt","source":"self-hosted"}' services.result)" || fail "services.set stt: $s"
[ "$(service "$s" stt .endpoint)" = http://whisper:8000 ] || fail "stt endpoint $(service "$s" stt .endpoint)"
for _ in $(seq 1 60); do
  in_claw 'curl -fsS http://whisper:8000/health >/dev/null' 2>/dev/null && break
  sleep 2
done
in_claw 'curl -fsS http://whisper:8000/health >/dev/null' || fail "whisper:8000 does not answer"
ok "speech-to-text set to this server; whisper:8000 answers"

# The app's update button answers with the host command, never starts anything.
up="$(probe '{"type":"update.run"}' update.result)" || fail "update.run: $up"
echo "$up" | jq -e '.started == false and (.detail | contains("docker compose"))' >/dev/null || fail "update.run answered $up"
ok "update from the app says to update from the host"

echo "PASS [$machine]"
