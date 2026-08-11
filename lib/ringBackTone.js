const Emitter = require('events');

const rtpengine = require('rtpengine-client').Client
const rtpClient = new rtpengine();
const { RTPENGINE_HOST, RTPENGINE_PORT, DEFAULT_RINGTONE } = require('../settings');
const {generateDummySDP} = require('./utils/utils')
const fetchMedia = require('./utils/fetchMedia')


class ringbacktone extends Emitter {
    constructor(cs, params) {
        super();
        this.req = cs.req;
        this.res = cs.res;
        this.srf = cs.req.srf;
        this.logger = cs.logger;
        this.sdpB = cs.sdpB;
        this.ringtone = params.ringtone || DEFAULT_RINGTONE
        this.details = {}
        this.playing = false
        this.ringBackToneFile = null


    this.on('play', (opts = {}) => {
        if (this.playing || this.starting) {
            this.logger.info('PLAY ignored — already playing/starting')
            return;
        }
        if (!this.ringBackToneFile) {
            this.logger.info('PLAY ignored — no ringback file available')
            return;
        }
        this.starting = true;
        this.logger.info('PLAY')
        this.details = {'call-id': this.req.get('Call-Id'), 'from-tag': this.req.locals.fromHeader.params.tag};

        const startPlayback = () => {
            this.logger.info(`Playing ringbacktone ${this.ringBackToneFile}`)
            this.playing = true
            rtpClient.playMedia(RTPENGINE_PORT, RTPENGINE_HOST,
                {
                'file': this.ringBackToneFile,
                'repeat-times': 600,
                ...this.details
                }, (err, result) => {
                if (err) {
                    console.error('Error playing ringbacktone:', err);
                    this.emit('done', false)
                }
            })
        }

        // Use B-party's actual to-tag (captured from its 180 Ringing) so
        // the dummy answer creates the *real* callee monologue with the
        // offer's port allocated to it. When the real 200 OK arrives,
        // getSdpA does another `answer` with the same to-tag — rtpengine
        // treats this as an update of the existing monologue, preserving
        // the offer's B-side port. This means callees (including Bria)
        // that send RTP to the offer's port hit the real callee monologue,
        // and the SIPREC subscription captures their media correctly.
        //
        // Fallback to reversed-from-tag when no real to-tag is available
        // (e.g. reconnect, where there's no provisional response to
        // extract a tag from).
        const toTag = opts.toTag || this.req.locals.fromHeader.params.tag.split("").reverse().join("");

        const dummyAnswer = {
            'call-id': this.req.get('Call-Id'),
            'sdp': generateDummySDP(),
            'from-tag' : this.req.locals.fromHeader.params.tag,
            'to-tag': toTag,
            'ICE': 'remove'
        }
        rtpClient.answer(RTPENGINE_PORT, RTPENGINE_HOST, dummyAnswer)
        .then((response) => {
            this.starting = false;
            if (!opts.reconnect) {
                // Initial call: establish early media via 183
                this.res.send(183, {
                    body: response.sdp,
                    headers: {
                        'Content-Type': 'application/sdp'
                    }
                });
            }
            startPlayback()
        })
        .catch((err) => {
            this.starting = false;
            this.logger.error({err: err.message || err}, 'ringback: dummy answer failed');
        });
    })
    this.on('stop', () => {
         this.logger.info('STOP')
        if (this.playing) {
            this.logger.info('STOPPING')
            rtpClient.stopMedia(RTPENGINE_PORT, RTPENGINE_HOST,
                {...this.details
                }, (err, result) => {
                if (err) {
                    console.error('Error stopping ringbacktone:', err);
                    this.emit('done', false)
                }
            })
        }
    })
    }

    async init() {
        try {
            this.ringBackToneFile = await fetchMedia(this.ringtone);
        } catch (err) {
            this.logger.error({err: err.message || err, ringtone: this.ringtone},
                'ringback: failed to fetch configured ringtone, falling back to default');
            if (this.ringtone !== DEFAULT_RINGTONE) {
                try {
                    this.ringBackToneFile = await fetchMedia(DEFAULT_RINGTONE);
                } catch (err2) {
                    this.logger.error({err: err2.message || err2},
                        'ringback: failed to fetch default ringtone, continuing without ringback');
                    this.ringBackToneFile = null;
                }
            } else {
                this.ringBackToneFile = null;
            }
        }
        this.logger.debug(`ringBackToneFile: ${this.ringBackToneFile}`);
    }
}
 module.exports = ringbacktone;
