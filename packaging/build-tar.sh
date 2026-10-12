#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
VERSION=$(jq -r '.version' "${PROJECT_ROOT}/package.json")
BUILD_DIR="${PROJECT_ROOT}/dist"
TAR_NAME="my-claw-${VERSION}-linux-x64"
TAR_DIR="${BUILD_DIR}/${TAR_NAME}"

echo "Building my-claw ${VERSION} tarball"

# Clean and create structure
rm -rf "${TAR_DIR}"
mkdir -p "${TAR_DIR}"

# Copy project source
cp -r "${PROJECT_ROOT}/src" "${TAR_DIR}/"
# Browser sidecar (runs under Node; Playwright connectOverCDP hangs under Bun)
cp -r "${PROJECT_ROOT}/sidecar" "${TAR_DIR}/"
cp "${PROJECT_ROOT}/package.json" "${TAR_DIR}/"
cp "${PROJECT_ROOT}/tsconfig.json" "${TAR_DIR}/"

# Copy prompt templates (needed for workspace seeding)
mkdir -p "${TAR_DIR}/docs"
cp -r "${PROJECT_ROOT}/docs/prompt" "${TAR_DIR}/docs/prompt"

# The production dependencies only, from the lockfile: copying the checkout's node_modules shipped
# the dev tools, and transformers.js with onnxruntime (440 MB) that only local embeddings use and
# that the server installs when they are switched on (docs/services.md, "Local engines").
cp "${PROJECT_ROOT}/bun.lock" "${TAR_DIR}/"
mkdir -p "${TAR_DIR}/scripts"
cp "${PROJECT_ROOT}/scripts/apply-dependency-patches.cjs" "${PROJECT_ROOT}/scripts/dependency-patches.json" "${TAR_DIR}/scripts/"
(cd "${TAR_DIR}" && bun install --frozen-lockfile --production --silent)

# Copy scripts
mkdir -p "${TAR_DIR}/packaging"
cp "${SCRIPT_DIR}/install.sh" "${TAR_DIR}/packaging/"
cp "${SCRIPT_DIR}/uninstall.sh" "${TAR_DIR}/packaging/"
cp "${SCRIPT_DIR}/update.sh" "${TAR_DIR}/packaging/"
cp "${SCRIPT_DIR}/auto-update.sh" "${TAR_DIR}/packaging/"
# Sourced by both updaters out of the installed tree: without it in the tarball, the deployed
# machine warns and never moves its web bundle again.
cp "${SCRIPT_DIR}/web-bundle.sh" "${TAR_DIR}/packaging/"
cp "${SCRIPT_DIR}/release-source.sh" "${TAR_DIR}/packaging/"
# The /usr/local/bin/myclaw stub, installed once by install.sh or the migration.
cp "${SCRIPT_DIR}/myclaw-stub.sh" "${TAR_DIR}/packaging/"
# Run by the Chromium unit before every start: without it in the tarball the unit's ExecStartPre
# points at nothing, and a browser that went down hard comes back on a blank page.
cp "${SCRIPT_DIR}/chromium-prestart.sh" "${TAR_DIR}/packaging/"
chmod 755 "${TAR_DIR}/packaging/"*.sh
# The local STT sidecar the whisper unit runs. Without it in the tarball the unit points at a file
# that is not there, which is the shape of the bug it replaces.
cp "${SCRIPT_DIR}/whisper-server.py" "${TAR_DIR}/packaging/"
chmod 755 "${TAR_DIR}/packaging/whisper-server.py"

# Copy CLI wrapper
mkdir -p "${TAR_DIR}/scripts"
cp "${PROJECT_ROOT}/scripts/myclaw.sh" "${TAR_DIR}/scripts/"
chmod 755 "${TAR_DIR}/scripts/myclaw.sh"

# Copy config templates
mkdir -p "${TAR_DIR}/etc"
cp "${SCRIPT_DIR}/config.json" "${TAR_DIR}/etc/"
cp "${SCRIPT_DIR}/.env.example" "${TAR_DIR}/etc/"
chmod 644 "${TAR_DIR}/etc/config.json"
chmod 600 "${TAR_DIR}/etc/.env.example"

# systemd user units, what an install runs (docs/install-layout.md)
mkdir -p "${TAR_DIR}/units"
cp "${SCRIPT_DIR}/units/"*.service "${TAR_DIR}/units/"
cp "${SCRIPT_DIR}/units/"*.timer "${TAR_DIR}/units/"
chmod 644 "${TAR_DIR}/units/"*.service "${TAR_DIR}/units/"*.timer

# Legacy system unit templates. An install that predates user units checks for this directory
# before accepting a tarball and renders these to run the release until its own migration tick;
# a migration that fails also falls back on them. Drop together with install_legacy_root once
# no 0.5.x install is left.
mkdir -p "${TAR_DIR}/templates"
cp "${SCRIPT_DIR}/templates/"*.service "${TAR_DIR}/templates/"
cp "${SCRIPT_DIR}/templates/"*.timer "${TAR_DIR}/templates/"
chmod 644 "${TAR_DIR}/templates/"*.service "${TAR_DIR}/templates/"*.timer

# Build tarball
cd "${BUILD_DIR}"
tar czf "${TAR_NAME}.tar.gz" "${TAR_NAME}"
rm -rf "${TAR_NAME}"

echo "Tarball built: dist/${TAR_NAME}.tar.gz"
