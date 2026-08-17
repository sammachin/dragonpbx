#!/bin/bash
#
# 50 — assemble the package: drop in systemd units + config, write the DEBIAN
# control metadata (with auto-computed shared-library deps), and build the .deb
# with dpkg-deb. Mirrors the static-tree approach jb10_packer uses to harvest
# the FreeSWITCH deb.
#
# Args: <deb_version> <arch> <rtpengine_version>
set -euo pipefail

DEB_VERSION="$1"
ARCH="$2"
RTP_VERSION="$3"

: "${PKGROOT:=/tmp/dragonpbx-pkgroot}"
: "${FILES:=/tmp/dragonpbx-files}"
: "${DEBSRC:=/tmp/dragonpbx-debian}"
: "${OUTDIR:=/tmp}"
# Version epoch: the deb version tracks the app tag (0.7.x), but earlier builds
# shipped 1.0.x. An epoch makes 1:0.7.0 sort ABOVE 1.0.x so apt upgrades cleanly.
# The epoch lives only in the control Version, not the filename.
: "${DEB_EPOCH:=1}"

# Default the package version to the staged app version (package.json).
if [ -z "$DEB_VERSION" ] && [ -f "$PKGROOT/opt/dragonpbx/app/package.json" ]; then
  DEB_VERSION="$(sed -nE 's/.*"version" *: *"([^"]+)".*/\1/p' "$PKGROOT/opt/dragonpbx/app/package.json" | head -1)"
fi
[ -n "$DEB_VERSION" ] || { echo "ERROR: no deb version given and none derivable from package.json"; exit 1; }
CONTROL_VERSION="${DEB_EPOCH:+${DEB_EPOCH}:}${DEB_VERSION}"

# --- systemd units + helper + config -------------------------------------
install -D -m 0644 "$FILES/drachtio.service"           "$PKGROOT/lib/systemd/system/drachtio.service"
install -D -m 0644 "$FILES/rtpengine.service"          "$PKGROOT/lib/systemd/system/rtpengine.service"
install -D -m 0644 "$FILES/rtpengine-recording.service" "$PKGROOT/lib/systemd/system/rtpengine-recording.service"
install -D -m 0644 "$FILES/dragonpbx.target"           "$PKGROOT/lib/systemd/system/dragonpbx.target"
install -D -m 0644 "$FILES/dragonpbx.service"          "$PKGROOT/lib/systemd/system/dragonpbx.service"
install -D -m 0755 "$FILES/dragonpbx-detect-ip"        "$PKGROOT/usr/local/bin/dragonpbx-detect-ip"
install -D -m 0755 "$FILES/dragonpbx-firstboot"        "$PKGROOT/usr/local/bin/dragonpbx-firstboot"
install -D -m 0644 "$FILES/dragonpbx-firstboot.service" "$PKGROOT/lib/systemd/system/dragonpbx-firstboot.service"
install -D -m 0644 "$FILES/rtpengine-recording.ini"    "$PKGROOT/etc/rtpengine-recording.ini"
# Always (re)install our drachtio.conf.xml from files/ so config edits land
# without needing to re-run step 10 (which recompiles drachtio).
install -D -m 0644 "$FILES/drachtio.conf.xml" "$PKGROOT/etc/drachtio.conf.xml"

# --- DEBIAN control scripts ------------------------------------------------
mkdir -p "$PKGROOT/DEBIAN"
install -m 0644 "$DEBSRC/conffiles" "$PKGROOT/DEBIAN/conffiles"
install -m 0755 "$DEBSRC/postinst"  "$PKGROOT/DEBIAN/postinst"
install -m 0755 "$DEBSRC/prerm"     "$PKGROOT/DEBIAN/prerm"
install -m 0755 "$DEBSRC/postrm"    "$PKGROOT/DEBIAN/postrm"

# --- compute runtime shared-library deps from the staged binaries ----------
# dpkg-shlibdeps needs a debian/ context; the bundled /usr/local/lib .so files
# (bcg729, libwebsockets) have no owning package, so ignore missing info.
SHLIBDIR=/tmp/dragonpbx-shlibdeps
rm -rf "$SHLIBDIR"; mkdir -p "$SHLIBDIR/debian"
cat > "$SHLIBDIR/debian/control" <<CTL
Source: dragonpbx
Package: dragonpbx
Architecture: $ARCH
Depends: \${shlibs:Depends}
CTL
: > "$SHLIBDIR/debian/substvars"

SHLIB_DEPS="$(cd "$SHLIBDIR" && \
  LD_LIBRARY_PATH="$PKGROOT/usr/local/lib" dpkg-shlibdeps -O --ignore-missing-info \
    "$PKGROOT/usr/bin/drachtio" \
    "$PKGROOT/usr/bin/rtpengine" \
    "$PKGROOT/usr/bin/rtpengine-recording" 2>/dev/null \
  | sed -e 's/^shlibs:Depends=//')"

# Kernel-headers dep for the rtpengine DKMS module — architecture-specific.
# On arm64 we offer alternatives so the package installs on both Raspberry Pi OS
# (raspberrypi-kernel-headers, listed first so the Pi kernel's own headers win)
# and generic Debian/arm64 servers (linux-headers-arm64). The DKMS build is
# best-effort anyway — the postinst falls back to userspace rtpengine if the
# module can't be built.
case "$ARCH" in
  amd64) HDR_DEP="linux-headers-amd64" ;;
  arm64) HDR_DEP="raspberrypi-kernel-headers | linux-headers-arm64 | linux-headers-generic" ;;
  *)     HDR_DEP="linux-headers-generic" ;;
esac

# Base deps: rtpengine kernel-module DKMS toolchain + helpers + rtpengine-ctl (perl).
BASE_DEPS="adduser, dkms, gcc, make, perl, libconfig-tiny-perl, ${HDR_DEP}"
if [ -n "$SHLIB_DEPS" ]; then
  ALL_DEPS="${SHLIB_DEPS}, ${BASE_DEPS}"
else
  ALL_DEPS="${BASE_DEPS}"
fi
echo "Computed Depends: $ALL_DEPS"

INSTALLED_SIZE="$(du -sk "$PKGROOT" | cut -f1)"

# --- render control --------------------------------------------------------
# NB: the Depends value can itself contain '|' (arm64 kernel-headers alternatives,
# e.g. "raspberrypi-kernel-headers | linux-headers-arm64"), so the substitution
# uses a SOH (\001) delimiter that can never appear in a Debian control field.
SEP=$'\001'
sed -e "s/__VERSION__/${CONTROL_VERSION}/" \
    -e "s/__ARCH__/${ARCH}/" \
    -e "s/__INSTALLED_SIZE__/${INSTALLED_SIZE}/" \
    -e "s${SEP}__DEPENDS__${SEP}${ALL_DEPS}${SEP}" \
    "$DEBSRC/control.tmpl" > "$PKGROOT/DEBIAN/control"

echo "=== DEBIAN/control ==="
cat "$PKGROOT/DEBIAN/control"

# --- build -----------------------------------------------------------------
mkdir -p "$OUTDIR"
OUT="${OUTDIR}/dragonpbx_${DEB_VERSION}_${ARCH}.deb"
dpkg-deb --build --root-owner-group "$PKGROOT" "$OUT"
chown "$(id -un)":"$(id -gn)" "$OUT" 2>/dev/null || true
ls -lh "$OUT"
echo "Built $OUT"
