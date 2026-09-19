const Emitter = require('events');

const rtpengine = require('rtpengine-client').Client
const { RTPENGINE_HOST, RTPENGINE_PORT, RTPENGINE_TIMEOUT } = require('../settings');
const rtpClient = new rtpengine({timeout: RTPENGINE_TIMEOUT});

// Lazy require to avoid the circular dependency with app.js (same pattern as
// api-routes/calls.js).
const getActiveCalls = () => require('../app').activeCalls;

// Build the callee-facing SDP: offer the caller's SDP into rtpengine, masking
// to the caller's codecs and transcoding to the far party's codecs. Mirrors
// getSdpB in connectCall.js.
function bridgeOffer(details, sdp, srcCodecs, dstCodecs) {
    const srcHasTelephoneEvent = sdp.toLowerCase().includes('telephone-event');
    const codecOpts = { 'mask': srcCodecs };
    if (srcHasTelephoneEvent) {
        codecOpts.accept = ['telephone-event'];
        codecOpts.transcode = dstCodecs;
    } else {
        codecOpts.transcode = [...dstCodecs, 'telephone-event'];
    }
    return rtpClient.offer(RTPENGINE_PORT, RTPENGINE_HOST, {
        'call-id': details['call-id'],
        'from-tag': details['from-tag'],
        'sdp': sdp,
        'flags': ['inject DTMF'],
        'codec': codecOpts
    }).then((r) => {
        if (r && r.result === 'ok') return r.sdp;
        throw new Error(`rtpengine offer failed: ${r && r['error-reason']}`);
    });
}

// Build the caller-facing SDP: answer with the far party's SDP. Mirrors
// getSdpA in connectCall.js.
function bridgeAnswer(details, toTag, sdp) {
    return rtpClient.answer(RTPENGINE_PORT, RTPENGINE_HOST, {
        'call-id': details['call-id'],
        'from-tag': details['from-tag'],
        'to-tag': toTag,
        'sdp': sdp,
        'flags': ['inject DTMF']
    }).then((r) => {
        if (r && r.result === 'ok') return r.sdp;
        throw new Error(`rtpengine answer failed: ${r && r['error-reason']}`);
    });
}

// The pickup verb: grab a call at another extension and bridge its remote
// party to the caller running this verb (the "picker").
//   { verb: 'pickup', target: '1001' }                     // any: ringing, else live (default)
//   { verb: 'pickup', target: ['1001','1002'] }            // first match wins
//   { verb: 'pickup', target: '1001', state: 'ringing' }   // ringing only
//   { verb: 'pickup', target: '1001', state: 'connected' } // steal a live call only
class pickup extends Emitter {
    constructor(cs, params) {
        super();
        this.name = 'pickup';
        this.cs = cs;
        this.req = cs.req;
        this.res = cs.res;
        this.srf = cs.req.srf;
        this.logger = cs.logger;
        this.params = params;
        this.statusHook = cs.statusHook;
    }

    static async create(cs, params) {
        return new pickup(cs, params);
    }

    _notFound(targets, state) {
        this.logger.info(`pickup: no ${state} call found for target ${targets.join(',')}`);
        this.statusHook.send('pickup:notfound', this.params, {target: targets, state});
        // Don't send a final response here: emit done and let the callScript fall
        // through to the next verb (e.g. a fallback response), or the retry loop.
        this.emit('done', false);
    }

    // Ring the picker and wait for a still-ringing OUTBOUND call (ro.X) to be
    // answered by the far end. Resolves true once it connects, or false if it
    // fails/cancels first (or the picker gives up). On true, ro.X is a normal
    // connected call the caller can then pick up.
    async _awaitOutboundAnswer(ro) {
        const conn = ro.X.ringing && ro.X.ringing.connection;
        if (!conn) return false;
        // Already answered in the gap between matching and waiting — take it now.
        if (ro.X.successfullyConnected) return true;
        this.logger.info(`pickup: waiting to take over ringing outbound call from ${ro.ext} (session ${ro.X.req.get('Call-ID')})`);
        this.statusHook.send('pickup:waiting', this.params, {target: ro.ext, state: 'ringing'});
        // Ring the picker while we wait for the far end to answer.
        try { this.res.send(180); } catch (e) {}
        return await new Promise((resolve) => {
            let settled = false;
            const cleanup = () => {
                try { conn.removeListener('connected', onConnected); } catch (e) {}
                try { conn.removeListener('done', onDone); } catch (e) {}
                try { this.req.removeListener('cancel', onCancel); } catch (e) {}
            };
            const finish = (ok) => { if (settled) return; settled = true; cleanup(); resolve(ok); };
            const onConnected = () => finish(true);
            const onDone = () => finish(false);   // outbound failed/cancelled before answer
            const onCancel = () => finish(false); // picker gave up waiting
            conn.once('connected', onConnected);
            conn.once('done', onDone);
            this.req.once('cancel', onCancel);
        });
    }

