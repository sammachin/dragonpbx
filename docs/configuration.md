
# Configuration

DragonPBX is configured through environment variables and a configuration file that defines domains, clients and trunks.

## Environment Variables

### Drachtio / SIP

| Variable | Default | Description |
|---|---|---|
| `DRACHTIO_HOST` | `localhost` | Hostname of the Drachtio SIP server |
| `DRACHTIO_PORT` | `9022` | Port for the Drachtio connection |
| `DRACHTIO_SECRET` | `cymru` | Shared secret for Drachtio authentication |
| `RTPENGINE_HOST` | Same as `DRACHTIO_HOST` | Hostname of the RTPEngine media proxy |
| `RTPENGINE_PORT` | `2223` | Port for the RTPEngine control protocol |

### Database (PostgreSQL)

Only required when `DATA_SOURCE=pg`.

| Variable | Default | Description |
|---|---|---|
| `DB_HOST` | `localhost` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_USER` | `postgres` | Database username |
| `DB_PASSWORD` | `my_password` | Database password |

### HTTP

| Variable | Default | Description |
|---|---|---|
| `HTTP_POOL` | `false` | Enable HTTP connection pooling |
| `HTTP_POOLSIZE` | `3` | Number of connections in the pool |
| `HTTP_PIPELINING` | `false` | Enable HTTP pipelining |
| `HTTP_TIMEOUT` | `30` | Timeout in seconds for HTTP requests |
| `HTTP_PROXY_IP` | `false` | Proxy IP address |
| `HTTP_PROXY_PORT` | `false` | Proxy port |
| `HTTP_PROXY_PROTOCOL` | `false` | Proxy protocol |
| `HTTP_USER_AGENT_HEADER` | `dragonpbx` | User-Agent string sent with HTTP requests |

### Data Source

| Variable | Default | Description |
|---|---|---|
| `DATA_SOURCE` | `api` | Configuration backend: `json`, `api`, or `pg` |
| `CONFIG_URL` | `http://127.0.0.1:1337/api/v1/domains` | URL for the API data source |
| `CONFIG_TOKEN` | `dev-admin-token-123` | Bearer token for the API data source |
| `CONFIG_TTL` | `60` | Cache TTL in seconds for API-fetched config |

### Media & Codecs

| Variable | Default | Description |
|---|---|---|
| `MEDIA_PATH` | Application root | Filesystem path where media files are stored |
| `FILE_PATH` | Application root | Filesystem path for file:// CallScript resolution |
| `DEFAULT_CODECS` | `["G722", "PCMA", "PCMU"]` | Default codec list when none specified |
| `DEFAULT_RINGTONE` | `file:/uk.wav` | Default ringback tone media file |
| `MAX_RECORDING_DURATION` | `300` | Maximum recording duration in seconds |

### Registration

| Variable | Default | Description |
|---|---|---|
| `REGISTRATION_MIN_SECS` | `30` | Minimum allowed registration expiry |
| `REGISTRATION_MAX_SECS` | `3600` | Maximum allowed registration expiry |
| `REGTRUNKREFRESH` | `60` | Interval in seconds to check for trunk registration changes |

### General

| Variable | Default | Description |
|---|---|---|
| `LOGLEVEL` | `debug` | Pino log level (`fatal`, `error`, `warn`, `info`, `debug`, `trace`) |
| `WEBPORT` | `2999` | Port for the HTTP API |
| `NODE_ENV` | - | Node environment |


## Config File Structure

When using `DATA_SOURCE=json` the system reads from `config.json`. The structure is the same regardless of backend, the JSON file is just the simplest way to see it.

```json
{
    "domains": {
        "pbx.example.com": {
            "domain_id": 1,
            "clients": [],
            "trunks": []
        }
    }
}
```

The top-level key under `domains` is the FQDN (or IP address) that the system will accept SIP traffic for.

### Clients

Clients are SIP endpoints that register to the system.

```json
{
    "id": 1,
    "username": "1???",
    "reghook": "https://example.com/reghook"
}
```

| Field | Type | Description |
|---|---|---|
| `id` | int | Unique identifier |
| `username` | string | Username or pattern to match. Supports `?` (single char) and `*` (multiple chars) |
| `reghook` | string | URL called to authenticate REGISTER requests |
| `password` | string | Static password for file-based auth (alternative to reghook) |
| `dialplan` | object | Static dialplan (alternative to reghook-provided dialplan) |
| `codecs` | array | Supported codecs (alternative to reghook-provided codecs) |

When a `reghook` URL is provided, authentication and dialplan assignment is delegated to that HTTP endpoint. When `password` and `dialplan` are provided inline, file-based authentication is used instead.

### Trunks

Trunks are SIP connections to external systems.

```json
{
    "id": 1,
    "name": "my-provider",
    "inbound": ["192.168.1.0/24"],
    "outbound": {
        "host": "sip.provider.com",
        "username": "+15551212",
        "password": "secret"
    },
    "dialplan": {
        "*": "https://example.com/trunkcall"
    },
    "codecs": ["G722", "PCMA", "PCMU"]
}
```

| Field | Type | Description |
|---|---|---|
| `id` | int | Unique identifier |
| `name` | string | Human-readable name, also used as a lookup key with `trunk_name` in connect verbs |
| `inbound` | array | CIDR ranges that identify inbound traffic from this trunk |
| `outbound.host` | string | SIP host (and optional port) for outbound calls |
| `outbound.username` | string | Optional username for outbound SIP authentication |
| `outbound.password` | string | Optional password for outbound SIP authentication |
| `dialplan` | object | Dialplan mapping for calls arriving from this trunk |
| `codecs` | array | Codec list for this trunk, defaults to `DEFAULT_CODECS` if not set |

If `outbound.username` and `outbound.password` are present, the system will also make outbound SIP registrations to the trunk host (RegTrunks), keeping the registration alive on a refresh interval.
