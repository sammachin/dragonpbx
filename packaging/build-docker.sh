#!/usr/bin/env bash
#
# Build the DragonPBX .deb entirely locally in a Debian bookworm container —
# no AWS. Runs the same scripts/00..50 the Packer path uses, against a package
# root on a bind mount, and drops the artifact in ./output/.
#
# On Apple Silicon the default amd64 build runs under QEMU emulation (correct
# output, slower compile). Build natively for arm64 with: ARCH_DEB=arm64
# PLATFORM=linux/arm64 ./build-docker.sh
#
# Override anything via env, e.g.:
#   DRAGONPBX_VERSION=0.7.0 RTPENGINE_VERSION=mr12.5.1.48 ./build-docker.sh
#   (the .deb version tracks DRAGONPBX_VERSION unless you set DEB_VERSION)
set -euo pipefail

PLATFORM="${PLATFORM:-linux/amd64}"
ARCH_DEB="${ARCH_DEB:-amd64}"
IMAGE="${IMAGE:-debian:bookworm}"

# DEB_VERSION defaults to the app version (resolved below); override for a
# packaging-only revision, e.g. DEB_VERSION=0.7.0-2.
DEB_VERSION="${DEB_VERSION:-}"
DRACHTIO_REPO="${DRACHTIO_REPO:-https://github.com/drachtio/drachtio-server.git}"
DRACHTIO_VERSION="${DRACHTIO_VERSION:-0.9.8}"
DISABLE_LICENSING="${DISABLE_LICENSING:-no}"
RTPENGINE_REPO="${RTPENGINE_REPO:-https://github.com/sipwise/rtpengine.git}"
RTPENGINE_VERSION="${RTPENGINE_VERSION:-mr12.5.1.48}"
LWS_VERSION="${LWS_VERSION:-v4.3.3}"
REDIS_VERSION="${REDIS_VERSION:-7.4}"   # vendored from packages.redis.io (>=7.4 for HEXPIRE)
DEB_EPOCH="${DEB_EPOCH:-1}"             # control-Version epoch so 1:0.7.0 > legacy 1.0.x

# DragonPBX app source: clone a tagged release (default) or use a local checkout.
DRAGONPBX_REPO="${DRAGONPBX_REPO:-https://github.com/sammachin/dragonpbx.git}"
DRAGONPBX_VERSION="${DRAGONPBX_VERSION:-0.7.0}"   # git tag/branch, or "local"
APP_PATH="${APP_PATH:-../dragonpbx/app}"          # local app checkout (used when version=local)

PROJ_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# In "local" mode, resolve + mount the app checkout read-only.
APP_MOUNT=()
APP_SRC_ENV=()
if [ "$DRAGONPBX_VERSION" = "local" ]; then
  if [ -d "$PROJ_DIR/$APP_PATH" ]; then APP_ABS="$(cd "$PROJ_DIR/$APP_PATH" && pwd)"
  elif [ -d "$APP_PATH" ]; then APP_ABS="$(cd "$APP_PATH" && pwd)"
  else echo "ERROR: local app checkout not found at '$APP_PATH'"; exit 1; fi
  APP_MOUNT=(-v "$APP_ABS":/work/app-src:ro)
  APP_SRC_ENV=(-e APP_SRC=/work/app-src)
  APP_DESC="local: $APP_ABS"
  # Track the local checkout's package.json version unless overridden.
  [ -z "$DEB_VERSION" ] && DEB_VERSION="$(sed -nE 's/.*"version" *: *"([^"]+)".*/\1/p' "$APP_ABS/package.json" | head -1)"
else
  APP_DESC="$DRAGONPBX_REPO @ $DRAGONPBX_VERSION"
  # Track the app tag/branch unless overridden.
  [ -z "$DEB_VERSION" ] && DEB_VERSION="$DRAGONPBX_VERSION"
fi
[ -z "$DEB_VERSION" ] && { echo "ERROR: could not determine DEB_VERSION; set it explicitly"; exit 1; }

mkdir -p "$PROJ_DIR/output"
echo "Building dragonpbx_${DEB_VERSION}_${ARCH_DEB}.deb on $PLATFORM ($IMAGE)"
echo "  drachtio  : $DRACHTIO_REPO @ v$DRACHTIO_VERSION"
echo "  rtpengine : $RTPENGINE_REPO @ $RTPENGINE_VERSION"
echo "  app       : $APP_DESC"

docker run --rm --platform="$PLATFORM" \
  -v "$PROJ_DIR":/work \
  "${APP_MOUNT[@]}" "${APP_SRC_ENV[@]}" \
  -e DEBIAN_FRONTEND=noninteractive \
  -e PKGROOT=/work/pkgroot \
  -e FILES=/work/files \
  -e DEBSRC=/work/debian \
  -e OUTDIR=/work/output \
  -e DRACHTIO_REPO="$DRACHTIO_REPO" \
  -e DRACHTIO_VERSION="$DRACHTIO_VERSION" \
  -e DISABLE_LICENSING="$DISABLE_LICENSING" \
  -e RTPENGINE_REPO="$RTPENGINE_REPO" \
  -e RTPENGINE_VERSION="$RTPENGINE_VERSION" \
  -e LWS_VERSION="$LWS_VERSION" \
  -e REDIS_VERSION="$REDIS_VERSION" \
  -e DRAGONPBX_REPO="$DRAGONPBX_REPO" \
  -e DRAGONPBX_VERSION="$DRAGONPBX_VERSION" \
  -e DEB_VERSION="$DEB_VERSION" \
  -e DEB_EPOCH="$DEB_EPOCH" \
  -e ARCH_DEB="$ARCH_DEB" \
  -w /work \
  "$IMAGE" bash -euo pipefail -c '
    rm -rf /work/pkgroot
    bash scripts/00-install-build-deps.sh
    bash scripts/10-build-drachtio.sh  "$DRACHTIO_REPO"  "$DRACHTIO_VERSION" "$DISABLE_LICENSING"
    bash scripts/20-build-rtpengine.sh "$RTPENGINE_REPO" "$RTPENGINE_VERSION" "$LWS_VERSION"
    bash scripts/30-stage-redis.sh
    bash scripts/40-stage-app.sh       "$DRAGONPBX_REPO" "$DRAGONPBX_VERSION"
    bash scripts/50-assemble-deb.sh    "$DEB_VERSION"    "$ARCH_DEB"        "$RTPENGINE_VERSION"
  '

echo "Done → output/dragonpbx_${DEB_VERSION}_${ARCH_DEB}.deb"
ls -lh "$PROJ_DIR/output/dragonpbx_${DEB_VERSION}_${ARCH_DEB}.deb"
