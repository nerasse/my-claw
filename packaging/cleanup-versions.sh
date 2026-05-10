#!/bin/bash
set -uo pipefail

KEEP_VERSIONS=${KEEP_VERSIONS:-15}
FORGEJO_URL=${FORGEJO_URL:-https://git.kssimi.fr}
FORGEJO_USER=${FORGEJO_USER:-neras}
FORGEJO_TOKEN=${FORGEJO_TOKEN:-}
OWNER="claw"
PACKAGE="my-claw"

echo "Fetching versions from Package Registry..."

# List all package versions via API v1
versions=$(curl -fsS --user "${FORGEJO_USER}:${FORGEJO_TOKEN}" \
  -H "Accept: application/json" \
  "${FORGEJO_URL}/api/v1/packages/${OWNER}" | \
  jq -r --arg pkg "${PACKAGE}" '.[] | select(.name == $pkg and .type == "generic") | .version' | \
  sort -V) || true

if [ -z "$versions" ]; then
  echo "No versions found in Package Registry (or package does not exist yet)"
  exit 0
fi

total=$(echo "$versions" | wc -l)

if [ "$total" -le "$KEEP_VERSIONS" ]; then
  echo "Found ${total} version(s), keeping all (limit: ${KEEP_VERSIONS})"
  exit 0
fi

echo "Found ${total} versions, keeping latest ${KEEP_VERSIONS}"

# Delete oldest versions (beyond the N latest)
echo "$versions" | head -n -${KEEP_VERSIONS} | while read -r version; do
  echo "Deleting version ${version}..."

  # List files for this version
  files=$(curl -fsS --user "${FORGEJO_USER}:${FORGEJO_TOKEN}" \
    -H "Accept: application/json" \
    "${FORGEJO_URL}/api/packages/${OWNER}/generic/${PACKAGE}/${version}" 2>/dev/null | \
    jq -r '.files[]? | .name') || true

  if [ -n "$files" ]; then
    for file in $files; do
      echo "  Removing file: ${file}"
      curl -fsS -X DELETE --user "${FORGEJO_USER}:${FORGEJO_TOKEN}" \
        "${FORGEJO_URL}/api/packages/${OWNER}/generic/${PACKAGE}/${version}/${file}" || true
    done
  fi

  # Delete the version itself
  curl -fsS -X DELETE --user "${FORGEJO_USER}:${FORGEJO_TOKEN}" \
    "${FORGEJO_URL}/api/packages/${OWNER}/generic/${PACKAGE}/${version}" || true
done

echo "Cleanup complete"
