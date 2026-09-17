# dragonpbx-packer

Builds self-contained Debian packages for DragonPBX. Two independent packages, each installable on a
fresh Debian 12 (bookworm) amd64 box with no apt-repo access (beyond the OS toolchain the rtpengine
DKMS module needs to compile):

| Package | What it is | Build |
|---|---|---|
| **`dragonpbx`** | All-in-one SIP/media stack: drachtio-server, rtpengine, redis, and the DragonPBX call-control app — bundled with their systemd units | `./build-docker.sh` or Packer |
| **`dragonpbx-ui`** | The admin web UI / config API (Sails app on port 1337) that the call-control app reads | `cd ui && ./build-docker.sh` |

Both bundle a self-contained **Node.js runtime** and clone a **tagged release** of their app from
GitHub; the `.deb` version tracks the app's git tag. They're designed to run on the **same host**.

---

## `dragonpbx` — the all-in-one stack

One `.deb` that installs everything DragonPBX needs on one host:

- **drachtio-server** — SIP server (compiled from source)
- **rtpengine** — RTP media proxy + a **DKMS kernel module** that builds against the target's kernel
- **redis** — vendored as Debian `.deb`s, installed by a first-boot oneshot
- **DragonPBX app** — a tagged release of
  [github.com/sammachin/dragonpbx](https://github.com/sammachin/dragonpbx) (default `0.7.0`), Node bundled

### Build

Two interchangeable paths run the **same `scripts/00..50`** and produce the same `.deb`:

```bash
# Local (Docker, no AWS) — best for development
./build-docker.sh
# → output/dragonpbx_<app-tag>_amd64.deb   (amd64 via QEMU on Apple Silicon)

# Packer (AWS VM) — native amd64 speed, optional S3 publish
packer init dragonpbx-deb.pkr.hcl
packer build -var-file=dragonpbx.pkrvars.hcl -var ssh_keypair_name=KEY dragonpbx-deb.pkr.hcl
```

drachtio + rtpengine are compiled from source; redis is vendored; the app is cloned and Node bundled;
then `dpkg-deb --build`. The rtpengine **kernel module is built on the target by DKMS at install** —
not during the build — so neither path needs kernel access. Pin versions with `dragonpbx_version`
(app tag), `drachtio_version`, `rtpengine_version`; set `dragonpbx_version=local` to bundle a local
checkout. See **[BUILDING.md](BUILDING.md)** for the full reference.

### Install

```bash
sudo apt-get install -y ./dragonpbx_0.7.0_amd64.deb     # apt resolves deps + toolchain
sudo systemctl restart dragonpbx.target
systemctl is-active drachtio rtpengine redis-server dragonpbx
```

redis is installed by the `dragonpbx-firstboot` oneshot just after install (dpkg can't install debs
from inside its own run). Config lives in `/opt/dragonpbx/config/dragonpbx.env`.

---

## `dragonpbx-ui` — the admin UI / config API

A separate `.deb` for the Sails app at
[github.com/sammachin/dragonpbx-ui](https://github.com/sammachin/dragonpbx-ui) — Docker-built,
self-contained Node, on-disk datastore under `/var/lib/dragonpbx-ui`. Runs on the same host and
serves config on port 1337 (the main app's `CONFIG_URL`).

```bash
cd ui && ./build-docker.sh                  # → output/dragonpbx-ui_<tag>_amd64.deb
sudo apt-get install -y ./output/dragonpbx-ui_0.7.0_amd64.deb
```

See **[ui/README.md](ui/README.md)** for details.

---

## Wiring the two together

The UI is the config source the call-control app reads. After installing both on one host:

1. Create an API token in the UI (`http://<host>:1337/tokens`).
2. Set it as `CONFIG_TOKEN` in `/opt/dragonpbx/config/dragonpbx.env` (and confirm
   `CONFIG_URL=http://127.0.0.1:1337/api/v1/domains`).
3. `sudo systemctl restart dragonpbx`.

---

## Layout

```
dragonpbx-packer/
├── build-docker.sh            # dragonpbx: local build (Debian bookworm container)
├── dragonpbx-deb.pkr.hcl      # dragonpbx: Packer template (amazon-ebs + provisioners + harvest)
├── dragonpbx.pkrvars.hcl      # dragonpbx: version pins / app source
├── BUILDING.md                # full build/publish/troubleshooting reference
├── scripts/                   # dragonpbx build steps, run in order
│   ├── 00-install-build-deps.sh   30-stage-redis.sh
│   ├── 10-build-drachtio.sh       40-stage-app.sh
│   ├── 20-build-rtpengine.sh      50-assemble-deb.sh
├── debian/                    # dragonpbx DEBIAN metadata (control.tmpl, conffiles, postinst, prerm, postrm)
├── files/                     # dragonpbx systemd units + config + helpers
│   ├── drachtio.service              dragonpbx.service / dragonpbx.target
│   ├── rtpengine.service             dragonpbx-firstboot.service / -firstboot
│   ├── rtpengine-recording.service   dragonpbx-detect-ip
│   ├── drachtio.conf.xml             dragonpbx.env
│   └── rtpengine-recording.ini
├── ui/                        # dragonpbx-ui package (self-contained subproject)
│   ├── build-docker.sh
│   ├── scripts/{10-stage-ui.sh, 20-assemble-ui-deb.sh}
│   ├── debian/{control.tmpl, conffiles, postinst, prerm, postrm}
│   └── files/{dragonpbx-ui.service, dragonpbx-ui.env, zz-packaged-datastore.js}
└── output/                    # built .debs land here (both packages)
```

> **Apple Silicon:** the default amd64 build runs under QEMU emulation — correct output, slower
> compile. For native arm64 use `ARCH_DEB=arm64 PLATFORM=linux/arm64 ./build-docker.sh`; for native
> amd64 at speed use the Packer/AWS path.
