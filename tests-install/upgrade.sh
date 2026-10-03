#!/bin/bash
# An owner on 0.7.72 (before on-demand engines) running local speech-to-text the way the old guide
# said (pip --user faster-whisper, voice on auto, the old .env template's placeholder Groq key),
# updated by their own old updater to the tarball of this tree. Nothing they had may stop working.
#   tests-install/upgrade.sh debian12|ubuntu2404 [--keep]       docs/install-test.md
set -euo pipefail
cd "$(dirname "$0")"
machine="${1:?usage: upgrade.sh debian12|ubuntu2404 [--keep]}"
keep="${2:-}"
# shellcheck source=tests-install/lib.sh
. ./lib.sh
old="$(ls -1 ../dist/old/my-claw-*-linux-x64.tar.gz 2>/dev/null | head -1)"
new="$(ls -1t ../dist/my-claw-*-linux-x64.tar.gz 2>/dev/null | head -1)"
[ -n "$old" ] && [ -n "$new" ] || { echo "needs dist/old/<release>.tar.gz and dist/<this tree>.tar.gz"; exit 1; }
trap cleanup EXIT
boot_machine

# The machine an old owner has: this tree's installer brings the packages (the old one needed them
# beforehand), then the old release is what runs.
install_tarball "/dist/$(basename "$new")" "/tmp/upgrade-install-${machine}.log"
as_claw "myclaw update --file /dist/old/$(basename "$old") --force" > "/tmp/upgrade-down-${machine}.log" 2>&1 \
  || { tail -20 "/tmp/upgrade-down-${machine}.log"; fail "installing $(basename "$old")"; }
oldv="$(as_claw 'jq -r .version /opt/my-claw/current/package.json')"
ok "running the old release ($oldv)"

# Their local speech-to-text, set up by hand as the old guide said.
on 'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3-pip >/dev/null'
as_claw 'pip install --user --quiet --break-system-packages faster-whisper==1.2.1 av==17.0.0 ctranslate2==4.7.1' >/dev/null 2>&1 \
  || fail "pip install --user faster-whisper"
as_claw "tmp=\$(mktemp) && jq '.voice = {mode: \"auto\"}' ~/.my-claw/config.json > \$tmp && cat \$tmp > ~/.my-claw/config.json && rm \$tmp"
as_claw 'printf "GROQ_API_KEY=your_groq_key_here\n" >> ~/.my-claw/.env'
as_claw 'systemctl --user enable --now my-claw-whisper.service' >/dev/null 2>&1
whisper_answers >/dev/null || fail "the old setup's Whisper does not answer"
ok "old owner's local Whisper answers (system faster-whisper, voice auto, placeholder Groq key)"
chromium_before="$(as_claw 'systemctl --user show -p MainPID --value my-claw-chromium.service')"

# Their own updater (the old release's), to this tree.
as_claw "myclaw update --file /dist/$(basename "$new") --force" > "/tmp/upgrade-up-${machine}.log" 2>&1 \
  || { tail -30 "/tmp/upgrade-up-${machine}.log"; fail "the old updater could not install this tree"; }
newv="$(as_claw 'jq -r .version /opt/my-claw/current/package.json')"
[ "$newv" != "$oldv" ] || fail "still on $oldv"
[ "$(unit_state active my-claw)" = "active" ] || fail "my-claw down after the update"
ok "the old updater installed $newv, server up"

# Their voice still works: the placeholder is not a key, auto resolves local, Whisper stays on.
sleep 5
[ "$(unit_state enabled my-claw-whisper)" = "enabled" ] || fail "the update disabled their Whisper"
whisper_answers >/dev/null || fail "their Whisper no longer answers"
as_claw 'test ! -e ~/.my-claw/runtime/whisper' || fail "a venv was installed over a working system faster-whisper"
s="$(probe '{"type":"services.get"}' services.result)" || fail "services.get: $s"
[ "$(service "$s" stt .source)" = self-hosted ] || fail "stt resolves to $(service "$s" stt .source), not their local engine"
ok "their Whisper still enabled and answering, nothing reinstalled, stt reads self-hosted"
[ "$(as_claw 'systemctl --user show -p MainPID --value my-claw-chromium.service')" = "$chromium_before" ] || fail "the update restarted Chromium"
ok "Chromium not restarted by the update"

echo "PASS [$machine] upgrade $oldv -> $newv"
