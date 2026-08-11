#!/bin/bash
#
# 40 — stage the DragonPBX app (from a git tag/branch, or a local path) into the
# package root, ship the config env, and bundle a self-contained Node runtime.
#
# Args: [repo_url] [version]
#   version = a git tag/branch on repo_url (e.g. 0.7.0), OR "local" to copy from
#             $APP_SRC (a local checkout whose root contains package.json).
# The DragonPBX repo keeps app.js/package.json at its ROOT, so a clone maps
# directly to /opt/dragonpbx/app.
#
# Runs as root on the Debian 12 build VM / container.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

: "${PKGROOT:=/tmp/dragonpbx-pkgroot}"
: "${FILES:=/tmp/dragonpbx-files}"
: "${APP_SRC:=/tmp/dragonpbx-app}"   # local app root (package.json at top), used when version=local
: "${NODE_VERSION:=22.14.0}"

REPO="${1:-${DRAGONPBX_REPO:-https://github.com/sammachin/dragonpbx.git}}"
VERSION="${2:-${DRAGONPBX_VERSION:-local}}"

DEST="$PKGROOT/opt/dragonpbx"
# Clean only the app-layer dirs; preserve vendor/redis + rtpengine-modver.
rm -rf "$DEST/app" "$DEST/config" "$DEST/node" "$DEST/README.md"
mkdir -p "$DEST/app"

# --- obtain the app source ---
if [ "$VERSION" != "local" ]; then
  echo "Fetching DragonPBX app from $REPO @ $VERSION"
  command -v git >/dev/null 2>&1 || { apt-get update; apt-get install -y --no-install-recommends git ca-certificates; }
  TMP_APP="$(mktemp -d)"
  git -c advice.detachedHead=false clone --depth 1 "$REPO" -b "$VERSION" "$TMP_APP/src"
  ( cd "$TMP_APP/src" && echo "  checked out: $(git describe --tags --always 2>/dev/null || echo "$VERSION")" )
  cp -a "$TMP_APP/src/." "$DEST/app/"
  rm -rf "$DEST/app/.git"
else
  echo "Staging DragonPBX app from local path $APP_SRC"
  cp -a "$APP_SRC/." "$DEST/app/"
fi
rm -f "$DEST/app/.gitkeep"
find "$DEST" -name '.DS_Store' -delete 2>/dev/null || true

# --- config env (maintained in the packer project, NOT in the app repo) ---
install -D -m 0644 "$FILES/dragonpbx.env" "$DEST/config/dragonpbx.env"

# --- bundle Node + install production deps ---
if [ -f "$DEST/app/package.json" ]; then
  echo "Node app detected — bundling Node ${NODE_VERSION} and installing production deps"

  case "$(dpkg --print-architecture)" in
    amd64) NODE_ARCH=x64 ;;
    arm64) NODE_ARCH=arm64 ;;
    *)     NODE_ARCH=x64 ;;
  esac

  command -v xz >/dev/null 2>&1 || { apt-get update; apt-get install -y --no-install-recommends xz-utils curl ca-certificates; }

  # Bundle the official Node runtime under /opt/dragonpbx/node (no system node dep).
  mkdir -p "$DEST/node"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" -o /tmp/node.tar.xz
  tar -xJf /tmp/node.tar.xz -C "$DEST/node" --strip-components=1
  export PATH="$DEST/node/bin:$PATH"
  echo "bundled node: $(node --version), npm: $(npm --version)"

  ( cd "$DEST/app" && npm ci --omit=dev )

  # Drop non-target native prebuilds to keep the package lean.
  KEEP="linux-x64"; [ "$NODE_ARCH" = arm64 ] && KEEP="linux-arm64"
  find "$DEST/app" -type d -name prebuilds -print | while read -r p; do
    find "$p" -mindepth 1 -maxdepth 1 -type d ! -name "$KEEP" -exec rm -rf {} +
  done
else
  echo "No app/package.json — staging app/config as-is (placeholder build)"
fi

echo "DragonPBX app/config staged under $DEST:"
ls -la "$DEST"
