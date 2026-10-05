#!/bin/bash
# Installs the tarball built from this tree on a fresh machine and checks what a new owner gets:
#   tests-install/run.sh debian12|ubuntu2404 [--keep]
# Build the tarball first: packaging/build-tar.sh. docs/install-test.md
set -euo pipefail
cd "$(dirname "$0")"
machine="${1:?usage: run.sh debian12|ubuntu2404 [--keep]}"
keep="${2:-}"
# shellcheck source=tests-install/lib.sh
. ./lib.sh
tarball="$(ls -1t ../dist/my-claw-*-linux-x64.tar.gz 2>/dev/null | head -1)"
[ -n "$tarball" ] || { echo "no tarball in dist/: run packaging/build-tar.sh"; exit 1; }
trap cleanup EXIT
boot_machine

# 1. The install, one command, as root on a machine with nothing on it.
install_tarball "/dist/$(basename "$tarball")" "/var/tmp/install-${machine}.log"
ok "install.sh ($(wc -l < "/var/tmp/install-${machine}.log") lines of output)"

# 2. What runs, and what does not.
for unit in my-claw my-claw-xvfb my-claw-chromium my-claw-browser-sidecar my-claw-vnc my-claw-novnc; do
  [ "$(unit_state active "$unit")" = "active" ] || fail "${unit} is not active"
done
ok "server, display, browser, sidecar, VNC, noVNC active"
[ "$(unit_state enabled my-claw-whisper)" != "enabled" ] || fail "whisper enabled on a fresh install"
[ "$(unit_state active my-claw-whisper)" != "active" ] || fail "whisper running on a fresh install"
ok "local Whisper neither enabled nor running"
as_claw 'edge-tts --help >/dev/null 2>&1 || ~/.my-claw/runtime/venv/bin/edge-tts --help >/dev/null' || fail "edge-tts missing"
ok "edge-tts installed"

# VNC drives the browser and every session signed in it: a password, created at install.
as_claw 'test -s ~/.vnc/passwd' || fail "no VNC password created"
types="$(as_claw "python3 -c 'import socket;s=socket.create_connection((\"127.0.0.1\",5900),5);s.recv(12);s.sendall(b\"RFB 003.008\\n\");n=s.recv(1)[0];print(list(s.recv(n)))'")" || fail "VNC handshake"
[ "$types" = "[2]" ] || fail "VNC offers security types $types, not password only"
ok "VNC asks for a password (security types $types)"

# 3. The first device: the installer printed a code, and the device it is for answers /health.
grep -q "^Code " "/var/tmp/install-${machine}.log" || fail "no pairing code printed"
grep -q "/pair#" "/var/tmp/install-${machine}.log" || fail "no pairing link printed"
c="$(creds)"
health="$(as_claw "curl -fsS 'http://127.0.0.1:8080/health?device=${c% *}&token=${c#* }'")" || fail "/health"
[ "$health" = '{"activeRun":false}' ] || fail "/health answered $health"
ok "pairing code printed, its device answers /health"

