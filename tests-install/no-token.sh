#!/bin/bash
# An owner who installed an old release and never set a forge token (the old .env template's
# placeholder still there): stuck on that release, nothing to trade for a key. The owner of the hub
# gives them a key and the one-line install; run over the old install, it must update it in place
# and keep everything they had.
#   tests-install/no-token.sh debian12|ubuntu2404 [--keep]       docs/install-test.md
set -euo pipefail
cd "$(dirname "$0")"
machine="${1:?usage: no-token.sh debian12|ubuntu2404 [--keep]}"
keep="${2:-}"
# shellcheck source=tests-install/lib.sh
. ./lib.sh

old="$(ls -1 ../dist/old/my-claw-*-linux-x64.tar.gz 2>/dev/null | head -1)"
new="$(ls -1t ../dist/my-claw-*-linux-x64.tar.gz 2>/dev/null | head -1)"
[ -n "$old" ] && [ -n "$new" ] || { echo "needs dist/old/<release>.tar.gz and dist/<this tree>.tar.gz"; exit 1; }
v="$(basename "$new" -linux-x64.tar.gz)"; v="${v#my-claw-}"
oldname="$(basename "$old" .tar.gz)"
KEY="dlh_e2e-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
URL="http://hub:8099/my-claw"
HUB="my-claw-install-test-hub"

stage="../dist/hub-e2e"
rm -rf "$stage" && mkdir -p "$stage/hub/server/$v" "$stage/hub/app/0.6.999" "$stage/web"
cp "$new" "$stage/hub/server/$v/"
echo '<!doctype html><title>e2e bundle</title>' > "$stage/web/index.html"
tar -czf "$stage/hub/app/0.6.999/dist-web.tar.gz" -C "$stage/web" . && rm -rf "$stage/web"
echo "not an apk" > "$stage/hub/app/0.6.999/my-claw-app-v0.6.999.apk"
# The hub reads the installer from the repository at the release tag: this tree's copy.
cp ../packaging/install-remote.sh "$stage/hub/install.sh"

finish() { docker rm -f "$HUB" >/dev/null 2>&1 || true; cleanup; rm -rf "$stage"; }
trap finish EXIT
boot_machine

# 1. The old owner: this tree's installer brings the packages, then the old release is what runs,
# with the .env its own template wrote (FORGEJO_URL and the placeholder token).
install_tarball "/dist/$(basename "$new")" "/var/tmp/nt-install-${machine}.log"
as_claw "myclaw update --file /dist/old/$(basename "$old") --force" > "/var/tmp/nt-down-${machine}.log" 2>&1 \
  || { tail -20 "/var/tmp/nt-down-${machine}.log"; fail "installing ${oldname}"; }
oldv="$(as_claw 'jq -r .version /opt/my-claw/current/package.json')"
as_claw "tar -xzf /dist/old/$(basename "$old") -O ${oldname}/etc/.env.example > ~/.my-claw/.env && chmod 600 ~/.my-claw/.env"
as_claw 'printf "GROQ_API_KEY=keep-me-groq\n" >> ~/.my-claw/.env'
as_claw "tmp=\$(mktemp) && jq '.voice = {mode: \"auto\"}' ~/.my-claw/config.json > \$tmp && cat \$tmp > ~/.my-claw/config.json && rm \$tmp"
as_claw 'mkdir -p ~/.my-claw/workspace && echo "my notes" > ~/.my-claw/workspace/mine.md'
as_claw 'systemctl --user restart my-claw.service'
grep -q '^FORGEJO_TOKEN=your_forgejo_token_here$' <(as_claw 'cat ~/.my-claw/.env') || fail "the old template is not in place"
c_before="$(creds)"
[ -n "${c_before% *}" ] && [ "${c_before% *}" != "null" ] || fail "no paired device before"
ok "old owner on ${oldv}: old .env template (placeholder token), own config, a note, a paired device"

