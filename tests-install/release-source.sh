#!/bin/bash
# The release source end to end (docs/release-source.md), on a fresh machine, against a dl-hub in a
# container beside it (fake-hub.py): the one-line install with a key, the web bundle and a new release coming
# through it (`myclaw update`, then the timer), a revoked key, and `myclaw release-key`.
#   tests-install/release-source.sh debian12|ubuntu2404 [--keep]
# Build the tarball first: packaging/build-tar.sh. docs/install-test.md
set -euo pipefail
cd "$(dirname "$0")"
machine="${1:?usage: release-source.sh debian12|ubuntu2404 [--keep]}"
keep="${2:-}"
# shellcheck source=tests-install/lib.sh
. ./lib.sh

tarball="$(ls -1t ../dist/my-claw-*-linux-x64.tar.gz 2>/dev/null | head -1)"
[ -n "$tarball" ] || { echo "no tarball in dist/: run packaging/build-tar.sh"; exit 1; }
v="$(basename "$tarball" -linux-x64.tar.gz)"; v="${v#my-claw-}"
next="${v%.*}.$(( ${v##*.} + 1 ))"
KEY="dlh_e2e-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
URL="http://hub:8099/my-claw"
HUB="my-claw-install-test-hub"

# The hub's files, staged under dist/ (mounted read-only at /dist): this release, a "next" one
# that is the same tree under a higher version, an app release with a web bundle, the installer.
stage="../dist/hub-e2e"
rm -rf "$stage" && mkdir -p "$stage/hub/server/$v" "$stage/hub/app/0.6.999" "$stage/next/$next" "$stage/work"
cp "$tarball" "$stage/hub/server/$v/"
tar -xzf "$tarball" -C "$stage/work"
mv "$stage/work/my-claw-${v}-linux-x64" "$stage/work/my-claw-${next}-linux-x64"
jq --arg v "$next" '.version = $v' "$stage/work/my-claw-${next}-linux-x64/package.json" > "$stage/work/p.json"
mv "$stage/work/p.json" "$stage/work/my-claw-${next}-linux-x64/package.json"
tar -czf "$stage/next/$next/my-claw-${next}-linux-x64.tar.gz" -C "$stage/work" "my-claw-${next}-linux-x64"
mkdir -p "$stage/web" && echo '<!doctype html><title>e2e bundle</title>' > "$stage/web/index.html"
tar -czf "$stage/hub/app/0.6.999/dist-web.tar.gz" -C "$stage/web" .
echo "not an apk" > "$stage/hub/app/0.6.999/my-claw-app-v0.6.999.apk"
cp ../packaging/install-remote.sh "$stage/hub/install.sh"
rm -rf "$stage/work" "$stage/web"

finish() { docker rm -f "$HUB" >/dev/null 2>&1 || true; cleanup; rm -rf "$stage"; }
trap finish EXIT
boot_machine

docker run -d --rm --name "$HUB" --network my-claw-install-test_default --network-alias hub \
  -v "$(realpath "$stage"):/srv" -v "$(pwd)/fake-hub.py:/fake-hub.py:ro" \
  python:3.12-slim python3 /fake-hub.py "$KEY" >/dev/null
for _ in $(seq 1 30); do on "curl -s -o /dev/null http://hub:8099/" && break; sleep 0.5; done
[ "$(on "curl -s -o /dev/null -w '%{http_code}' $URL/server/latest.json")" = "401" ] || fail "the fake hub does not ask for a key"
ok "fake hub up, ${v} and app 0.6.999 published, a request without the key is a 401"

# 1. The one-line install, as the hub's instructions give it: the key once, in the header. sudo
# would set SUDO_USER.
on "curl -fsSL -H 'Authorization: Bearer $KEY' $URL/install.sh | SUDO_USER=claw bash" \
  > "/var/tmp/rs-install-${machine}.log" 2>&1 || { tail -40 "/var/tmp/rs-install-${machine}.log"; fail "install-remote"; }
[ "$(unit_state active my-claw)" = "active" ] || fail "my-claw not active after the install"
[ "$(on "jq -r .version /opt/my-claw/current/package.json")" = "$v" ] || fail "installed version is not ${v}"
as_claw "grep -qx 'MY_CLAW_RELEASE_URL=$URL' ~/.my-claw/.env && grep -qx 'MY_CLAW_RELEASE_KEY=$KEY' ~/.my-claw/.env" \
  || fail "the release source is not in .env"
[ "$(on "stat -c '%a %U' /home/claw/.my-claw/.env")" = "600 claw" ] || fail ".env is not 600 claw"
ok "installed ${v} from the hub; .env holds the source and the key (600, claw)"