    async action() {
        this.statusHook.send('pickup:start', this.params);

        // Step A - normalise params
        const raw = this.params.target;
        const targets = (Array.isArray(raw) ? raw : [raw])
            .filter(d => d !== undefined && d !== null && `${d}` !== '')
            .map(d => `${d}`);
        // 'any' (default, match either), 'ringing', or 'connected'. When either
        // is allowed, a ringing call is preferred over stealing a live one.
        const requested = `${this.params.state || 'any'}`.toLowerCase();
        const wantConnected = requested === 'connected' || requested === 'any';
        const wantRinging = requested !== 'connected';

        if (targets.length === 0) {
            this.logger.error('pickup: no target specified');
            this.statusHook.send('pickup:error', this.params, {error: 'no target'});
            this.emit('done', false);
            return;
        }

        const domain = this.cs.req.locals.domain;
        const pickerTag = this.req.locals.fromHeader.params.tag;
        const activeCalls = getActiveCalls();

        // Step B - find the first target that has a matching call. For connected
        // calls the extension may be on either leg: the called party (uac, via
        // connectedClient) or the originator (uas, via a client-originated
        // From user). `keep` names the leg we bridge to the picker.
        const eligible = (X) => X !== this.cs && !X.handedOff && X.req.locals.domain === domain;

        const findRinging = () => {
            for (const ext of targets) {
                for (const [, X] of activeCalls) {
                    if (!eligible(X)) continue;
                    const r = X.ringing;
                    if (r && Array.isArray(r.addresses) && r.addresses.includes(ext)
                        && r.connection && !r.connection.isConnected && !r.connection.stolen) {
                        return {X, ext};
                    }
                }
            }
            return null;
        };

        const findConnected = () => {
            for (const ext of targets) {
                for (const [, X] of activeCalls) {
                    if (!eligible(X)) continue;
                    if (!(X.successfullyConnected && X.uacActive
                          && X.dialog && X.dialog.uas && X.dialog.uac)) continue;
                    if (X.connectedClient === ext) {
                        return {X, ext, keep: 'uas'}; // ext is the called party (uac)
                    }
                    // ext is the originator of a client-originated call
                    if (!X.req.locals.trunk && X.req.locals.fromUri.user === ext) {
                        return {X, ext, keep: 'uac'};
                    }
                }
            }
            return null;
        };

        // A still-ringing call ORIGINATED by this extension (an outbound call
        // that hasn't been answered yet). We can't bridge to an unanswered leg,
        // so this is handled by waiting for the far end to answer and then doing
        // a connected pickup (keep the uac/far-end leg, drop the originator).
        const findRingingOutbound = () => {
            for (const ext of targets) {
                for (const [, X] of activeCalls) {
                    if (!eligible(X)) continue;
                    const r = X.ringing;
                    if (r && r.connection && !r.connection.isConnected && !r.connection.stolen
                        && !X.req.locals.trunk && X.req.locals.fromUri
                        && X.req.locals.fromUri.user === ext) {
                        return {X, ext};
                    }
                }
            }
            return null;
        };

        // Prefer a ringing call; fall back to a connected one when allowed.
        let target = null; // {X, ext, keep}
        let state = null;  // the state of the call actually matched
        if (wantRinging) { target = findRinging(); if (target) state = 'ringing'; }
        if (!target && wantRinging) {
            // Take over a still-ringing OUTBOUND call: ring the picker, wait for
            // the far end to answer, then bridge it in as a connected pickup.
            const ro = findRingingOutbound();
            if (ro) {
                const answered = await this._awaitOutboundAnswer(ro);
                if (!answered) {
                    this.logger.info(`pickup: ringing outbound call from ${ro.ext} ended before takeover`);
                    return this._notFound(targets, requested);
                }
                target = {X: ro.X, ext: ro.ext, keep: 'uac'};
                state = 'connected';
            }
        }
        if (!target && wantConnected) { target = findConnected(); if (target) state = 'connected'; }

        if (!target) return this._notFound(targets, requested);

        const X = target.X;
        this.logger.info(`pickup: grabbing ${state} call at ${target.ext} from session ${X.req.get('Call-ID')}`);

        try {
            let sdpForPicker, sdpForRemote, remoteDialog, bridgeDetails;

            if (state === 'ringing') {
                // Step C - ringing path: cancel the ringing legs, take over the
                // caller (still in early media) and answer them fresh.
                if (!X.ringing.connection.stealForPickup()) {
                    this.logger.info('pickup: lost race stealing ringing call');
                    return this._notFound(targets, state);
                }
                X.handedOff = true;
                const aliceReq = X.req;
                const aliceRes = X.res;
                const aliceTag = X.req.locals.fromHeader.params.tag;

                // The caller's early-media/ringback rtpengine session is now
                // orphaned (session X is handed off and won't clean it up). Tear
                // it down and build a clean bridge under the picker's call-id.
                try {
                    await rtpClient.delete(RTPENGINE_PORT, RTPENGINE_HOST, X.details);
                } catch (e) {
                    this.logger.info({err: e && e.message}, 'pickup: delete of old rtpengine session failed (continuing)');
                }

                bridgeDetails = {'call-id': this.req.get('Call-Id'), 'from-tag': aliceTag};
                sdpForPicker = await bridgeOffer(bridgeDetails, aliceReq.body, X.srcCodecs, this.cs.srcCodecs);
                sdpForRemote = await bridgeAnswer(bridgeDetails, pickerTag, this.req.body);

                remoteDialog = await this.srf.createUAS(aliceReq, aliceRes, {localSdp: sdpForRemote});
            } else {
                // Step D - connected path: bridge the kept leg to the picker on a
                // fresh rtpengine call (the picker is an inbound offer, like the
                // ringing path), re-INVITE the kept leg onto it, then drop the
                // matched extension's leg.
                const keepIsUas = target.keep === 'uas';
                const keepDialog = keepIsUas ? X.dialog.uas : X.dialog.uac;
                const dropDialog = keepIsUas ? X.dialog.uac : X.dialog.uas;

                // The kept party's current SDP + codecs feed the fresh bridge.
                const keptSdp = keepIsUas
                    ? X.req.body
                    : (X.dialog.uac.remote && X.dialog.uac.remote.sdp);
                const keptCodecs = (keepIsUas ? X.srcCodecs : X.connectedCodecs) || X.srcCodecs;
                const keptTag = keepIsUas
                    ? X.req.locals.fromHeader.params.tag
                    : ((X.dialog.uac.sip && X.dialog.uac.sip.remoteTag) || X.req.locals.fromHeader.params.tag);

                if (!keptSdp) {
                    this.logger.info('pickup: could not resolve kept-leg SDP');
                    return this._notFound(targets, state);
                }

                X.handedOff = true;
                const oldDetails = X.details; // original rtpengine call, cleaned up below

                // Detach the connect verb's handlers from BOTH legs so its
                // uas-destroy cascade can't tear down the leg we are keeping.
                ['destroy', 'modify', 'info', 'refer'].forEach(ev => {
                    try { X.dialog.uas.removeAllListeners(ev); } catch (e) {}
                    try { X.dialog.uac.removeAllListeners(ev); } catch (e) {}
                });

                bridgeDetails = {'call-id': this.req.get('Call-Id'), 'from-tag': keptTag};
                sdpForPicker = await bridgeOffer(bridgeDetails, keptSdp, keptCodecs, this.cs.srcCodecs);
                sdpForRemote = await bridgeAnswer(bridgeDetails, pickerTag, this.req.body);

                await keepDialog.modify(sdpForRemote); // move kept party onto the new bridge
                try { dropDialog.destroy(); } catch (e) {} // BYE the matched extension
                try {
                    await rtpClient.delete(RTPENGINE_PORT, RTPENGINE_HOST, oldDetails);
                } catch (e) {
                    this.logger.info({err: e && e.message}, 'pickup: delete of old rtpengine session failed (continuing)');
                }
                // Unwind session X's parked run loop (its handlers are gone).
                try { X.activeConnection && X.activeConnection.emit('done', true); } catch (e) {}

                remoteDialog = keepDialog;
            }

            // Step E - answer the picker, adopt the bridge onto this session and
            // wire teardown (mirrors connectCall._onConnected).
            const dialogPicker = await this.srf.createUAS(this.req, this.res, {localSdp: sdpForPicker});

            this.cs.successfullyConnected = true;
            this.cs.dialog = { uas: dialogPicker, uac: remoteDialog };
            this.cs.uasActive = true;
            this.cs.uacActive = true;
            this.cs.details = bridgeDetails; // so run()'s killRTP cleanup targets the bridge

            let tornDown = false;
            const teardown = (endedby) => {
                if (tornDown) return;
                tornDown = true;
                try { rtpClient.delete(RTPENGINE_PORT, RTPENGINE_HOST, bridgeDetails); } catch (e) {}
                this.statusHook.send('pickup:hangup', this.params, {endedby});
                this.emit('done', true);
            };

            dialogPicker.on('destroy', () => {
                this.logger.info('pickup: call ended by picker');
                this.cs.uasActive = false;
                try { remoteDialog.destroy(); } catch (e) {}
                this.cs.uacActive = false;
                teardown('picker');
            });
            remoteDialog.on('destroy', () => {
                this.logger.info('pickup: call ended by remote party');
                this.cs.uacActive = false;
                try { dialogPicker.destroy(); } catch (e) {}
                this.cs.uasActive = false;
                teardown('remote');
            });
            dialogPicker.on('modify', (req, res) => { res.send(200); });
            remoteDialog.on('modify', (req, res) => { res.send(200); });

            this.statusHook.send('pickup:answered', this.params, {target: target.ext, state});
            this.logger.info(`pickup: bridged remote party to picker (${state})`);
        } catch (err) {
            this.logger.error({err}, 'pickup: failed to bridge call');
            this.statusHook.send('pickup:error', this.params, {error: err && err.message});
            // Fall through to the next verb / retry loop rather than sending our
            // own final response (matches connect's failure behaviour).
            this.emit('done', false);
        }
    }
}

module.exports = pickup;
