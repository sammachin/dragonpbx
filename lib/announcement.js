const Emitter = require('events');
const rtpengine = require('rtpengine-client').Client
const rtpClient = new rtpengine();

const { RTPENGINE_HOST, RTPENGINE_PORT } = require('../settings');
const { setTimeout } = require("timers/promises")

  
// function returning a Promise that resolves with the SDP to offer A leg in 18x/200 answer
function getSdpA(details, remoteSdp, res) {
    return rtpClient.answer(RTPENGINE_PORT, RTPENGINE_HOST, Object.assign(details, {
        'sdp': remoteSdp,
        'to-tag': res.getParsedHeader('To').params.tag
    }))
    .then((response) => {
      if (response.result !== 'ok') throw new Error(`Error calling answer: ${response['error-reason']}`);
      return response.sdp;
    })
}



class announcement extends Emitter {
    constructor(logger, req, res, rtpClient) {
        super();
        this.req = req;
        this.res = res;
        this.srf = req.srf;
        this.logger = logger.child({callId: req.get('Call-ID')});
        this.rtpClient = rtpClient;
    }

    async action(this){
        this.res.send(183, {
            body: sdpB,
            headers: {
                'Content-Type': 'application/sdp'
            }
        });
        this.rtpClient.playMedia(RTPENGINE_PORT, RTPENGINE_HOST,
            {
            'file': '/test_announcement.wav',
            ...details
            }, (err, result) => {
            if (err) {
                console.error('Error playing audio:', err);
                this.emit('accouncementEnd', false)
            }
            console.log(result)
            setTimeout(result.duration)
            this.emit('accouncementEnd', true)
        })
    } 
}
module.exports = announcement;