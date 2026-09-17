const Emitter = require('events');

const rtpengine = require('rtpengine-client').Client
const rtpClient = new rtpengine();
const { RTPENGINE_HOST, RTPENGINE_PORT } = require('../settings');

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
//   { verb: 'pickup', target: '1001' }                     // ringing (default)
//   { verb: 'pickup', target: ['1001','1002'] }            // first ringing wins
//   { verb: 'pickup', target: '1001', state: 'connected' } // steal a live call
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
        try { this.res.send(486, 'Nothing to pick up'); } catch (e) {}
        this.emit('done', false);
    }

    async action() {
        this.statusHook.send('pickup:start', this.params);

        // Step A - normalise params
        const raw = this.params.target;
        const targets = (Array.isArray(raw) ? raw : [raw])
            .filter(d => d !== undefined && d !== null && `${d}` !== '')
            .map(d => `${d}`);
        const state = this.params.state === 'connected' ? 'connected' : 'ringing';

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
        let target = null; // {X, ext, keep}
        for (const ext of targets) {
            for (const [, X] of activeCalls) {
                if (X === this.cs || X.handedOff) continue;
                if (X.req.locals.domain !== domain) continue;
                if (state === 'ringing') {
                    const r = X.ringing;
                    if (r && Array.isArray(r.addresses) && r.addresses.includes(ext)
                        && r.connection && !r.connection.isConnected && !r.connection.stolen) {
                        target = {X, ext};
                        break;
                    }
                } else { // connected
                    if (!(X.successfullyConnected && X.uacActive
                          && X.dialog && X.dialog.uas && X.dialog.uac)) continue;
                    if (X.connectedClient === ext) {
                        target = {X, ext, keep: 'uas'}; // ext is the called party (uac)
                        break;
                    }
                    // ext is the originator of a client-originated call
                    if (!X.req.locals.trunk && X.req.locals.fromUri.user === ext) {
                        target = {X, ext, keep: 'uac'};
                        break;
                    }
                }
            }
            if (target) break;
        }

        if (!target) return this._notFound(targets, state);

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
            try { if (!this.res.finished) this.res.send(480, 'Pickup failed'); } catch (e) {}
            this.emit('done', false);
        }
    }
}

module.exports = pickup;