# 4. The browser, driven through the sidecar.
nav="$(as_claw 'curl -fsS -X POST -H "content-type: application/json" -d "{\"url\":\"data:text/html,<title>claw</title>ok\"}" http://127.0.0.1:9223/navigate')" || fail "sidecar navigate"
echo "$nav" | grep -q '"pageId"' || fail "sidecar navigate answered $nav"
ok "the sidecar drives Chromium"

# 5. The Services page, through the app's socket: the defaults of a fresh install.
s="$(probe '{"type":"services.get"}' services.result)" || fail "services.get: $s"
[ "$(echo "$s" | jq -r .install)" = native ] || fail "install kind: $(echo "$s" | jq -r .install)"
[ "$(service "$s" stt .source)" = cloud ] || fail "stt is not cloud by default"
[ "$(service "$s" stt '.missing[0]')" = GROQ_API_KEY ] || fail "the missing Groq key is not named"
[ "$(service "$s" embeddings .source)" = off ] || fail "embeddings not off by default"
[ "$(service "$s" search .source)" = off ] || fail "search not off by default"
[ "$(service "$s" browser .health)" = up ] || fail "the browser does not answer"
ok "services.get: voice cloud (Groq key named), embeddings and search off, browser up"
refused="$(probe '{"type":"services.set","id":"search","source":"url","url":"ftp://x"}' services.result || true)"
[ "$(echo "$refused" | jq -r .scope)" = services ] || fail "a bad URL was not refused: $refused"
ok "services.set refuses a URL that is not http(s)"

# 5b. A Claude token pasted into .env on a fresh install: no Claude provider exists yet, so one is
# declared to take it, and the line leaves .env (one source per account).
token="sk-ant-oat01-$(head -c 30 /dev/urandom | od -An -tx1 | tr -d ' \n')"
as_claw "echo 'CLAUDE_CODE_OAUTH_TOKEN=${token}' >> ~/.my-claw/.env"
# The account file is written before the line leaves .env: wait for both.
for _ in $(seq 1 60); do
  as_claw 'test -s ~/.my-claw/accounts/claude.json && ! grep -q ^CLAUDE_CODE_OAUTH_TOKEN= ~/.my-claw/.env' && break
  sleep 1
done
[ "$(as_claw 'jq -r .llm.providers.claude.type ~/.my-claw/config.json')" = anthropic ] || fail "no Claude provider declared for the .env token"
as_claw "grep -q '${token}' ~/.my-claw/accounts/claude.json" || fail "the .env token did not reach accounts/claude.json"
as_claw 'grep -q ^CLAUDE_CODE_OAUTH_TOKEN= ~/.my-claw/.env' && fail "the token line is still in .env"
a="$(probe '{"type":"accounts.get"}' accounts.result)" || fail "accounts.get: $a"
[ "$(echo "$a" | jq -r '.accounts[] | select(.provider == "claude") | .connected')" = true ] || fail "the Claude plan does not read connected: $a"
ok "a Claude token in .env: provider declared, token adopted, line removed, account connected"

# 6. Local speech-to-text from the app: installs faster-whisper, then starts Whisper.
s="$(probe '{"type":"services.set","id":"stt","source":"self-hosted"}' services.result)" || fail "services.set stt: $s"
[ "$(service "$s" stt .source)" = self-hosted ] || fail "stt not self-hosted after the set"
wait_unit enabled my-claw-whisper || fail "whisper not enabled after switching to local"
as_claw 'test -x ~/.my-claw/runtime/whisper/bin/python' || fail "faster-whisper was not installed into its venv"
answered="$(whisper_answers)" || fail "local Whisper does not answer on :8000"
ok "speech-to-text set to this server: faster-whisper installed, Whisper started ($answered)"
# Back to the cloud by editing the file by hand: the watcher path, not the app's.
as_claw "tmp=\$(mktemp) && jq '.voice.stt.mode = \"cloud\"' ~/.my-claw/config.json > \$tmp && cat \$tmp > ~/.my-claw/config.json && rm \$tmp"
wait_unit disabled my-claw-whisper || fail "whisper not disabled after switching back to cloud"
s="$(probe '{"type":"services.free","id":"stt"}' services.result)" || fail "services.free stt: $s"
as_claw 'test ! -e ~/.my-claw/runtime/whisper' || fail "the whisper venv is still there after free"
ok "back to cloud: Whisper stopped, and its files freed"

# 7. Local embeddings from the app: the model lands in ~/.my-claw/models, and is freed.
probe '{"type":"services.set","id":"embeddings","source":"self-hosted"}' services.result >/dev/null || fail "services.set embeddings"
for _ in $(seq 1 180); do
  as_claw 'find ~/.my-claw/models/transformers -name "*.onnx" 2>/dev/null | grep . >/dev/null' && break
  sleep 1
done
as_claw 'find ~/.my-claw/models/transformers -name "*.onnx" | grep . >/dev/null' || fail "the embedding model was not downloaded into ~/.my-claw/models"
as_claw 'grep -q "memory embedding ready" ~/.my-claw/logs/orchestrator-*.log' || fail "the embedding model did not warm up"
probe '{"type":"services.set","id":"embeddings","source":"off"}' services.result >/dev/null || fail "embeddings off"
probe '{"type":"services.free","id":"embeddings"}' services.result >/dev/null || fail "services.free embeddings"
as_claw 'test ! -e ~/.my-claw/models/transformers' || fail "the embedding model is still there after free"
ok "embeddings on this server: model downloaded and warmed up, then freed"

# 8. An update: the same tarball, forced, through the real updater (swap, units, health gate).
as_claw "myclaw update --file /dist/$(basename "$tarball") --force" > "/var/tmp/update-${machine}.log" 2>&1 \
  || { tail -30 "/var/tmp/update-${machine}.log"; fail "myclaw update"; }
[ "$(unit_state active my-claw)" = "active" ] || fail "my-claw down after the update"
[ "$(unit_state enabled my-claw-whisper)" != "enabled" ] || fail "the update enabled whisper"
ok "update applied, server up, whisper still off"

echo "PASS [$machine]"
