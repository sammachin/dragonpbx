
# Architecture

DragonPBX is a programmable SIP PBX built on the Drachtio SRF framework. It acts as a B2BUA (Back-to-Back User Agent) with RTPEngine handling media. Call routing logic is delegated to external HTTP endpoints via CallHooks, making the system programmable from the outside.

## Components

### External Dependencies

- **Drachtio** - SIP server that handles the signalling layer. DragonPBX connects to it as a client application.
- **RTPEngine** - Media proxy for RTP streams. Handles codec transcoding and media relay.
- **Redis** - Stores client registration state (contacts, dialplans, codecs) with TTL-based expiry.
- **PostgreSQL** - Optional configuration backend (when `DATA_SOURCE=pg`).

### Internal Modules

```
app.js                  Entry point, SIP event wiring
settings.js             Environment variable config
lib/
  middleware.js          Request preprocessing (domain check, trunk detection)
  callSession.js         Call orchestrator, builds and runs CallScript schedule
  connectCall.js         B2BUA connection logic, destination resolution
  registration.js        SIP REGISTER handler, Redis state storage
  playAnnouncement.js    Media playback via RTPEngine
  sendResponse.js        SIP response codes (3xx-6xx)
  pause.js               Timed delay in call processing
  transferCall.js        REFER handling and call transfers
  regTrunk.js            Outbound trunk registration manager
  authTrunk.js           Trunk authentication
  isRegTrunk.js          Registered trunk detection
  ringBackTone.js        Ringback tone generation
  utils/
    digestChallenge.js   SIP digest auth challenge/response
    regHook.js           Registration hook (HTTP or file-based auth)
    callHook.js          CallHook fetching and dialplan matching
    statusHook.js        Call status webhook notifications
    callScriptFile.js    File-based CallScript loading with Handlebars
  data/
    index.js             Data layer factory
    json.js              JSON file backend
    api.js               HTTP API backend
    pg.js                PostgreSQL backend
```

## Call Flow

### Inbound INVITE

```
SIP INVITE arrives at Drachtio
        |
        v
  checkDomain ──── reject 500 if domain unknown
        |
        v
  initLocals ──── parse headers, open Redis connection, set up request context
        |
        v
  isTrunk ──── check source IP against trunk CIDR ranges
        |
        v
  isRegTrunk ──── check if source matches an outbound-registered trunk
        |
        v
  digestChallenge ──── if not already authenticated, send 401 challenge
        |
        v
  isauthTrunk ──── validate trunk authentication credentials
        |
        v
  regHook ──── call RegHook to authenticate client (HTTP or file-based)
        |
        v
  getCallHook ──── match dialled number against dialplan, find CallHook URL
        |
        v
  getCallScript ──── POST to CallHook URL (or read file://), get CallScript JSON
        |
        v
  CallSession.execute()
        |
        ├── build() ── set up RTPEngine offer, parse verbs into action schedule
        |
        └── run() ── execute actions sequentially (announce, connect, response, pause)
                |
                └── if no result after all actions and count < 3,
                    re-fetch CallScript and execute again
```

### Inbound REGISTER

```
SIP REGISTER arrives at Drachtio
        |
        v
  checkDomain
        |
        v
  initLocals
        |
        v
  digestChallenge ──── send 401 if no credentials
        |
        v
  regHook ──── authenticate via HTTP or file, get dialplan + codecs
        |
        v
  Registration.register() ──── store contact, proxy, dialplan, codecs in Redis with TTL
```

## B2BUA Model

When a call is connected, DragonPBX sits in the middle as a B2BUA:

```
Caller (A leg)  <──>  DragonPBX  <──>  Destination (B leg)
     UAS                                    UAC
```

- **UAS** (User Agent Server) - the inbound side facing the caller
- **UAC** (User Agent Client) - the outbound side facing the destination

RTPEngine sits in the media path between both legs, handling codec negotiation and transcoding. When both sides support `DIRECT` media, RTPEngine can be bypassed.

Multiple destinations can be rung in parallel (forking). The first to answer wins and all other attempts are cancelled.

## Retry Logic

If a CallScript completes without the call reaching a terminal state (answered or rejected), and the count is less than 3, the system will re-fetch the CallScript from the CallHook with an incremented `count` value. This allows the CallHook to return different routing logic on subsequent attempts (e.g. voicemail after the first attempt goes unanswered). After 3 attempts the call is rejected with 604 (Does Not Exist Anywhere).

## Outbound Trunk Registration (RegTrunks)

Some SIP providers require the PBX to register with them. DragonPBX handles this automatically for any trunk that has `outbound.username` and `outbound.password` configured. The `RegTrunks` module:

1. Polls all domains for trunks that need outbound registration
2. Sends SIP REGISTER to each trunk host
3. Re-registers at half the granted expiry interval
4. Stores registration state in Redis under `regtrunk:{domain}:{uuid}`
5. Refreshes the trunk list periodically (controlled by `REGTRUNKREFRESH`)

When the trunk list changes, all registrations are torn down and re-established.
