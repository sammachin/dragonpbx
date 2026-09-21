const Emitter = require('events');
const { setTimeout } = require("timers/promises")
const {generateDummySDP} = require('./utils/utils')
const fetchMedia = require('./utils/fetchMedia')
const { RTPENGINE_HOST, RTPENGINE_PORT } = require('../settings');

class announcement extends Emitter {
    constructor(cs, rtpClient, params) {
        super();
        this.name = 'announcement'
        this.cs = cs;
        this.req = cs.req;
        this.res = cs.res;
        this.srf = cs.req.srf;
        this.logger = cs.logger;
        this.rtpClient = rtpClient;
        this.sdpB = cs.sdpB;
        this.params = params;
        this.media = null; // Will be set by static factory method
        this.statusHook = cs.statusHook
    }

    // Static factory method to create and initialize the instance
    static async create(cs, rtpClient, params) {
        const instance = new announcement(cs, rtpClient, params);
        instance.media = await fetchMedia(params.url);
        return instance;
    }

    async action(){
        // On an already-answered leg (a reconnect / updateLeg) play into that
        // leg's existing rtpengine session and do NOT send a provisional 183
        // (only valid pre-answer / early media). cs.details already points at the
        // controlling leg's session (A, or B after the updateLeg swap).
        const answered = this.cs.successfullyConnected;
        const details = answered
            ? this.cs.details
            : {'call-id': this.req.get('Call-Id'), 'from-tag': this.req.locals.fromHeader.params.tag};
        const legSdp = (this.cs.activeLeg && this.cs.activeLeg.sdp) ? this.cs.activeLeg.sdp : this.req.body;
        await this.rtpClient.offer(RTPENGINE_PORT, RTPENGINE_HOST, {
            ...details,
            'sdp': legSdp
        });
        const dummyAnswer = {
            'call-id': details['call-id'],
            'sdp': generateDummySDP(),
            'from-tag' : details['from-tag'],
            'to-tag': details['from-tag'].split("").reverse().join("")
        }
        // Guard so we only ever finish the activity once (caller hangup can race
        // playback completion).
        let finished = false;
        const finish = (ok) => { if (finished) return; finished = true; this.emit('done', ok); };

        this.rtpClient.answer(RTPENGINE_PORT, RTPENGINE_HOST, dummyAnswer)
        .then(async (response) => {
            if (answered) {
                // Already-answered leg (reconnect/updateLeg): nothing to send on
                // the SIP side; play into the existing session.
            } else if (this.params.answer === true) {
                // Force-answer: send 200 OK to establish the dialog and adopt it
                // onto the session, so the announcement plays on an answered call
                // and any following verbs run in reconnect mode. Without this the
                // playback is early media (a 183), the default.
                try {
                    const dialog = await this.srf.createUAS(this.req, this.res, {localSdp: response.sdp});
                    this.cs.dialog = { uas: dialog };
                    this.cs.successfullyConnected = true;
                    this.cs.uasActive = true;
                    this.cs.details = details;
                    dialog.on('modify', (req, res) => { res.send(200); });
                    dialog.on('destroy', () => {
                        this.logger.info('announce: call ended by caller');
                        this.cs.uasActive = false;
                        this.cs.callActive = false;
                        this.rtpClient.stopMedia(RTPENGINE_PORT, RTPENGINE_HOST, details);
                        finish(true);
                    });
                    this.logger.info('announce: answered call before playback');
                } catch (err) {
                    this.logger.error({err: err.message || err}, 'announce: failed to answer call');
                    return finish(false);
                }
            } else {
                // Default: early media via 183.
                this.res.send(183, {
                    body: response.sdp,
                    headers: {
                        'Content-Type': 'application/sdp'
                    }
                });
            }
            this.logger.info(`Playing media ${this.media}`)
            this.statusHook.send('playback:start', this.params)
            this.rtpClient.playMedia(RTPENGINE_PORT, RTPENGINE_HOST,
                {
                'file': this.media,
                ...details
                }, (err, result) => {
                if (err) {
                    console.error('Error playing audio:', err);
                    this.statusHook.send('playback:failed', this.params, {error: err})
                    return finish(false)
                }
                setTimeout(result.duration)
                .then(() => {
                    this.statusHook.send('playback:complete', this.params, {duration: result.duration})
                    finish(true)
                })
            })
        });
        this.req.on('cancel', () =>{
            this.rtpClient.stopMedia(RTPENGINE_PORT, RTPENGINE_HOST, details)
            finish(false)
        })
    }
}

module.exports = announcement;
