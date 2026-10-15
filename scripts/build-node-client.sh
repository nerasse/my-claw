#!/bin/bash
set -euo pipefail

# Builds the node client for every target into dist/node/ (docs/remote-nodes.md). Cross-compiling
# works from linux-x64: Bun fetches the target runtime on demand. The release workflow uploads the
# files as release assets, and dl-hub serves them as the `node` component of the my-claw product.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
VERSION=$(jq -r '.version' "${PROJECT_ROOT}/package.json")
OUT="${PROJECT_ROOT}/dist/node"

rm -rf "${OUT}"
mkdir -p "${OUT}"

for target in linux-x64 linux-arm64 darwin-x64 darwin-arm64 windows-x64; do
  exe=""
  [ "${target}" = "windows-x64" ] && exe=".exe"
  outfile="${OUT}/my-claw-node-${VERSION}-${target}${exe}"
  echo "Building ${outfile}..."
  bun build "${PROJECT_ROOT}/src/node-client/main.ts" \
    --compile --minify \
    --target="bun-${target}" \
    --outfile="${outfile}" \
    --define "MYCLAW_NODE_VERSION=\"${VERSION}\"" \
    --silent
done

echo ""
ls -lh "${OUT}"
