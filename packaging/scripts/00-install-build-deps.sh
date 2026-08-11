#!/bin/bash
#
# 00 — install the build toolchain and the dev libraries needed to compile
# drachtio-server and rtpengine from source, plus the DKMS bits the rtpengine
# kernel module needs. Also creates the shared package root used by later steps.
#
# Runs as root on the Debian 12 build VM.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

# Shared package root assembled by steps 10–50 and turned into the .deb in step 50.
# Overridable so the same scripts run under Packer (default) and Docker (/work/...).
: "${PKGROOT:=/tmp/dragonpbx-pkgroot}"
mkdir -p \
  "$PKGROOT/usr/bin" \
  "$PKGROOT/usr/local/lib" \
  "$PKGROOT/usr/local/bin" \
  "$PKGROOT/usr/src" \
  "$PKGROOT/etc/ld.so.conf.d" \
  "$PKGROOT/etc/modules-load.d" \
  "$PKGROOT/lib/systemd/system" \
  "$PKGROOT/opt/dragonpbx" \
  "$PKGROOT/var/log/drachtio" \
  "$PKGROOT/var/spool/recording"

apt-get update

# Common toolchain.
apt-get install -y --no-install-recommends \
  build-essential gcc g++ make cmake git autoconf automake libtool libtool-bin \
  pkg-config ca-certificates curl wget gnupg2 yasm fakeroot dpkg-dev dkms

# Kernel headers are only needed to compile the rtpengine kernel module, which we
# do NOT do at build time — DKMS builds it on the target at install. On a VM the
# running-kernel headers exist; inside a container (Docker Desktop's LinuxKit
# kernel) they don't, so this is best-effort and never fatal.
apt-get install -y --no-install-recommends "linux-headers-$(uname -r)" 2>/dev/null \
  || apt-get install -y --no-install-recommends linux-headers-amd64 2>/dev/null \
  || echo "NOTE: skipping kernel headers (not needed for the build; DKMS builds on target)"

# drachtio-server build deps.
apt-get install -y --no-install-recommends \
  libssl-dev libcurl4-openssl-dev zlib1g-dev libboost-all-dev \
  libgoogle-perftools-dev

# rtpengine build deps (transcoding + kernel module + websocket interface).
apt-get install -y --no-install-recommends \
  libavformat-dev libavfilter-dev libavcodec-dev libavutil-dev \
  libswresample-dev libswscale-dev libevent-dev libpcap-dev \
  libxmlrpc-core-c3-dev libjson-glib-dev libhiredis-dev libpcre3-dev \
  libxtables-dev libip6tc-dev libip4tc-dev libiptc-dev libmnl-dev libnftnl-dev \
  nftables libspandsp-dev gperf libspeex-dev libspeexdsp-dev libedit-dev \
  libtiff-dev libopus-dev libsndfile1-dev libmp3lame-dev libopusfile-dev \
  libsqlite3-dev libjpeg-dev libev-dev markdown pandoc \
  default-libmysqlclient-dev default-mysql-client

chmod a+w /usr/local/src
git config --global advice.detachedHead false

echo "Build dependencies installed; package root at $PKGROOT"
