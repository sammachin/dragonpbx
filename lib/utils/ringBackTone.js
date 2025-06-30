const rtpengine = require('rtpengine-client').Client
const rtpClient = new rtpengine();
const { RTPENGINE_HOST, RTPENGINE_PORT, DEFAULT_CODECS } = require('../settings');
const {generateDummySDP} = require('./utils/utils')

class ringbacktone extends Emitter {
    constructor(cs, rtpClient, params) {
        this.req = cs.req;
        this.res = cs.res;
        this.srf = cs.req.srf;
        this.logger = cs.logger;
        this.rtpClient = rtpClient;
        this.sdpB = cs.sdpB;
        this.params = params;
    }

    async play() {
        const dummyAnswer = {
            'call-id': this.req.get('Call-Id'),
            'sdp': generateDummySDP(),
            'from-tag' : this.req.locals.fromHeader.params.tag,
            'to-tag': this.req.locals.fromHeader.params.tag.split("").reverse().join("")
        }
        const details = {'call-id': this.req.get('Call-Id'), 'from-tag': this.req.locals.fromHeader.params.tag};
        rtpClient.answer(RTPENGINE_PORT, RTPENGINE_HOST, dummyAnswer)
        .then((response) => {
            this.res.send(183, {
                body: response.sdp,
                headers: {
                    'Content-Type': 'application/sdp'
                }
            });
            this.logger.info(`Playing ringbacktone ${this.media}`)
            this.rtpClient.playMedia(RTPENGINE_PORT, RTPENGINE_HOST,
                {
                'file': this.media,
                'repeat-duration': 60000,
                ...details
                }, (err, result) => {
                if (err) {
                    console.error('Error playing ringbacktone:', err);
                    this.emit('done', false)
                }
            })
        });
    }
}