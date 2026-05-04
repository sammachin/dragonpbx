
## Announce

Plays a media file in Early Media if call has not yet been connected
### Params:
url: file:// path to localfilesystem

Can be sent multiple times at any stage of a call.

## Response
Sends a SIP response code 3xx-6xx
### Params
code: Integer representing SIP response code
headers: Object objectin containging additional SIP headers for the response

Will end the call handling when a response is sent, no other verbs after this will be actioned.

## Pause
Delays the call processing for defined number of seconds
### Params
duration: Int, number of seconds to wait

Can be sent multiple times at any stage of a call.

## Connect
Connect the call to another endpoint as a B2BUA
Endpoints can be clients, trunks or SIP URIs

### Params
reconnect: bool, If the call was already answered in a previous connect verb setting this to try will offer the call to the new destinations
dest: array, list of endppints to ring in paralel
dest.type: enum, client|trunk|sip type of endpoint
dest.address: string, client number, sip uri or number on trunk to connect to 
dest.trunk_id: int, ID of the trunk to dial out for type=trunk
dest.trunk_name: string, Name of the trunk to dial out when type=trunk (trunk_id will take priority)
dest.timeout: int, number of seconds to ring 
dest.proxy: string, SIP proxy to use for the call.

### Cancel Reason headers

When multiple destinations ring in parallel and one is cancelled before it answers,
DragonPBX includes an RFC 3326 `Reason` header on the CANCEL so the endpoint knows
why it was cancelled:

| Scenario | Reason header |
|---|---|
| Another destination answered first | `SIP;cause=200;text="Call completed elsewhere"` |
| The endpoint's `timeout` elapsed without answer | `SIP;cause=487;text="Request Terminated"` |
| The A-party hung up before any destination answered | `SIP;cause=487;text="Request Terminated"` |

Clients that honour RFC 3326 (e.g. most mobile SIP stacks) can use `cause=200` to
suppress a missed-call notification when another device in the fork group picks up.

## Record

Sends a copy of the audio from each leg of the call to a SIPREC-capable
Session Recording Server (SRS) per RFC 7865/7866. DragonPBX acts as the
Session Recording Client (SRC); rtpengine forks the media to the SRS while
the original call continues unaffected.

The `record` verb is *armed* by placing it in the script before a `connect`.
It returns immediately, and recording is initiated automatically when the
following `connect` answers. When the call ends from either side, DragonPBX
sends BYE to the SRS and tears down the rtpengine subscription.

If the SRS is unreachable or rejects the INVITE, the original call is **not**
affected — recording is best-effort and failures are reported via statusHook
(`record:failed`).

> **Source legs must not use SRTP/SDES crypto.** Adding a SIPREC subscriber
> to a call whose source leg is SRTP-encrypted breaks both the recording
> and the live call's media path in rtpengine. Disable crypto on endpoints
> whose calls will be recorded.

### Params
siprecServer: string (required), SIP URI of the SRS (e.g. `sip:srs@recorder.example.com`)
legs: string, which call legs to record - `a` (caller only), `b` (callee only), or `both` (default)
from: string, optional override for the SIP From header on the SIPREC INVITE. Accepts either a bare username (e.g. `"pbx"` - expanded to `sip:pbx@<call's domain>`), a full SIP URI (`sip:pbx@acme.example.com`), or a display-name form (`"Acme PBX" <sip:pbx@acme.example.com>`). If omitted, drachtio assigns a default which most SRSes see as anonymous.
proxy: string, optional outbound proxy for the SIPREC INVITE
auth: object, optional `{username, password}` for digest auth to the SRS
headers: object, additional SIP headers to include on the SIPREC INVITE
metadata: object, optional metadata fields:
  - callerName: string, display name for the caller participant
  - calleeName: string, display name for the callee participant
  - session: object, custom name/value pairs added under `<session>` in the metadata XML

### Status events
- `record:armed` — verb has armed recording on the call
- `record:starting` — SIPREC INVITE is being sent
- `record:active` — SRS answered and media is being forked
- `record:failed` — SIPREC setup failed (call continues)
- `record:ended` — SRS terminated the recording dialog
- `record:stopped` — recording was torn down because the call ended

### Example
```json
[
  {
    "verb": "record",
    "siprecServer": "sip:srs@recorder.example.com",
    "metadata": { "calleeName": "Support" }
  },
  {
    "verb": "connect",
    "dest": [{ "type": "client", "address": "1000" }]
  }
]
```