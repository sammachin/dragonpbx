#!/bin/bash
#
# 10 — compile drachtio-server from source and stage it into the package root.
# Adapted from jb10_packer/scripts/install_drachtio.sh (build half only; the
# systemd/cloud placement is handled by our own units in step 50).
#
# Args: <repo_url> <version> <disable_licensing:yes|no>
set -euo pipefail

REPO="$1"
VERSION="$2"
DISABLE_LICENSING="${3:-no}"

: "${PKGROOT:=/tmp/dragonpbx-pkgroot}"
: "${FILES:=/tmp/dragonpbx-files}"

export PATH=/usr/local/bin:$PATH
export LD_LIBRARY_PATH=/usr/local/lib:/usr/local/lib64:${LD_LIBRARY_PATH:-}

echo "Building drachtio-server v${VERSION} from ${REPO}"

cd /usr/local/src
rm -rf drachtio-server
git clone "$REPO" -b "v${VERSION}" drachtio-server
cd drachtio-server
git submodule update --init --recursive

./autogen.sh
mkdir -p build && cd build

CPPFLAGS_VAL='-DNDEBUG'
if [ "$DISABLE_LICENSING" = "yes" ]; then
  CPPFLAGS_VAL="${CPPFLAGS_VAL} -DDISABLE_LICENSING=1"
  echo "Building drachtio with DISABLE_LICENSING=1"
fi

../configure --prefix=/usr --enable-tcmalloc=yes CXXFLAGS='-g -O2' CPPFLAGS="${CPPFLAGS_VAL}"
make -j"$(nproc)"

# Stage into the package root rather than installing onto the build VM.
make install DESTDIR="$PKGROOT"

# Default drachtio config — drachtio looks for /etc/drachtio.conf.xml.
install -D -m 0644 "$FILES/drachtio.conf.xml" "$PKGROOT/etc/drachtio.conf.xml"

echo "drachtio staged:"
ls -l "$PKGROOT/usr/bin/drachtio"
