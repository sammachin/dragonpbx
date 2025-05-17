const Emitter = require('events');
const { setTimeout } = require("timers/promises")

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
        this.params = params
    }

    async action(){
        const details = {'call-id': this.req.get('Call-Id'), 'from-tag': this.req.locals.fromHeader.params.tag};  
        this.res.send(183, {
            body: this.sdpB.replace('sendrecv', 'sendonly'),
            headers: {
                'Content-Type': 'application/sdp'
            }
        });
        this.logger.info(`Playing media ${this.params.url}`)
        this.rtpClient.playMedia(RTPENGINE_PORT, RTPENGINE_HOST,
            {
            'file': this.params.url,
            ...details
            }, (err, result) => {
            if (err) {
                console.error('Error playing audio:', err);
                this.emit('done', false)
            }
            setTimeout(result.duration)
            .then(() => {
                this.emit('done', true)
            })
        })
        this.req.on('cancel', () =>{
            this.rtpClient.stopMedia(RTPENGINE_PORT, RTPENGINE_HOST, details)
            this.emit('done', false)
        })
    } 
}
module.exports = announcement;