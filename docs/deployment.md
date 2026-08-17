# Deployment

The supported way to run DragonPBX in production is the **Debian package**. It bundles
drachtio-server, rtpengine (with a DKMS kernel module built on the target), a self-contained
Node.js runtime, vendored redis, and the DragonPBX app — plus systemd units to run them together.
Installing the package on a fresh Debian host gives you a complete single-host PBX.

For running from source during development, see [the README](../README.md#development-from-source).

## Packages

Deployment uses two independent packages, designed to run on the **same host**:

| Package | What it is | Installs to | Service |
|---|---|---|---|
| **`dragonpbx`** | All-in-one SIP/media stack: drachtio, rtpengine, redis, and the call-control app | `/opt/dragonpbx` | `dragonpbx.target` |
| **`dragonpbx-ui`** | Admin web UI / configuration API (Sails app, port 1337) that serves domain/trunk config to the app | `/opt/dragonpbx-ui` | `dragonpbx-ui.service` |

Each package is published on its repo's **GitHub Release** for a tag, built for a matrix of
Debian releases and architectures. Pick the file matching your host:

```
dragonpbx_<version>+<codename>_<arch>.deb
```

- **codename** — `bookworm` (Debian 12) or `trixie` (Debian 13). Must match your OS release, because
  the package's shared-library dependencies (ffmpeg, boost, hiredis, …) are pinned to that release.
- **arch** — `amd64` (Intel/AMD servers) or `arm64` (64-bit ARM servers **and Raspberry Pi 5**).

> **Raspberry Pi 5:** Raspberry Pi OS is Debian-based. On a Pi 5 running the 64-bit OS, use the
> `+trixie_arm64` build (or `+bookworm_arm64` on the older OS). There is no separate Pi package.

To identify the right file on the target host:

```bash
. /etc/os-release; echo "$VERSION_CODENAME"   # bookworm | trixie
dpkg --print-architecture                     # amd64 | arm64
```

## Install

Download the two matching `.deb` files from the GitHub Releases, then, on the host:

```bash
# 1. The all-in-one stack (apt resolves the system dependencies)
sudo apt install -y ./dragonpbx_<version>+<codename>_<arch>.deb

# 2. The admin UI / config API
sudo apt install -y ./dragonpbx-ui_<version>+<codename>_<arch>.deb
```

`apt install ./file.deb` (rather than `dpkg -i`) is important — it pulls in the runtime
dependencies. On install the `dragonpbx` package:

- creates the `dragonpbx` service account and directories,
- builds the rtpengine kernel module against the running kernel via DKMS (falls back to userspace
  rtpengine if kernel headers aren't available — fine for small deployments),
- installs the vendored redis on first boot via the `dragonpbx-firstboot` oneshot,
- enables and starts the systemd units.

Verify:

```bash
systemctl status dragonpbx.target --no-pager
systemctl is-active drachtio rtpengine redis-server dragonpbx
systemctl status dragonpbx-ui --no-pager
```

## Where configuration is stored

There are two layers of configuration: **runtime settings** (environment files) and the
**domain/client/trunk data** (the config backend).

### Runtime settings — environment conffiles

Both packages read their settings from an environment file under `/opt`. These are dpkg
**conffiles**, so your edits are preserved across package upgrades:

| File | Used by | Holds |
|---|---|---|
| `/opt/dragonpbx/config/dragonpbx.env` | `dragonpbx.service` (and the drachtio/rtpengine units) | drachtio/rtpengine/redis connection, HTTP port, log level, data-source selection, networking (`LOCAL_IP`/`PUBLIC_IP`) |
| `/opt/dragonpbx-ui/config/dragonpbx-ui.env` | `dragonpbx-ui.service` | UI `PORT` (1337), bind `HOST`, datastore dir, websocket origins |

After editing either file, restart the affected service:

```bash
sudoedit /opt/dragonpbx/config/dragonpbx.env
sudo systemctl restart dragonpbx.target      # or: systemctl restart dragonpbx-ui
```

See [configuration.md](configuration.md) for every variable and its default.

### Domain / client / trunk data — the config backend

*What* domains, clients and trunks exist is separate from the env file, and comes from the
`DATA_SOURCE` selected in `/opt/dragonpbx/config/dragonpbx.env`:

- **`api`** (the package default) — the app fetches config over HTTP from `CONFIG_URL`
  (`http://127.0.0.1:1337/api/v1/domains`), i.e. from the **`dragonpbx-ui` package**. The UI stores
  the data in an on-disk datastore at **`/var/lib/dragonpbx-ui/db`** (outside the app dir, so
  upgrades don't wipe it). You manage domains/trunks in the UI, and mint an API token there.
- **`json`** — read from a local `config.json` (simplest for development; see
  [data_sources.md](data_sources.md)).
- **`pg`** — a PostgreSQL database.

**Tie the app to the UI:** create an API token in the UI (`/tokens`) and set it as `CONFIG_TOKEN`
in `/opt/dragonpbx/config/dragonpbx.env`, then `systemctl restart dragonpbx`.

### Other config paths (dragonpbx package)

| Path | Purpose |
|---|---|
| `/etc/drachtio.conf.xml` | drachtio-server config (conffile) |
| `/etc/rtpengine-recording.ini` | rtpengine recording daemon config |
| `/var/log/drachtio/` | drachtio logs |
| `/var/spool/recording/` | call recordings |
| `/run/dragonpbx/network.env` | auto-detected `LOCAL_IP`/`PUBLIC_IP` (regenerated at each start) |

## Service management

The `dragonpbx` units are grouped under `dragonpbx.target`:

```bash
systemctl restart dragonpbx.target        # drachtio + rtpengine + app together
journalctl -u dragonpbx -f                 # app logs
journalctl -u drachtio -u rtpengine -f     # SIP / media logs
```

The UI is a standalone service:

```bash
systemctl restart dragonpbx-ui
journalctl -u dragonpbx-ui -f
```

## HTTPS / nginx (UI)

The `dragonpbx-ui` package depends on **nginx** and installs a reverse-proxy site for port 1337 at
`/etc/nginx/sites-available/dragonpbx-ui`. To enable TLS:

```bash
sudoedit /etc/nginx/sites-available/dragonpbx-ui     # set server_name to your FQDN
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d pbx.example.com              # adds the :443 block + cert
# then lock websocket origins to the TLS host:
echo 'DRAGONPBX_UI_ORIGINS=https://pbx.example.com' | sudo tee -a /opt/dragonpbx-ui/config/dragonpbx-ui.env
sudo systemctl restart dragonpbx-ui
```

## Upgrades

Install the newer `.deb` the same way (`sudo apt install ./…`). The env conffiles above and the UI
datastore at `/var/lib/dragonpbx-ui/db` are preserved. If dpkg detects you've edited a conffile that
the new package also changed, it prompts you to keep or replace it.

## Building the packages

The packages are built automatically by GitHub Actions on each release tag (see
`.github/workflows/build-deb.yml` in each repo) and can also be built locally with Docker — see
[`packaging/README.md`](../packaging/README.md) and [`packaging/BUILDING.md`](../packaging/BUILDING.md).
