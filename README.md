# DragonPBX

A programmable SIP PBX built on [Drachtio SRF](https://drachtio.org). DragonPBX operates as a B2BUA (Back-to-Back User Agent) that delegates call routing decisions to external HTTP webhooks, making call logic fully programmable without modifying the PBX itself.

## How It Works

SIP clients and trunks connect to DragonPBX. When a call arrives, the system authenticates the source, looks up a matching dialplan entry, and fetches a **CallScript** from an external **CallHook** URL. The CallScript is a JSON array of verbs (`connect`, `announce`, `response`, `pause`) that DragonPBX executes sequentially to handle the call.

Media is relayed through [RTPEngine](https://github.com/sipwise/rtpengine) for codec transcoding and RTP proxying.

## Deployment (Debian package)

The supported way to run DragonPBX in production is the **Debian package**, which bundles everything
DragonPBX needs on a single host — drachtio-server, rtpengine, a self-contained Node.js runtime,
vendored redis, and the app, wired together with systemd units. A companion **`dragonpbx-ui`**
package provides the admin web UI / configuration API.

Packages are published on the [GitHub Releases](https://github.com/sammachin/dragonpbx/releases) for
each tag, built for Debian **bookworm** (12) and **trixie** (13) on **amd64** and **arm64** (the
`arm64` build also runs on a **Raspberry Pi 5** with 64-bit Raspberry Pi OS). Pick the file matching
your host's release and architecture:

```bash
# on the target host, identify the right file:
. /etc/os-release; echo "$VERSION_CODENAME"   # bookworm | trixie
dpkg --print-architecture                     # amd64 | arm64

# install the all-in-one stack, then the admin UI (apt resolves dependencies):
sudo apt install -y ./dragonpbx_<version>+<codename>_<arch>.deb
sudo apt install -y ./dragonpbx-ui_<version>+<codename>_<arch>.deb
```

Runtime configuration lives in environment conffiles that survive upgrades —
`/opt/dragonpbx/config/dragonpbx.env` for the stack and `/opt/dragonpbx-ui/config/dragonpbx-ui.env`
for the UI. **See [docs/deployment.md](docs/deployment.md)** for the full install guide, the file
layout, where configuration is stored, service management, TLS, and upgrades.

## Development (from source)

For local development you can run the app directly against your own drachtio / rtpengine / redis.

Prerequisites: **Node.js**, **[Drachtio](https://drachtio.org)** (SIP signaling),
**[RTPEngine](https://github.com/sipwise/rtpengine)** (media proxy), **[Redis](https://redis.io)**
(registration state and caching).

```bash
npm install
node app.js
```

## Configuration

DragonPBX is configured via environment variables. Under the Debian package these are set in the
`/opt/dragonpbx/config/dragonpbx.env` conffile (see [docs/deployment.md](docs/deployment.md)); in
development they come from your shell environment. Key settings:

| Variable | Default | Description |
|---|---|---|
| `DRACHTIO_HOST` | `localhost` | Drachtio server host |
| `DRACHTIO_PORT` | `9022` | Drachtio server port |
| `DRACHTIO_SECRET` | `cymru` | Drachtio shared secret |
| `RTPENGINE_HOST` | *(DRACHTIO_HOST)* | RTPEngine host |
| `RTPENGINE_PORT` | `2223` | RTPEngine port |
| `DATA_SOURCE` | `api` | Config backend: `json`, `api`, or `pg` |
| `LOGLEVEL` | `debug` | Log level (fatal/error/warn/info/debug/trace) |

See [docs/configuration.md](docs/configuration.md) for the full list of environment variables.

### Data Sources

DragonPBX supports three configuration backends:

- **JSON** (`DATA_SOURCE=json`) — reads from a local `config.json` file
- **HTTP API** (`DATA_SOURCE=api`) — fetches config from a remote API endpoint
- **PostgreSQL** (`DATA_SOURCE=pg`) — loads config from a database (COMING SOON)

See [docs/data_sources.md](docs/data_sources.md) for details, and `example_config.json` for the config structure.

## Concepts

- **Domain** — top-level container; calls and devices are organized by SIP domain
- **Client** — a SIP endpoint that registers to the system
- **Trunk** — an external SIP connection (provider/peer), identified by source IP ranges
- **DialPlan** — maps dialled numbers to CallHook URLs using pattern matching (`*`, `?` wildcards)
- **CallHook** — HTTP endpoint that returns a CallScript describing how to handle a call
- **CallScript** — JSON array of verbs executed sequentially
- **RegHook** — HTTP endpoint for authenticating SIP registrations
- **StatusHook** — webhook receiving real-time call events

See [docs/concepts.md](docs/concepts.md) for full details.

## CallScript Verbs

| Verb | Description |
|---|---|
| `announce` | Play a media file as early media |
| `connect` | Ring one or more destinations as a B2BUA, supports parallel forking |
| `response` | Send a SIP response code (3xx–6xx) |
| `pause` | Delay execution for a number of seconds |

See [docs/verbs.md](docs/verbs.md) for verb parameters and examples.

## Hooks

- **CallHook** — fetched when a call arrives; returns the CallScript
- **RegHook** — called on SIP REGISTER; authenticates clients and returns dialplan/codecs
- **StatusHook** — receives call lifecycle events (connect, answer, hangup, etc.)

See [docs/hooks.md](docs/hooks.md) for request/response formats.


## Documentation

Full documentation is in the [docs/](docs/) directory:

- [Deployment](docs/deployment.md) — installing via the Debian package, where config is stored
- [Architecture](docs/architecture.md)
- [Concepts](docs/concepts.md)
- [Configuration](docs/configuration.md)
- [Verbs](docs/verbs.md)
- [Hooks](docs/hooks.md)
- [Data Sources](docs/data_sources.md)

## License

Internal Use Software License — see [LICENSE.md](LICENSE.md).

Copyright 2026 Sam Machin
