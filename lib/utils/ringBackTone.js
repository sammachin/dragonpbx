const Emitter = require('events');

const rtpengine = require('rtpengine-client').Client
const rtpClient = new rtpengine();
const { RTPENGINE_HOST, RTPENGINE_PORT, DEFAULT_RINGTONE } = require('../../settings');
const {generateDummySDP} = require('./utils')

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
    

    this.on('play', () => {
        this.logger.info('PLAY')
        const dummyAnswer = {
            'call-id': this.req.get('Call-Id'),
            'sdp': generateDummySDP(),
            'from-tag' : this.req.locals.fromHeader.params.tag,
            'to-tag': this.req.locals.fromHeader.params.tag.split("").reverse().join("")
        }
        this.details = {'call-id': this.req.get('Call-Id'), 'from-tag': this.req.locals.fromHeader.params.tag};
        rtpClient.answer(RTPENGINE_PORT, RTPENGINE_HOST, dummyAnswer)
        .then((response) => {
            this.res.send(183, {
                body: response.sdp,
                headers: {
                    'Content-Type': 'application/sdp'
                }
            });
            this.logger.info(`Playing ringbacktone ${this.ringtone}`)
            this.playing = true
            rtpClient.playMedia(RTPENGINE_PORT, RTPENGINE_HOST,
                {
                'file': this.ringtone,
                'repeat-times': 600,
                ...this.details
                }, (err, result) => {
                if (err) {
                    console.error('Error playing ringbacktone:', err);
                    this.emit('done', false)
                }
            })
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
}
 module.exports = ringbacktone;