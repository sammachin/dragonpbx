# REST API

DragonPBX exposes an HTTP API for monitoring domains, live calls and registered
clients, and for controlling live calls. It listens on `WEBPORT` (default
`2999`) and is served at the root path. Requests and responses are JSON.

> **No authentication.** The API is currently unauthenticated — anything that can
> reach the port can list and control calls. Keep the port private (bind to
> localhost / firewall it) until auth is added.

The OpenAPI 3.0 definition lives at [`lib/api-routes/openapi.yaml`](../lib/api-routes/openapi.yaml).

## Health

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Liveness (200) |
| `GET` | `/health` | Liveness (200) |

## Domains

| Method | Path | Description |
|---|---|---|
| `GET` | `/domains` | List configured domain names |
| `GET` | `/domains/{domain}` | Get a domain's id (or `false` if unknown) |

## Calls

Live, in-memory active calls.

| Method | Path | Description |
|---|---|---|
| `GET` | `/domains/{did}/calls` | List active calls in the domain |
| `GET` | `/domains/{did}/calls/{callId}` | Get one active call |
| `PUT` | `/domains/{did}/calls/{callId}?leg=A\|B` | Update a call leg (see below) |
| `DELETE` | `/domains/{did}/calls/{callId}?leg=A\|B` | Hang up the call (destroys the given leg, default A) |

A call object:

```json
{
  "domain": "pbx.example.com",
  "callId": "…",
  "from": "1001",
  "to": "1002",
  "connected": true,
  "endpointA": "sip:1001@…",
  "endpointB": "sip:1002@…",
  "lastStatus": 200
}
```

### Update a call leg — `PUT /domains/{did}/calls/{callId}`

Runs a new callScript on **one leg** of a live call and **terminates the other**.
`leg` (query, default `A`) selects the leg to **keep**:

- `A` — the originating / `uas` leg.
- `B` — the connected / `uac` leg.

The request body is **either**:

- a **verb array** (a callScript), run directly on the kept leg; or
- an **object** `{ "callHook": "<url>", "statusHook": "<url?>" }`. `callHook`
  is fetched with the same POST body as a normal call hook, plus
  `trigger: "updateLeg"` and `leg`. A `file:` URL is allowed. A provided
  `statusHook` **replaces** the session's statusHook for the remainder of the
  call.

The new script runs in **reconnect mode** on the kept leg (the leg is already
answered). The endpoint is **asynchronous**: it returns `202` once accepted and
the script then runs on the call; failures after acceptance are reported via the
statusHook (`updateLeg:failed`).

**Responses**

| Code | Meaning |
|---|---|
| `202` | Accepted; the new script has begun on the kept leg |
| `400` | Bad `leg`, bad body shape, or object without a `callHook` URL |
| `404` | No active call for `callId` |
| `409` | Call is not connected, or leg B's media could not be resolved |
| `480` | `callHook` fetch failed |
| `500` | Failed to apply the update |

**Examples**

Re-route the kept leg to a new destination (verbs directly):

```bash
curl -i -X PUT "http://localhost:2999/domains/pbx.example.com/calls/<CALL_ID>?leg=A" \
  -H 'Content-Type: application/json' \
  -d '[{"verb":"connect","dest":[{"type":"client","address":"2000","timeout":30}]}]'
```

Fetch the new script from a hook and switch the status URL:

```bash
curl -i -X PUT "http://localhost:2999/domains/pbx.example.com/calls/<CALL_ID>?leg=B" \
  -H 'Content-Type: application/json' \
  -d '{"callHook":"https://example.com/updateleg","statusHook":"https://example.com/status"}'
```

**Limitations**

- Keeping **leg B** works for scripts that start with a `connect`. A media verb
  before any `connect` (e.g. a bare `[{ "verb": "announce" }]`) will not reach
  leg B, because after the bridge is torn down leg B is not on a live media
  session until a `connect` re-INVITEs it. Leg A has no such limitation.
- `response` is ignored on a connected call; `pickup` is not meaningful inside an
  update.

## Clients

Registrations, read from Redis.

| Method | Path | Description |
|---|---|---|
| `GET` | `/domains/{did}/clients` | List registered client extensions |
| `GET` | `/domains/{did}/clients/{cid}` | A client's registration hash (contacts, proxies, dialplan, codecs) |