as_claw "/opt/my-claw/current/packaging/auto-update.sh" > "/var/tmp/nt-stuck-${machine}.log" 2>&1 || true
[ "$(as_claw 'jq -r .version /opt/my-claw/current/package.json')" = "$oldv" ] || fail "the old timer moved without a token"
ok "the old timer is stuck: $(grep -m1 -oE 'cannot check[^,]*|could not resolve[^,]*' "/var/tmp/nt-stuck-${machine}.log" || echo 'no update')"

# 2. The hub, and the one-line install the owner sends them.
docker run -d --rm --name "$HUB" --network my-claw-install-test_default --network-alias hub \
  -v "$(realpath "$stage"):/srv" -v "$(pwd)/fake-hub.py:/fake-hub.py:ro" \
  python:3.12-slim python3 /fake-hub.py "$KEY" >/dev/null
for _ in $(seq 1 30); do on "curl -s -o /dev/null http://hub:8099/" && break; sleep 0.5; done
on "curl -fsSL -H 'Authorization: Bearer $KEY' $URL/install.sh | SUDO_USER=claw bash" \
  > "/var/tmp/nt-oneline-${machine}.log" 2>&1 || { tail -40 "/var/tmp/nt-oneline-${machine}.log"; fail "the one-line install over ${oldv}"; }
[ "$(as_claw 'jq -r .version /opt/my-claw/current/package.json')" = "$v" ] || fail "not on ${v} after the one-line install"
for _ in $(seq 1 60); do [ "$(unit_state active my-claw)" = "active" ] && break; sleep 1; done
[ "$(unit_state active my-claw)" = "active" ] || fail "my-claw down after the one-line install"
ok "the one-line install took ${oldv} to ${v} in place, server up"

# 3. Everything they had is still there, and the source is set.
env_now="$(as_claw 'cat ~/.my-claw/.env')"
grep -qx 'GROQ_API_KEY=keep-me-groq' <<<"$env_now" || fail "their Groq key is gone"
grep -qx "MY_CLAW_RELEASE_URL=$URL" <<<"$env_now" && grep -qx "MY_CLAW_RELEASE_KEY=$KEY" <<<"$env_now" || fail "the source is not in .env"
[ "$(on "stat -c '%a %U' /home/claw/.my-claw/.env")" = "600 claw" ] || fail ".env is not 600 claw"
[ "$(as_claw 'jq -r .voice.mode ~/.my-claw/config.json')" = "auto" ] || fail "their config was replaced"
[ "$(as_claw 'cat ~/.my-claw/workspace/mine.md')" = "my notes" ] || fail "their workspace note is gone"
[ "$(creds)" = "$c_before" ] || fail "their paired device is gone"
on "test -d /opt/my-claw/releases/${oldv}" || fail "the old release is not kept for a rollback"
ok "kept: .env lines, config, workspace, paired device, ${oldv} for a rollback; .env holds the source (600, claw)"

# 4. From now on the hub: the timer checks it with the key, the web bundle comes from it.
as_claw "/opt/my-claw/current/packaging/auto-update.sh" > "/var/tmp/nt-timer-${machine}.log" 2>&1 \
  || { cat "/var/tmp/nt-timer-${machine}.log"; fail "auto-update after the one-line install"; }
grep -q "checking $URL" "/var/tmp/nt-timer-${machine}.log" && grep -q "up to date (${v})" "/var/tmp/nt-timer-${machine}.log" \
  || { cat "/var/tmp/nt-timer-${machine}.log"; fail "the timer does not read the hub"; }
[ "$(as_claw 'basename "$(readlink ~/.my-claw/web/current)"')" = "v0.6.999" ] || fail "the web bundle did not come from the hub"
ok "the timer reads the hub with the key; web bundle v0.6.999 from the hub"

echo "PASS [$machine] no-token ${oldv} -> ${v} by the one-line install"
