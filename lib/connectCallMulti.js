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



class connectionMulti extends Emitter {
    constructor(cs, params) {
        super();
        this.name = 'connection'
        this.req = cs.req;
        this.res = cs.res;
        this.srf = cs.req.srf;
        this.logger = cs.logger
        this.sdpB = cs.sdpB
        this.rClient = cs.req.locals.redisClient
        this.details = cs.details
        this.params = params
        this.activeUACs = new Map()
        this.callConnected = false
    }

    async getDest() {
        // Handle multiple destinations in params
        if (Array.isArray(this.params)) {
            return Promise.all(this.params.map(param => this.getDestForParam(param)));
        } else {
            return [await this.getDestForParam(this.params)];
        }
    }
    
    async getDestForParam(param) {
        let domain = this.req.locals.domain;
        let destInfo = { type: param.type };
        
        switch (param.type) {
            case 'client':
                this.logger.info(`Looking up dest for client ${param.address} in ${domain}`);
                let key = `client:${domain}:${param.address}`;
                let cdest = await this.rClient.hGet(key, 'contact');
                destInfo.dest = cdest;
                destInfo.timeout = param.timeout || 30;
                return destInfo;
                
            case 'sip':
                if ('username' in param) {
                    destInfo.auth = {
                        username: param.username,
                        password: param.password
                    };
                }
                destInfo.dest = param.address;
                destInfo.timeout = param.timeout || 30;
                return destInfo;
                
            case 'trunk':
                this.logger.info(`Looking up trunk ${param.trunk_id ? param.trunk_id : param.trunk_name} in ${domain}`);
                let trunk;
                if ('trunk_id' in param) {
                    trunk = await getTrunkById(domain, param.trunk_id);
                } else if ('trunk_name' in param) {
                    trunk = await getTrunkByName(domain, param.trunk_name);
                } else {
                    throw new Error('Trunk must specify ID or Name');
                }
                
                destInfo.dest = `${param.address}@${trunk.outbound.host}`;
                if ('username' in trunk.outbound) {
                    destInfo.auth = {
                        username: trunk.outbound.username,
                        password: trunk.outbound.password
                    };
                }
                destInfo.timeout = param.timeout || 30;
                return destInfo;
                
            default:
                throw new Error(`Unknown destination type: ${param.type}`);
        }
    }
    
    async action() {
        const destinations = await this.getDest();
        this.logger.info(`Connecting call to ${destinations.length} destinations in parallel`);       
        const details = {
            'call-id': this.req.get('Call-Id'), 
            'from-tag': this.req.locals.fromHeader.params.tag
        };

        // Array to store all B2BUA attempts
        this.b2bCalls = [];
        this.isConnected = false;
        
        // Create promises for each B2BUA attempt
        const b2bPromises = destinations.map((d, index) => {
            let ringTimer = d.timeout*1000 || 30000
            return new Promise((resolve, reject) => {
            this.srf.createB2BUA(this.req, this.res, d.dest, {
                headers: {
                'X-Original-Call-ID': details.callId,
                'X-Endpoint-Index': index
                },        
            },
            {
                cbRequest: async(err, reqB) => {
                    if (err) return this.logger.error({err}, 'error sending INVITE for B leg');
                    this.b2bCalls[index] = {reqB, status: 'trying'}
                    this.b2bCalls[index].ringTimeout = setTimeout(() =>{   
                        console.log('Cancelling call due to timeout')   
                        reqB.cancel()
                    }, ringTimer)
                }
            }
        )
                .then((dialog) => {
                // Store the successful dialog
                this.b2bCalls[index].status= 'connected' ;
                this.b2bCalls[index].dialog = dialog ;
                console.log(`Call was answered by index: ${index}`)
                clearTimeout(this.b2bCalls[index].ringTimeout)
                if (!this.isConnected) {
                    this.isConnected = true;
                    resolve(dialog);
                    
                    // End all other calls
                    this.b2bCalls.forEach((call, idx) => {
                    if (idx !== index && call && call.reqB) {
                        console.log('ending call attempt: ', idx)
                        call.reqB.cancel();
                        clearTimeout(call.ringTimeout)

                    }
                    });
                } else {
                    // This call was successful but another one already won the race
                    dialog.uas.destroy();
                    reject(new Error('Another call was already connected'));
                }
                })
                .catch((err) => {
                    if (!this.isConnected) {
                        console.log('Error on call index: ', index)
                        this.b2bCalls[index] = { status: 'failed', error: err };
                        clearTimeout(this.b2bCalls[index].ringTimeout)
                        reject(err);
                    }
                });
            });
        });
        
        // Wait for the first successful call
        Promise.race(b2bPromises)
            .then((dialog) => {
                dialog.uas.on('destroy', () => {
                    this.logger.info('Call ended by A party') 
                    dialog.uac.destroy();
                    //rtpClient.delete(RTPENGINE_PORT, RTPENGINE_HOST, details);
                    this.emit('callEnd', {complete: true, endedBy: 'A'})
                    this.emit('done', true)
                });
                dialog.uac.on('destroy', () => {
                    this.logger.info('Call ended by B party') 
                    dialog.uas.destroy();
                    //rtpClient.delete(RTPENGINE_PORT, RTPENGINE_HOST, details);
                    this.emit('callEnd', {complete: true, endedBy: 'B'})
                    this.emit('done', true)
                });
            })
            .catch((err) => {
            console.error('All B2BUA attempts failed:', err);1
            // Only send failure response if no successful connection was made
            if (!this.isConnected) {
                this.res.send(500);
            }
            });
        
    }       
}

module.exports = connectionMulti;