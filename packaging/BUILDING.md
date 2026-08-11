# Building the DragonPBX `.deb`

Developer/maintainer doc for the single self-contained `dragonpbx_<version>_amd64.deb`.

## What it produces

One Debian package that, on a fresh Debian 12 (bookworm) amd64 host, installs:

- **drachtio-server** → `/usr/bin/drachtio` (+ `/etc/drachtio.conf.xml`)
- **rtpengine** → `/usr/bin/rtpengine{,-ctl,-recording}`, bundled `bcg729`/`libwebsockets` in
  `/usr/local/lib`, and a **DKMS kernel-module** source tree in `/usr/src/rtpengine-<ver>/`
- **redis** → vendored `.deb`s under `/opt/dragonpbx/vendor/redis/`, installed by the postinst
- **DragonPBX app/config** → `/opt/dragonpbx/{app,config}`
- systemd units: `drachtio.service`, `rtpengine.service`, `rtpengine-recording.service`,
  `dragonpbx.target`

## Two ways to build

| Path | Needs | Notes |
|---|---|---|
| **Docker (local)** | Docker Desktop only | `./build-docker.sh` — no AWS. Best for dev/iteration. On Apple Silicon the amd64 build runs under QEMU emulation. |
| **Packer (AWS VM)** | AWS creds + EC2 keypair | `packer build ...` — compiles on a real EC2 instance, native amd64 speed, optional S3 publish. |

Both run the **same `scripts/00..50`** against the same package root, so the resulting `.deb` is
identical. Pick whichever fits.

## Build locally with Docker (no AWS)

```bash
./build-docker.sh
# → output/dragonpbx_0.7.0_amd64.deb   (filename tracks the app version)
```

The rtpengine **kernel module is not compiled here** — only the userspace daemons are. DKMS builds
the module on the target host at install time, so the container needs no kernel access.

Override anything via env:

```bash
DRAGONPBX_VERSION=0.7.0 \
DRACHTIO_VERSION=0.9.8 \
RTPENGINE_VERSION=mr12.5.1.48 \
./build-docker.sh

# Native arm64 build (fast, if your target is arm64):
ARCH_DEB=arm64 PLATFORM=linux/arm64 ./build-docker.sh
```

What it does: bind-mounts the project at `/work`, mounts the app/config layer
(`../dragonpbx`, override with `APP_PATH=`) read-only, then runs the scripts in a `debian:bookworm`
container with `PKGROOT=/work/pkgroot` and `OUTDIR=/work/output`.

> **Apple Silicon note:** compiling drachtio + rtpengine + libwebsockets under amd64 emulation is
> slow (tens of minutes). For quick iteration, build `arm64` natively, or use the Packer/AWS path
> for production amd64 artifacts.

## Prerequisites (Packer/AWS path)

| | |
|---|---|
| **Packer** | `brew install packer` (or HashiCorp apt repo). Then `packer init dragonpbx-deb.pkr.hcl`. |
| **AWS** | Credentials in the environment (`aws configure` / `AWS_PROFILE`). The build launches a `c6in.xlarge` Debian 12 EC2 instance in `region`. |
| **SSH** | An EC2 keypair (`-var ssh_keypair_name=...`) whose private key is loaded in your `ssh-agent` (the source uses `ssh_agent_auth`). |
| **DragonPBX app** | The app/config layer at `../dragonpbx` (override with `-var dragonpbx_app_path=...`). |

## Quick start

```bash
packer init dragonpbx-deb.pkr.hcl
packer build -var-file=dragonpbx.pkrvars.hcl \
  -var ssh_keypair_name=YOUR_KEYPAIR \
  dragonpbx-deb.pkr.hcl
# → output/dragonpbx_0.7.0_amd64.deb
```

`packer validate` (no AWS needed) checks the template parses:

```bash
packer validate -var-file=dragonpbx.pkrvars.hcl dragonpbx-deb.pkr.hcl
```

## What the build does (on the VM)

The provisioner chain runs the numbered scripts in `scripts/` against a shared package root
(`/tmp/dragonpbx-pkgroot`):

| Step | Script | Action |
|---|---|---|
| 00 | `00-install-build-deps.sh` | toolchain, kernel headers, dkms, codec/media dev libs |
| 10 | `10-build-drachtio.sh` | clone + compile drachtio, `make install DESTDIR=$PKGROOT` |
| 20 | `20-build-rtpengine.sh` | compile bcg729 + libwebsockets + rtpengine; stage daemon bins, bundled `.so`s, and DKMS module source |
| 30 | `30-stage-redis.sh` | `--print-uris` resolve + download redis-server's `.deb` closure |
| 40 | `40-stage-app.sh` | copy `../dragonpbx`; `npm ci` if `app/package.json` exists |
| 50 | `50-assemble-deb.sh` | write systemd units + DEBIAN metadata (auto `dpkg-shlibdeps`), `dpkg-deb --build` |

