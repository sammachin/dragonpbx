#!/bin/bash
#
# 20 — compile rtpengine (+ bcg729 and libwebsockets) from source, stage the
# daemon binaries and the bundled shared libs, and stage the kernel-module
# source as a DKMS tree so it builds against the target's kernel at install.
#
# Adapted from jb10_packer/scripts/install_rtpengine.sh (build half).
#
# Args: <repo_url> <version> <libwebsockets_version>
set -euo pipefail

REPO="$1"
VERSION="$2"
LWS_VERSION="${3:-v4.3.3}"

: "${PKGROOT:=/tmp/dragonpbx-pkgroot}"

export PATH=/usr/local/bin:$PATH
export LD_LIBRARY_PATH=/usr/local/lib:${LD_LIBRARY_PATH:-}
export PKG_CONFIG_PATH=/usr/local/lib/pkgconfig:${PKG_CONFIG_PATH:-}


# DKMS-safe module version: strip a leading 'mr' or 'v' from the tag.
MODVER="$(echo "$VERSION" | sed -e 's/^mr//' -e 's/^v//')"

cd /usr/local/src

# --- bcg729 (G.729 transcoding) ---
if [ ! -d bcg729 ]; then
  git clone https://github.com/BelledonneCommunications/bcg729.git
fi
cd bcg729
cmake . -DCMAKE_INSTALL_PREFIX=/usr/local -DCMAKE_C_FLAGS="-fPIC -fPIE"
make -j"$(nproc)"
make install
ldconfig
cd /usr/local/src

# --- libwebsockets (websocket interface) ---
# NOTE: jb10_packer patches lib/roles/ws/ops-ws.c for a bidirectional-streaming
# fix; we build stock here. Re-add the patch if you hit that issue.
if [ ! -d libwebsockets ]; then
  git clone https://github.com/warmcat/libwebsockets.git -b "$LWS_VERSION"
  cd libwebsockets
  mkdir -p build && cd build
  cmake .. -DCMAKE_BUILD_TYPE=RelWithDebInfo -DLWS_WITH_NETLINK=OFF -DLWS_WITH_LIBEV=1
  make -j"$(nproc)"
  make install
  ldconfig
fi
cd /usr/local/src

# --- rtpengine ---
rm -rf rtpengine
git clone "$REPO" -b "$VERSION" rtpengine
cd rtpengine

# rtpengine hardcodes -flto=auto in utils/gen-common-flags (baked into the
# generated config.mk). LTO's parallel link uses a GNU make jobserver that is
# broken under QEMU emulation ("write jobserver: Bad file descriptor"), so the
# final link fails on an emulated amd64 build. Strip only the LTO fragments;
# -O3 and all hardening/optimisation flags are kept, so the binary is otherwise
# identical. Harmless on native builds too.
sed -i -e 's/ -flto=auto -ffat-lto-objects//' -e 's/ -flto=auto//' utils/gen-common-flags

make -j"$(nproc)" with_transcoding=yes with_iptables_option=no

# Stage daemon binaries.
install -D -m 0755 daemon/rtpengine                     "$PKGROOT/usr/bin/rtpengine"
install -D -m 0755 utils/rtpengine-ctl                  "$PKGROOT/usr/bin/rtpengine-ctl"
install -D -m 0755 recording-daemon/rtpengine-recording "$PKGROOT/usr/bin/rtpengine-recording"

# Bundle the from-source shared libs the daemon links against (not in Debian repos).
cp -a /usr/local/lib/libbcg729.so*      "$PKGROOT/usr/local/lib/" 2>/dev/null || true
cp -a /usr/local/lib/libwebsockets.so*  "$PKGROOT/usr/local/lib/" 2>/dev/null || true
echo "/usr/local/lib" > "$PKGROOT/etc/ld.so.conf.d/dragonpbx.conf"

# Stage the kernel-module source as a DKMS tree (built on the target's kernel).
DKMS_SRC="$PKGROOT/usr/src/rtpengine-${MODVER}"
mkdir -p "$DKMS_SRC"
cp -a kernel-module/* "$DKMS_SRC/"
cat > "$DKMS_SRC/dkms.conf" <<DKMS
PACKAGE_NAME="rtpengine"
PACKAGE_VERSION="${MODVER}"
BUILT_MODULE_NAME[0]="xt_RTPENGINE"
DEST_MODULE_LOCATION[0]="/updates"
AUTOINSTALL="yes"
MAKE[0]="make"
CLEAN="make clean"
DKMS

# Load the module at boot.
echo "xt_RTPENGINE" > "$PKGROOT/etc/modules-load.d/rtpengine.conf"

# Record the module version for the postinst (dkms add/build/install) to read.
mkdir -p "$PKGROOT/opt/dragonpbx"
echo "$MODVER" > "$PKGROOT/opt/dragonpbx/rtpengine-modver"

echo "rtpengine staged (module version ${MODVER}):"
ls -l "$PKGROOT/usr/bin/rtpengine"* "$PKGROOT/usr/local/lib/" "$DKMS_SRC/dkms.conf"
