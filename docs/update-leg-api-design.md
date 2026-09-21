# Design: Update a Call Leg (`PUT /domains/:did/calls/:callId`)

Status: **proposal / for review** · Target branch: `dev`

## 1. Goal

Add a REST method that re-controls a live call by running a **new callScript on
one leg** and **terminating the other leg**.

```
PUT /domains/:did/calls/:callId?leg=A|B
```

- `leg` selects the leg to **keep** (A = the originating/uas leg, B = the
  connected/uac leg). The other leg is terminated.
- The request body is **either**:
  - a **callHook reference**: `{ "callHook": "<url>", "statusHook": "<url?>" }`
    — DragonPBX fetches a new callScript from `callHook` using the same request
    body a normal call hook receives, then runs it on the kept leg; or
  - **verbs directly**: a JSON **array** of verb objects, run as-is on the kept
    leg.

The kept leg is already answered, so the new script runs in **reconnect mode**
(re-INVITE the existing dialog) rather than answering a fresh INVITE.

## 2. Why this is non-trivial (current constraints)

The verb layer today assumes the controlling leg is the **inbound A-leg** and
that the call is in the **pre-answer / early-media** phase:

- `announce` offers rtpengine and sends a **`183` with early-media SDP** on the
  inbound `res`, keyed by the inbound INVITE's call-id/from-tag
  ([`lib/playAnnouncement.js:30-48`](../lib/playAnnouncement.js)). It never
  re-INVITEs, so it cannot run on an answered dialog as-is.
- `CallSession.build()` derives `this.details` and `srcCodecs` from
  `this.req` (the inbound INVITE) and every verb reads `cs.req` / `cs.res` /
  `cs.dialog.uas` ([`lib/callSession.js:106-124`](../lib/callSession.js)).
- Only `connect` has reconnect awareness (`isReconnect` at
  [`lib/connectCall.js:199`](../lib/connectCall.js)), and it re-offers the
  **uas** leg specifically.
- `lib/reConnectCall.js` is **dead code** (nothing `require`s it); it can be a
  reference but is not wired in.
- The run loop parks: while a call is connected, `session.execute()` is still
  pending inside the `connect` activity's `await … 'done'`
  ([`lib/callSession.js:49-55`](../lib/callSession.js)), and the session remains
  in `activeCalls` ([`app.js:157-162`](../app.js)). This is the seam we inject
  into.

**Consequences:** "full verb set on either leg" requires (a) abstracting *the
controlling leg* and (b) a **reconnect variant of each media verb**.

## 3. API contract

### Request

- Method/path: `PUT /domains/:did/calls/:callId`
- Query: `leg` = `A` (default) or `B`, case-insensitive.
- Body, `Content-Type: application/json`, one of:
  - Array → verbs: `[ { "verb": "connect", ... }, ... ]`
  - Object → hook: `{ "callHook": "https://…", "statusHook": "https://…" }`
    (`file:` URLs allowed, same as dialplan callHooks). `statusHook` optional.
- Disambiguation rule: **`Array.isArray(body)` ⇒ verbs; else object ⇒ hook.**
  An object without `callHook`, or a body that is neither, ⇒ `400`.

### callHook fetch params

Reuse the existing hook body ([`lib/utils/callHook.js:17-27`](../lib/utils/callHook.js)),
populated from the session's `req.locals`:
`domain, from, to, callId, sourceAddress, headers, source, refer:false, count`,
**plus** `trigger: "updateLeg"` and `leg: "A"|"B"` so apps can distinguish an
update from an inbound call.

### Responses

The endpoint is **async**: it validates, accepts, and returns immediately; the
new script then runs on the call. Callers poll `GET …/calls/:callId` for the
result, and any post-acceptance failure is reported via the **statusHook**
(`updateLeg:failed` — see §6).

