const Emitter = require('events');
const { setTimeout } = require("timers/promises")
const {generateDummySDP} = require('./utils/utils')
const fetchMedia = require('./utils/fetchMedia')
const { RTPENGINE_HOST, RTPENGINE_PORT } = require('../settings');

class announcement extends Emitter {
    constructor(cs, rtpClient, params) {
        super();
        this.name = 'announcement'
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
        const details = {'call-id': this.req.get('Call-Id'), 'from-tag': this.req.locals.fromHeader.params.tag};
        const dummyAnswer = {
            'call-id': this.req.get('Call-Id'),
            'sdp': generateDummySDP(),
            'from-tag' : this.req.locals.fromHeader.params.tag,
            'to-tag': this.req.locals.fromHeader.params.tag.split("").reverse().join("")
        }
        this.rtpClient.answer(RTPENGINE_PORT, RTPENGINE_HOST, dummyAnswer)
        .then((response) => {
            this.res.send(183, {
                body: response.sdp,
                headers: {
                    'Content-Type': 'application/sdp'
                }
            });
            this.logger.info(`Playing media ${this.media}`)
            this.statusHook.send('playback:start', this.params)
            this.rtpClient.playMedia(RTPENGINE_PORT, RTPENGINE_HOST,
                {
                'file': this.media,
                ...details
                }, (err, result) => {
                if (err) {
                    console.error('Error playing audio:', err);
                    this.emit('done', false)
                    this.sendStatus('playback:failed',this.params, {error: err})
                }
                setTimeout(result.duration)
                .then(() => {
                    this.emit('done', true)
                     this.statusHook.send('playback:complete', this.params, {duration: result.duration})
                })
            })
        });
        this.req.on('cancel', () =>{
            this.rtpClient.stopMedia(RTPENGINE_PORT, RTPENGINE_HOST, details)
            this.emit('done', false)
        })
    }
}

module.exports = announcement;
