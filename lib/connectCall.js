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



class connectCall extends Emitter {
    constructor(logger, req, res, params) {
        super();
        this.req = req;
        this.res = res;
        this.srf = req.srf;
        this.logger = logger.child({callId: req.get('Call-ID')});
        this.rclient = this.req.locals.redisClient
        this.address = params.address
        this.timeout = params.timeout
        this.type = params.type
        this.cli = params.cli
    }

    async action(){
        let dest;
        switch (this.type) {
            case 'client':
                let key = `client:${this.req.locals.domain}:${this.address}`
                dest = await this.rclient.hGet(key, 'contact')
                break;
            case 'sip':
                dest = this.address;
                break;
            case 'trunk':
                //todo lookup trunk details from config
                dest = this.address;
                break
        }
        const from = this.cli
        const details = {'call-id': this.req.get('Call-Id'), 'from-tag': this.req.locals.fromHeader.params.tag};
        rtpClient.offer(RTPENGINE_PORT, RTPENGINE_HOST, Object.assign(details, {'sdp': this.req.body}))
        .then((rtpResponse) => {
            if (rtpResponse && rtpResponse.result === 'ok') return rtpResponse.sdp;
            throw new Error('rtpengine failure');
        })
        .then((sdpB) => {
            this.res.send(183, {
                body: sdpB,
                headers: {
                  'Content-Type': 'application/sdp'
                }
              });
              rtpClient.playMedia(RTPENGINE_PORT, RTPENGINE_HOST,
                {
                'file': '/test_announcement.wav',
                ...details
                }, (err, result) => {
                if (err) {
                  console.error('Error playing audio:', err);
                }
                console.log(result)
                setTimeout(result.duration)
                .then(() => {
                    console.log('CONNECTING CALL')
                    return this.srf.createB2BUA(this.req, this.res, dest, {
                        localSdpB: sdpB,
                        localSdpA: getSdpA.bind(null, details)
                    });
                })
                
              })
        })
        .then(({uas, uac}) => {
            this.logger.info('call connected via media proxy');
            uas.on('destroy', () => {
                this.logger.info('Call ended by A party') 
                uac.destroy();
                rtpClient.delete(RTPENGINE_PORT, RTPENGINE_HOST, details);
        
              });
              uac.on('destroy', () => {
                this.logger.info('Call ended by B party') 
                uas.destroy();
                rtpClient.delete(RTPENGINE_PORT, RTPENGINE_HOST, details);
              });
            
        })
        .catch((err) => {
            this.logger.error(`Error proxying call with media: ${err}`);
        })  
    } 
}
module.exports = connectCall;