| Code | When |
|---|---|
| `202 Accepted` | update accepted; the new script has begun on the kept leg |
| `400` | bad `leg`, bad body shape, or object without `callHook` |
| `404` | no active call for `callId` (or domain mismatch) |
| `409` | call not in a state that can be updated (not yet connected / no two legs) |
| `480`/`5xx` | callHook fetch failed **before** acceptance (mirror `getCallScript`) |

Fetch/validation happens before the `202`, so a bad callHook is reported
synchronously (`480/5xx`); failures once the script is running are async
(statusHook).

## 4. Proposed architecture

### 4.1 Leg abstraction

Introduce a small descriptor for "the leg a script controls", so verbs stop
reading `cs.req` directly:

```
Leg {
  dialog        // drachtio Dialog (uas or uac) once answered
  callId        // rtpengine call-id to use for this leg's media
  localTag      // this leg's tag (rtpengine from-tag)
  remoteTag     // far tag (for answer())
  sdp           // this leg's current remote SDP (its offer/answer)
  codecs        // this leg's negotiated codecs (srcCodecs equivalent)
  answered      // bool
  // ops:
  modify(sdp)   // re-INVITE this leg with new SDP (dialog.modify)
  answer(sdp)   // answer a not-yet-answered inbound leg (createUAS)  [A only, pre-answer]
}
```

`CallSession` gains `this.activeLeg` (defaults to the A/uas leg, preserving all
current behaviour). Verbs read media identity from `cs.activeLeg` instead of
`cs.req`. For a fresh inbound call `activeLeg` wraps `cs.req`/`cs.dialog.uas`;
for `updateLeg` it wraps the kept dialog.

> Backwards-compat: default `activeLeg` derived from `cs.req` so existing inbound
> flows are unchanged. Verbs changed to read `cs.activeLeg.{callId,localTag,…}`
> but those resolve to today's `cs.req`-derived values by default.

### 4.2 `CallSession.updateLeg({ keep, callScript, statusHook })`

Models the existing REFER/transfer flow
([`lib/connectCall.js:587-608`](../lib/connectCall.js)):

1. Validate: `successfullyConnected && dialog.uas && dialog.uac`; else `409`.
2. Resolve `keptDialog` / `dropDialog` from `keep`.
3. Build `activeLeg` for the kept dialog (its callId/tags/sdp/codecs).
4. If `statusHook` provided, **replace it for the remainder of the call**:
   `this.req.locals.statusHook = statusHook; this.statusHook =
   new StatusHook(logger, req, statusHook)`
   ([`lib/utils/statusHook.js:9`](../lib/utils/statusHook.js)). All later events
   on this session (including from the new verbs) go to the new URL.
5. `this.callScript = callScript; await this.build(true)` — build in reconnect
   mode; new activities are **appended** to `this.schedule`.
6. Detach the kept dialog's connect-teardown handlers
   (`keptDialog.removeAllListeners(...)`) so the old `connect` cleanup can't fire.
7. Terminate the other leg: `dropDialog.destroy()` (+ rtpengine cleanup of the
   old bridge) and mark its `uasActive/uacActive` false.
8. Unpark the run loop: `this.activeConnection.emit('done', true)` — the parked
   `connect` activity resolves, `run()`'s `while (schedule.length)` picks up the
   appended activities and runs them against `activeLeg`.

Leg A keeps `uas` (natural); leg B keeps `uac` and sets `activeLeg` to the uac —
this is where the abstraction earns its keep.

### 4.3 Per-verb reconnect variants

Each media verb needs an "already answered" path that re-INVITEs
`cs.activeLeg` instead of sending `183`:

- **connect**: use existing `isReconnect` path, generalised to re-offer
  `activeLeg` (not hardcoded uas). Re-offer `activeLeg.sdp` to rtpengine, dial the
  new dest, `activeLeg.modify(sdpA)`.
