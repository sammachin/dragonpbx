const Emitter = require('events');
const rtpengine = require('rtpengine-client').Client
const { RTPENGINE_HOST, RTPENGINE_PORT } = require('../settings');

// helper functions

// clean up and free rtpengine resources when either side hangs up
function endCall(dlg1, dlg2, details) {
    [dlg1, dlg2].each((dlg) => {
      dlg.on('destroy', () => {(dlg === dlg1 ? dlg2 : dlg1).destroy();});
      rtpengine.delete(details);
    });
  }
  
// function returning a Promise that resolves with the SDP to offer A leg in 18x/200 answer
function getSdpA(details, remoteSdp, res) {
    return rtpengine.answer(Object.assign(details, {
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
        const details = {'call-id': this.req.get('Call-Id'), 'from-tag': from.params.tag};
        rtpengine.offer(RTPENGINE_PORT, RTPENGINE_HOST, Object.assign(details, {'sdp': this.req.body}))
        .then((rtpResponse) => {
            if (rtpResponse && rtpResponse.result === 'ok') return rtpResponse.sdp;
            throw new Error('rtpengine failure');
        })
        .then((sdpB) => {
            return srf.createB2BUA(this.req, this.res, dest, {
                localSdpB: sdpB,
                localSdpA: getSdpA.bind(null, details)
            });
        })
        .then(({uas, uac}) => {
            console.log('call connected with media proxy');
            endCall(uas, uac, details);
        })
        .catch((err) => {
            console.log(`Error proxying call with media: ${err}`);
        })  
    } 
}
module.exports = connectCall;