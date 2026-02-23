
# Data Sources

DragonPBX supports three pluggable backends for loading domain, client and trunk configuration. The backend is selected by the `DATA_SOURCE` environment variable.

## JSON (`DATA_SOURCE=json`)

Reads configuration directly from `config.json` in the project root. The file is loaded once at startup and kept in memory.

This is the simplest option for development or small deployments. See `example_config.json` for a template.

No additional environment variables are required.

## API (`DATA_SOURCE=api`)

Fetches configuration from an external HTTP API. The config is periodically refreshed on a timer.

| Variable | Default | Description |
|---|---|---|
| `CONFIG_URL` | `http://127.0.0.1:1337/api/v1/domains` | URL to GET configuration from |
| `CONFIG_TOKEN` | `dev-admin-token-123` | Bearer token sent in the Authorization header |
| `CONFIG_TTL` | `60` | Refresh interval in seconds |

### Expected API Response

The API should return JSON in this format:

```json
{
    "domains": [
        {
            "id": 1,
            "domain": "pbx.example.com",
            "trunks": [...],
            "clients": [...]
        }
    ]
}
```

Note: The API response uses an array of domain objects with a `domain` field for the FQDN, which is different from the JSON file format that uses the FQDN as an object key. The API backend transforms this into the internal format automatically.

The API backend also supports `authType` on trunks:
- `authType: "authentication"` - trunk uses SIP digest authentication for inbound
- `authType: "registration"` - trunk requires outbound SIP registration

## PostgreSQL (`DATA_SOURCE=pg`)

Loads configuration from a PostgreSQL database.

| Variable | Default | Description |
|---|---|---|
| `DB_HOST` | `localhost` | Database host |
| `DB_PORT` | `5432` | Database port |
| `DB_USER` | `postgres` | Database user |
| `DB_PASSWORD` | `my_password` | Database password |

## Data Layer Interface

All three backends expose the same set of functions:

| Function | Description |
|---|---|
| `getDomain(domain)` | Returns the domain_id if the domain exists, false otherwise |
| `listDomains()` | Returns an array of all domain FQDNs |
| `getRegHook(domain, user)` | Finds the matching client config for a registering user |
| `getTrunkByIP(domain, ip)` | Finds a trunk whose inbound CIDR range matches the given IP |
| `getTrunkById(domain, id)` | Looks up a trunk by its numeric ID |
| `getTrunkByName(domain, name)` | Looks up a trunk by its name |
| `getAuthTrunks(domain)` | Returns trunks that use digest authentication |
| `getRegTrunks(domain)` | Returns trunks that require outbound registration |

Client username matching uses glob patterns: `?` matches a single character, `*` matches multiple characters. For example `1???` matches any 4-digit number starting with 1, and `*` matches everything.

Trunk IP matching uses CIDR notation, e.g. `192.168.1.0/24` or `10.0.0.1/32` for a single IP.
