#!/bin/sh
# Fetches the relay from Forgejo with the relay's own read-only token. Run on docker02deb.
set -eu
T="$(sed -n 's/^FORGEJO_TOKEN=//p' /home/neras/docker/my-claw-dist/.env)"
REF="${1:-main}"
get() { curl -fsS -H "Authorization: token $T" "https://git.kssimi.fr/api/v1/repos/claw/my-claw/raw/relay/$1?ref=$REF" -o "$2"; }
mkdir -p /home/neras/appdata/my-claw-dist/relay /home/neras/appdata/my-claw-dist/data
for f in forgejo keys page relay server; do get "$f.ts" "/home/neras/appdata/my-claw-dist/relay/$f.ts"; done
get compose.yml /home/neras/docker/my-claw-dist/compose.yml
echo "relay fetched at $REF"
