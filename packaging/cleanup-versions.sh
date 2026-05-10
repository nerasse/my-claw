#!/bin/bash
set -euo pipefail

KEEP_VERSIONS=${KEEP_VERSIONS:-15}
FORGEJO_URL=${FORGEJO_URL:-https://git.kssimi.fr}
FORGEJO_TOKEN=${FORGEJO_TOKEN:-}
OWNER="claw"
PACKAGE="my-claw"

echo "Fetching versions from Package Registry..."

# List all versions
versions=$(curl -fsS -H "Authorization: token ${FORGEJO_TOKEN}" \
  "${FORGEJO_URL}/api/packages/${OWNER}/generic/${PACKAGE}" | \
  jq -r '.[] | select(.type == "generic") | .version' | \
  sort -V)

total=$(echo "$versions" | wc -l)

if [ "$total" -le "$KEEP_VERSIONS" ]; then
  echo "Found ${total} version(s), keeping all (limit: ${KEEP_VERSIONS})"
  exit 0
fi

echo "Found ${total} versions, keeping latest ${KEEP_VERSIONS}"

# Delete oldest versions (beyond the N latest)
echo "$versions" | head -n -${KEEP_VERSIONS} | while read -r version; do
  echo "Deleting version ${version}..."
  
  # Get files for this version
  files=$(curl -fsS -H "Authorization: token ${FORGEJO_TOKEN}" \
    "${FORGEJO_URL}/api/packages/${OWNER}/generic/${PACKAGE}/${version}" | \
    jq -r '.files[] | .name')
  
  for file in $files; do
    echo "  Removing file: ${file}"
    curl -fsS -X DELETE -H "Authorization: token ${FORGEJO_TOKEN}" \
      "${FORGEJO_URL}/api/packages/${OWNER}/generic/${PACKAGE}/${version}/${file}" || true
  done
  
  # Delete the version itself
  curl -fsS -X DELETE -H "Authorization: token ${FORGEJO_TOKEN}" \
    "${FORGEJO_URL}/api/packages/${OWNER}/generic/${PACKAGE}/${version}" || true
done

echo "Cleanup complete"