Then a `file` provisioner downloads `/tmp/dragonpbx_<ver>_amd64.deb` into `output/`.

## Version pinning

Edit `dragonpbx.pkrvars.hcl` or override on the CLI:

| Var | Default | Meaning |
|---|---|---|
| `deb_version` | _(empty)_ | package version; empty tracks `dragonpbx_version`, set e.g. `0.7.0-2` for a packaging-only revision |
| `drachtio_version` | `0.9.8` | tag `v<version>` on `drachtio_repo` (github.com/drachtio/drachtio-server) |
| `rtpengine_version` | `mr12.5.1.48` | tag/branch on `rtpengine_repo` |
| `disable_licensing` | `no` | compile drachtio with `-DDISABLE_LICENSING=1` |
| `dragonpbx_repo` | `github.com/sammachin/dragonpbx.git` | DragonPBX app git repo |
| `dragonpbx_version` | `0.7.0` | DragonPBX app git **tag/branch** to bundle, or `local` |
| `dragonpbx_app_path` | `../dragonpbx/app` | local app checkout (only when `dragonpbx_version=local`) |

### DragonPBX app source

By default the build **clones a tagged release** of the app from `dragonpbx_repo` (tags are bare,
e.g. `0.7.0`) and bundles a self-contained Node runtime — the target needs no system Node.

```bash
# Packer: pin the app release
packer build -var dragonpbx_version=0.7.0 -var ssh_keypair_name=KEY ... dragonpbx-deb.pkr.hcl

# Docker (local): pin the app release (deb version tracks it → dragonpbx_0.7.0_amd64.deb)
DRAGONPBX_VERSION=0.7.0 ./build-docker.sh

# Use a local checkout instead of git (root must contain package.json):
DRAGONPBX_VERSION=local APP_PATH=../dragonpbx/app ./build-docker.sh
```

The app's config env (`dragonpbx.env`) is **not** in the app repo — it's maintained here at
[`files/dragonpbx.env`](files/dragonpbx.env) and installed to `/opt/dragonpbx/config/dragonpbx.env`
(a dpkg conffile).

> The jambonz fork pins rtpengine to a `*-jambonz*` tag. For parity, set
> `-var rtpengine_repo=https://github.com/jambonz/rtpengine.git -var rtpengine_version=<tag>`.

## Publishing (optional)

Off by default. To upload the harvested `.deb` to S3 after a build:

```bash
packer build -var-file=dragonpbx.pkrvars.hcl \
  -var ssh_keypair_name=YOUR_KEYPAIR \
  -var publish_s3=yes -var s3_bucket=your-bucket -var s3_prefix=dragonpbx/ \
  dragonpbx-deb.pkr.hcl
```

## Installing + verifying (on a fresh Debian 12 box)

```bash
sudo apt-get update
sudo apt-get install -y ./dragonpbx_0.7.0_amd64.deb   # apt resolves declared deps + toolchain

systemctl is-active drachtio rtpengine redis-server   # all active
dkms status | grep rtpengine                          # built against running kernel
lsmod | grep -i rtpengine                              # module loaded (kernel-accelerated)
redis-cli ping                                         # PONG
drachtio -v ; rtpengine --version
```

**redis is installed on first boot, not during `dpkg`.** dpkg is non-reentrant, so the postinst
cannot `dpkg -i` the vendored redis debs while its own transaction holds the lock. Instead the
package ships `dragonpbx-firstboot.service` (a oneshot), enabled at install and kicked off
`--no-block`; it installs `/opt/dragonpbx/vendor/redis/*.deb` offline once the lock is free, then
stamps `/opt/dragonpbx/.redis-installed` so it never repeats. On a freshly-installed host redis is
up within seconds of the install (or at next boot). To force it immediately:
`sudo systemctl start dragonpbx-firstboot.service`.

If the DKMS build is skipped (no matching `linux-headers-$(uname -r)`), rtpengine still runs in
userspace; install headers and re-run the `dkms install` line the postinst prints.

## Troubleshooting

- **rtpengine won't link at runtime** — the bundled `bcg729`/`libwebsockets` live in `/usr/local/lib`;
  the package ships `/etc/ld.so.conf.d/dragonpbx.conf` and the postinst runs `ldconfig`. Re-run
  `sudo ldconfig` if you moved them.
- **DKMS build fails** — install `linux-headers-$(uname -r)` (or `linux-headers-amd64`) and
  `dkms install -m rtpengine -v <ver> -k $(uname -r)`.
- **`packer build` can't find the AMI** — check `region` and that the Debian 12 AMI owner
  (`ami_base_image_owner`, default `136693071363`) is correct for that region.
- **`output/` empty** — confirm the VM produced `/tmp/dragonpbx_<ver>_amd64.deb` (build log, step 50).
