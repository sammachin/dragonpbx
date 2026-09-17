#!/bin/bash
#
# 30 — vendor redis (and deps) as .deb files inside the package, installed
# offline by the dragonpbx-firstboot oneshot at install time.
#
# Debian bookworm only ships redis 7.0.x; DragonPBX needs >= 7.4 (HEXPIRE /
# hash-field TTLs), so we pull from the official Redis apt repo. Those packages
# carry epoch 6: (> Debian's 5:), so they upgrade a previously-installed Debian
# redis cleanly.
#
# Arg/env: REDIS_VERSION — version prefix to pin (default 7.4); empty = latest.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

: "${PKGROOT:=/tmp/dragonpbx-pkgroot}"
REDIS_VERSION="${1:-${REDIS_VERSION:-7.4}}"

VENDOR="$PKGROOT/opt/dragonpbx/vendor/redis"
rm -rf "$VENDOR"; mkdir -p "$VENDOR"

apt-get update
apt-get install -y --no-install-recommends curl gpg ca-certificates

# Add the official Redis apt repo.
install -d /etc/apt/keyrings
curl -fsSL https://packages.redis.io/gpg | gpg --dearmor -o /etc/apt/keyrings/redis.gpg
echo "deb [signed-by=/etc/apt/keyrings/redis.gpg] https://packages.redis.io/deb bookworm main" \
  > /etc/apt/sources.list.d/redis.list
apt-get update

# Resolve the exact version to pin (newest matching the prefix), or latest.
if [ -n "$REDIS_VERSION" ]; then
  # NB: consume all of madison's output (no awk `exit`/`head`) — closing the pipe
  # early makes apt-cache exit with SIGPIPE, which `set -o pipefail` would treat
  # as a failure. madison lists newest first, so take the first matching version.
  VER="$(apt-cache madison redis-server | awk -v p="$REDIS_VERSION" 'f==0 && $3 ~ ("(^|:)" p "\\.") {print $3; f=1}')"
  [ -n "$VER" ] || { echo "ERROR: no redis-server matching '$REDIS_VERSION' in the Redis repo"; exit 1; }
  # redis-server Depends: redis-tools (= same version), so pin both — pinning only
  # the server makes apt pull the latest redis-tools and fail to resolve.
  SPEC="redis-server=$VER redis-tools=$VER"
else
  SPEC="redis-server"
fi
echo "Vendoring redis: $SPEC"

# Download redis-server + matching redis-tools + any deps not already in base Debian.
PKGS=$(apt-get install --no-install-recommends --yes --print-uris $SPEC \
        | awk -F\' '/\.deb/ {print $2}')

cd "$VENDOR"
for url in $PKGS; do
  echo "Fetching $(basename "$url")"
  curl -fsSL -O "$url"
done

echo "Vendored redis debs:"
ls -l "$VENDOR"