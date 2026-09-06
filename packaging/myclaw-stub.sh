#!/bin/bash
# /usr/local/bin/myclaw: the one file of a my-claw install outside the service user's ownership.
# It only forwards to the installed tree. Root is dropped to the user who owns the tree first, so
# nothing inside a user-owned tree ever runs as root, and `sudo myclaw ...` keeps working out of
# habit. Installed once, never updated: it carries no version-specific logic.
set -u
APP_DIR="/opt/my-claw"

if [ ! -L "${APP_DIR}/current" ]; then
  # Legacy layout (root-owned tree, system units): the tree's own script knows that mode.
  exec "${APP_DIR}/scripts/myclaw.sh" "$@"
fi

owner="$(stat -c %U "$APP_DIR")"
if [ "$EUID" -eq 0 ] && [ "$owner" != "root" ]; then
  uid="$(id -u "$owner")"
  home="$(getent passwd "$owner" | cut -d: -f6)"
  exec runuser -u "$owner" -- env "HOME=${home}" "XDG_RUNTIME_DIR=/run/user/${uid}" \
    "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus" \
    "${APP_DIR}/current/scripts/myclaw.sh" "$@"
fi
exec "${APP_DIR}/current/scripts/myclaw.sh" "$@"