- **announce**: offer rtpengine for `activeLeg`, deliver SDP via
  **`activeLeg.modify(sdp)`** (re-INVITE) instead of `res.send(183)`, **play the
  announcement to completion, then emit `done` so the run loop advances to the
  next verb** (or, if this was the last verb and nothing sent a final result,
  falls into the retry loop). No media restore/hold — one-shot then continue.
- **pause**: no media renegotiation needed; timer only. Low risk.
- **record**: SIPREC is driven off `cs.dialog` + tags; parameterise by
  `activeLeg`. Medium.
- **response**: **not possible on a connected call — ignore with a log** and
  emit `done` so the script continues. (No SIP status is sent.)
- **pickup**: already operates on other sessions; unaffected as a target, but
  is rejected/ignored inside an updateLeg script (nonsensical there).

## 5. Terminating the other leg

Reuse the DELETE semantics ([`lib/api-routes/calls.js:46-69`](../lib/api-routes/calls.js)):
`dropDialog.destroy()` sends BYE. Ensure the old rtpengine bridge is deleted
(`rtpClient.delete(cs.details)`) and that dropping the leg does **not** cascade
into tearing down the kept leg (detach handlers first, as connected-pickup does
at [`lib/pickupCall.js:210-215`](../lib/pickupCall.js)).

## 6. Failure handling

- callHook fetch fails **before acceptance** → `480/5xx`, call untouched.
- After `202`, any failure applying/running the new script is reported to the
  **statusHook** as `updateLeg:failed` (with `{leg, error}`), never as an HTTP
  error (the caller has already been answered). The kept leg must not be left
  half-renegotiated — define rollback for the media re-offer step; on
  unrecoverable failure, tear the call down and emit `updateLeg:failed`.
- Caller races call teardown → `404/409`.
- Consistent with verbs' own fall-through model (no stray final responses).

### statusHook events

- `updateLeg:accepted` — request validated and applied (optional, mirrors `202`).
- `updateLeg:failed` — applying/running the new script failed (`{leg, error}`).

## 7. Phasing

1. **Phase 1 — API + orchestration + leg A `connect`:** endpoint, body parsing,
   fetch, `updateLeg` for `keep=A` running a `connect` in reconnect mode,
   terminate leg B. Reuses working machinery; testable end-to-end. `leg=B` and
   non-connect verbs return a clear `409/501` until their phase lands.
2. **Phase 2 — leg B:** `activeLeg` abstraction wired so the `uac` can be the
   controlling leg; connect/reconnect works keeping either leg.
3. **Phase 3 — full verb set on answered legs:** reconnect variants for
   `announce`, `pause`, `record`; define `response`/`pickup` behaviour.

Each phase is independently testable against live phones.

## 8. Test plan (per phase)

- Two registered clients + a trunk. Establish a call, then `PUT` with:
  - verbs array `[{connect,…}]` keeping A → far leg drops, A re-dials new dest.
  - `{callHook}` keeping A → same via fetched script.
  - keep B variants (Phase 2).
  - `[{announce},{connect}]` (Phase 3) → hold-announce then transfer.
- Verify with `sngrep`: kept leg gets a re-INVITE (not `183`), other leg gets
  BYE, media re-bridges correctly, no `final response already sent`.

## 9. Resolved decisions

1. **Async response:** endpoint returns `202` after validate+fetch; the script
   runs asynchronously. Post-acceptance failures go to the statusHook
   (`updateLeg:failed`), not HTTP.
2. **callHook params:** include `trigger:"updateLeg"` and `leg` in the fetch
   body.
3. **`announce` on an answered leg:** play to completion, then continue to the
   next verb (or the retry loop). No hold/restore.
4. **`response` inside an update:** ignored with a log (not valid on a connected
   call); the script continues.
5. **`statusHook`:** a provided `statusHook` replaces the session's statusHook
   for the remainder of the call.
6. **Auth:** out of scope for now (tracked separately). Note the API remains
   unauthenticated; this endpoint can redirect/terminate live calls.
