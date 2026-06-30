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

# Copy node_modules (pre-installed)
cp -r "${PROJECT_ROOT}/node_modules" "${TAR_DIR}/"

# Copy scripts
mkdir -p "${TAR_DIR}/packaging"
cp "${SCRIPT_DIR}/install.sh" "${TAR_DIR}/packaging/"
cp "${SCRIPT_DIR}/uninstall.sh" "${TAR_DIR}/packaging/"
cp "${SCRIPT_DIR}/update.sh" "${TAR_DIR}/packaging/"
chmod 755 "${TAR_DIR}/packaging/"*.sh

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

# Copy systemd service templates
mkdir -p "${TAR_DIR}/templates"
cp "${SCRIPT_DIR}/templates/"*.service "${TAR_DIR}/templates/"
chmod 644 "${TAR_DIR}/templates/"*.service

# Build tarball
cd "${BUILD_DIR}"
tar czf "${TAR_NAME}.tar.gz" "${TAR_NAME}"
rm -rf "${TAR_NAME}"

echo "Tarball built: dist/${TAR_NAME}.tar.gz"
