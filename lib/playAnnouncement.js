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
        this.logger = cs.req.logger;
        this.rtpClient = rtpClient;
        this.sdpB = cs.sdpB;
        this.params = params
    }

    async action(){
        console.log(this.params)
        const details = {'call-id': this.req.get('Call-Id'), 'from-tag': this.req.locals.fromHeader.params.tag};  
        this.res.send(183, {
            body: this.sdpB.replace('sendrecv', 'sendonly'),
            headers: {
                'Content-Type': 'application/sdp'
            }
        });
        this.rtpClient.playMedia(RTPENGINE_PORT, RTPENGINE_HOST,
            {
            'file': this.params.url,
            ...details
            }, (err, result) => {
            if (err) {
                console.error('Error playing audio:', err);
                this.emit('done', false)
            }
            console.log(result)
            setTimeout(result.duration)
            .then(() => {
                this.emit('done', true)
            })
            
        })
    } 
}
module.exports = announcement;