# 2. myclaw update with nothing new: the server stays, the web bundle comes from the hub.
as_claw "myclaw update" > "/var/tmp/rs-update1-${machine}.log" 2>&1 || { tail -30 "/var/tmp/rs-update1-${machine}.log"; fail "myclaw update"; }
[ "$(as_claw 'basename "$(readlink ~/.my-claw/web/current)"')" = "v0.6.999" ] || { tail -20 "/var/tmp/rs-update1-${machine}.log"; fail "web bundle v0.6.999 not current"; }
as_claw 'grep -q "e2e bundle" ~/.my-claw/web/current/index.html' || fail "the web bundle is not the hub's"
ok "myclaw update: server unchanged, web bundle v0.6.999 installed from the hub"

# 3. A new release on the hub: the timer finds it and installs it.
cp -r "$stage/next/${next}" "$stage/hub/server/"
as_claw "/opt/my-claw/current/packaging/auto-update.sh" > "/var/tmp/rs-timer-${machine}.log" 2>&1 \
  || { tail -30 "/var/tmp/rs-timer-${machine}.log"; fail "auto-update"; }
grep -q "${next} available (installed ${v})" "/var/tmp/rs-timer-${machine}.log" || { cat "/var/tmp/rs-timer-${machine}.log"; fail "the timer did not see ${next}"; }
[ "$(on "jq -r .version /opt/my-claw/current/package.json")" = "$next" ] || { tail -30 "/var/tmp/rs-timer-${machine}.log"; fail "the timer did not install ${next}"; }
[ "$(unit_state active my-claw)" = "active" ] || fail "my-claw down after the timer's update"
ok "the timer saw ${next} on the hub and installed it, server up"

# Every request carried the key, and none went anywhere but the hub.
[ "$(grep nokey "$stage/fake-hub.log" | grep -vc '^GET / ')" = "1" ] || { cat "$stage/fake-hub.log"; fail "a request reached the hub without the key"; }
ok "every request but the probe carried the key ($(wc -l < "$stage/fake-hub.log") requests)"

# 4. A revoked key: the timer retries quietly, the manual update says why, nothing moves.
touch "$stage/hub/revoked"
# Into a file, never `| grep -q`: grep leaving early is a SIGPIPE upstream, a failure under pipefail.
as_claw "/opt/my-claw/current/packaging/auto-update.sh" > "/var/tmp/rs-timer2-${machine}.log" 2>&1 || true
grep -q "could not resolve the latest version" "/var/tmp/rs-timer2-${machine}.log" || { cat "/var/tmp/rs-timer2-${machine}.log"; fail "timer with a revoked key"; }
as_claw "myclaw update" > "/var/tmp/rs-update2-${machine}.log" 2>&1 && fail "myclaw update succeeded with a revoked key"
grep -q "could not determine the latest version" "/var/tmp/rs-update2-${machine}.log" || { cat "/var/tmp/rs-update2-${machine}.log"; fail "no reason given"; }
[ "$(on "jq -r .version /opt/my-claw/current/package.json")" = "$next" ] || fail "something moved with a revoked key"
as_claw "myclaw release-key dlh_wrong --url $URL" > "/var/tmp/rs-key-${machine}.log" 2>&1 && fail "release-key accepted a refused key"
grep -q "Nothing changed: the key was refused" "/var/tmp/rs-key-${machine}.log" || { cat "/var/tmp/rs-key-${machine}.log"; fail "release-key refusal"; }
as_claw "grep -qx 'MY_CLAW_RELEASE_KEY=$KEY' ~/.my-claw/.env" || fail "a refused key was written"
ok "revoked key: the timer retries, myclaw update and release-key refuse and say why, nothing written"

# 5. A new key from release-key, read on stdin as the docs allow.
rm "$stage/hub/revoked"
as_claw "echo '$KEY' | myclaw release-key --url $URL" > "/var/tmp/rs-key2-${machine}.log" 2>&1 || { cat "/var/tmp/rs-key2-${machine}.log"; fail "release-key"; }
grep -q "latest server release ${next}" "/var/tmp/rs-key2-${machine}.log" || fail "release-key did not check the source"
as_claw "myclaw update" > "/var/tmp/rs-update3-${machine}.log" 2>&1 || { tail -20 "/var/tmp/rs-update3-${machine}.log"; fail "myclaw update after release-key"; }
grep -q "Latest version: ${next}" "/var/tmp/rs-update3-${machine}.log" || { tail -20 "/var/tmp/rs-update3-${machine}.log"; fail "myclaw update did not read the new key"; }
ok "release-key from stdin checked the key and wrote it; myclaw update reads it"

echo "PASS [$machine] release source"
