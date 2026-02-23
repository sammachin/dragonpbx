
# Hooks

Hooks are HTTP endpoints that DragonPBX calls during call and registration processing. They allow external systems to control authentication, call routing, and receive real-time call status updates.

## RegHook

Called when a SIP client sends a REGISTER request and needs to be authenticated.

### Request

**Method:** POST

**Body:** The SIP digest authentication data from the REGISTER request, including:

| Field | Type | Description |
|---|---|---|
| `username` | string | SIP username from the Authorization header |
| `realm` | string | Authentication realm (the domain) |
| `nonce` | string | Nonce from the challenge |
| `uri` | string | Request URI |
| `response` | string | Digest response hash |
| `method` | string | SIP method (REGISTER) |
| `source_address` | string | IP address of the registering client |
| `source_port` | int | Port of the registering client |
| `expires` | int | Requested registration expiry in seconds |

### Response

**Status:** 200 for success, any other code rejects the registration.

**Body:**

```json
{
    "status": "ok",
    "expires": 300,
    "dialplan": {
        "1???": "https://example.com/internal",
        "0*": "https://example.com/external"
    },
    "codecs": ["G722", "PCMA", "PCMU"]
}
```

| Field | Type | Description |
|---|---|---|
| `status` | string | `ok` for success, anything else is a failure |
| `expires` | int | Registration expiry to grant (clamped to min/max settings) |
| `dialplan` | object | Dialplan to assign to this client (see DialPlan in concepts) |
| `codecs` | array | Supported codecs for this client (Optional)|

The `codecs` array can include `DIRECT` as a special value to indicate the client supports direct media (bypassing RTPEngine when both legs support it).


## CallHook

Called when the system needs to determine how to handle an inbound call. The CallHook URL is resolved by matching the dialled number against the client or trunk's dialplan.

### Request

**Method:** POST
**Timeout:** 3 seconds

**Body:**

```json
{
    "domain": "pbx.example.com",
    "from": "1000",
    "to": "1001",
    "callId": "abc123def456",
    "sourceAddress": "192.168.1.100",
    "headers": {},
    "source": "client",
    "refer": false,
    "count": 0
}
```

| Field | Type | Description |
|---|---|---|
| `domain` | string | The SIP domain of the call |
| `from` | string | Calling party number (From URI user part) |
| `to` | string | Dialled number (To URI user part) |
| `callId` | string | SIP Call-ID header |
| `sourceAddress` | string | Source IP of the caller |
| `headers` | object | Full SIP headers from the INVITE |
| `source` | string/object | `"client"` or the trunk object if call arrived from a trunk |
| `refer` | bool | `true` if this call originated from a SIP REFER (transfer) |
| `count` | int | Retry counter, starts at 0, increments on each retry (max 3) |

The `count` field allows the CallHook to return different routing logic on retries. For example, first attempt could ring a user, second attempt could go to voicemail.

### Response

**Status:** 200

**Body:** A CallScript JSON array (see verbs.md and example_callScript.json).

```json
[
    {"verb": "announce", "url": "file:/greeting.wav"},
    {"verb": "connect", "dest": [{"address": "1001", "type": "client", "timeout": 30}]},
    {"verb": "response", "code": 480}
]
```

If the CallHook returns a non-200 status or times out, the call is rejected with 480 (Temporarily Unavailable).


## StatusHook

An optional webhook that receives real-time status updates about a call in progress. It is configured in the dialplan alongside the CallHook.

### DialPlan with StatusHook

To enable status updates, the dialplan value should be an object instead of a plain URL string:

```json
{
    "1???": {
        "callHook": "https://example.com/call",
        "statusHook": "https://example.com/status"
    }
}
```

### Request

**Method:** POST
**Timeout:** 3 seconds

**Body:**

```json
{
    "callId": "abc123@192.168.1.1",
    "event": "connect:answered",
    "label": "optional-label"
}
```

| Field | Type | Description |
|---|---|---|
| `callId` | string | SIP Call-ID |
| `event` | string | Event name (see below) |
| `label` | string | Optional label from the connect verb's `statusLabel` param |

Additional fields are included depending on the event type (destination info, error details, etc).

### Events

#### Playback Events
| Event | Description |
|---|---|
| `playback:start` | Announcement playback started |
| `playback:complete` | Announcement playback finished (includes `duration`) |
| `playback:failed` | Announcement playback failed (includes `error`) |

#### Connect Events
| Event | Description |
|---|---|
| `connect:start` | Connection attempt initiated |
| `connect:trying` | INVITE sent to destination |
| `connect:answered` | Destination answered the call |
| `connect:timeout` | Destination ring timeout reached |
| `connect:cancel` | Destination cancelled (another destination answered first) |
| `connect:error` | Connection attempt failed |
| `connect:hangup` | Connected call ended (includes `endedby`: `"A"` or `"B"`) |
| `connect:reinvite` | ReINVITE received on connected call |
| `connect:refer` | REFER received on connected call |
| `connect:skipped` | Connect verb skipped (call already connected and no reconnect flag) |
| `connect:complete` | Connect verb processing finished |

### Suppressing Status Updates

Set `statusLabel` to `false` on a connect verb to suppress status updates for that verb:

```json
{"verb": "connect", "statusLabel": false, "dest": [...]}
```
