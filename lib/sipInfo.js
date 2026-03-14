const Emitter = require('events');
const rtpengine = require('rtpengine-client').Client
const rtpClient = new rtpengine();
const { RTPENGINE_HOST, RTPENGINE_PORT} = require('../settings');


class sipInfo extends Emitter {
    constructor(cs) {
        super();
        this.req = cs.req;
        this.res = cs.res;
        this.srf = cs.req.srf;
        this.logger = cs.logger;  


    this.on('info', (req, res, type) => {
        const contentType = req.get('Content-Type');
        if (['application/dtmf-relay', 'application/dtmf'].includes(contentType)) {
            const arr = /Signal=\s*([0-9#*])/.exec(req.body);
            if (!arr) {
                this.logger.error({body: req.body}, '_onInfo: invalid INFO dtmf request');
                res.send(400)
            }
            const code = arr[1];
            const arr2 = /Duration=\s*(\d+)/.exec(req.body);
            const duration = arr2 ? arr2[1] : 250;
            /* else convert SIP INFO to RFC 2833 telephony events */
            this.logger.debug({code, duration}, `got SIP INFO DTMF from ${type}, converting to RFC 2833`);
            const opts = {
                'call-id': this.req.get('Call-Id'),
                'from-tag': this.req.locals.fromHeader.params.tag,
                code,
                duration
            };
            rtpClient.playDTMF(RTPENGINE_PORT, RTPENGINE_HOST, opts)
                .then((response) => {
                    if ('ok' !== response.result) {
                    this.logger.error({response}, `rtpengine playDTMF failed with ${JSON.stringify(response)}`);
                    res.send(400)
                    } else {
                        res.send(200);
                    }
                })
        } else {
            /* something other than DTMF we just ack for now */
            res.send(200)
        }
        })
    }
}

 module.exports = sipInfo;
    
  