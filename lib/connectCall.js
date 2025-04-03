const Emitter = require('events');

const rtpengine = require('rtpengine-client').Client
const rtpClient = new rtpengine();
const { RTPENGINE_HOST, RTPENGINE_PORT } = require('../settings');

const { getTrunkById, getTrunkByName} = require('./data/json/lookup')

  
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



class connection extends Emitter {
    constructor(cs, params) {
        super();
        this.name = 'connection'
        this.req = cs.req;
        this.res = cs.res;
        this.srf = cs.req.srf;
        this.logger = cs.logger.child({callId: this.req.get('Call-ID')});
        this.sdpB = cs.sdpB
        this.rClient = cs.req.locals.redisClient
        this.details = cs.details
        this.params = params
    }

    async getDest() {
        let domain = this.req.locals.domain
        switch (this.params.type) {
            case 'client':
                this.logger.info(`Looking up dest for client ${this.params.address} in ${domain}`)
                let key = `client:${domain}:${this.params.address}`
                let cdest = await this.rClient.hGet(key, 'contact')
                return cdest
            case 'sip':
                return this.params.address;
            case 'trunk':
                this.logger.info(`Looking up trunk ${this.params.trunk_id ? this.params.trunk_id : this.params.trunk_name } in ${domain}`)
                if ('trunk_id' in this.params){
                    console.log('unsing trunk id')
                    this.trunk = await getTrunkById(domain, this.params.trunk_id)
                } else if ('trunk_name' in this.params){
                    this.trunk = await getTrunkByName(domain, this.params.trunk_name)
                } else {
                    throw error ('Trunk must specify ID or Name')
                }
                let tdest = `${this.params.address}@${this.trunk.outbound}`
                return  tdest;
        }
        
    }
    
    async action(){
        this.dest = await this.getDest(this.params, this.req.locals.domain, this.rClient, this.logger)
        this.logger.info(`Connecting Call to ${this.dest}`)
        let opts = {}
        const details = {'call-id': this.req.get('Call-Id'), 'from-tag': this.req.locals.fromHeader.params.tag};
        opts.localSdpB = this.sdpB
        opts.localSdpA = getSdpA.bind(null, details)
        opts.passFailure = false
        let ringTimeout = false
        let ringTimer = this.params.timeout*1000 || 30000
        try{
            const {uas, uac} = await this.srf.createB2BUA(
                this.req, 
                this.res, 
                this.dest, 
                opts, 
                {
                    cbRequest: async(err, reqB) => {
                        if (err) return this.logger.error({err}, 'error sending INVITE for B leg');
                        ringTimeout = setTimeout(() =>{   
                            console.log('Cancelling call due to timeout')   
                            reqB.cancel()
                        }, ringTimer)
                    }
                }
            )
            this.logger.info('Call connected');
            clearTimeout(ringTimeout)
            uas.on('destroy', () => {
                this.logger.info('Call ended by A party') 
                uac.destroy();
                //rtpClient.delete(RTPENGINE_PORT, RTPENGINE_HOST, details);
                this.emit('callEnd', {complete: true, endedBy: 'A'})
                this.emit('done', true)
            });
            uac.on('destroy', () => {
                this.logger.info('Call ended by B party') 
                uas.destroy();
                //rtpClient.delete(RTPENGINE_PORT, RTPENGINE_HOST, details);
                this.emit('callEnd', {complete: true, endedBy: 'B'})
                this.emit('done', true)
            });
        }
        catch (error) {
            clearTimeout(ringTimeout)
            this.logger.info(`Call failed, with status ${error.status}`)
            this.emit('callEnd', {complete: false, status: error.status})
            this.emit('done', false)
        }
    } 
}
module.exports = connection;