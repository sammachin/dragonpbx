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
    constructor(cs, conn) {
        super();
        this.name = 'connection'
        this.req = cs.req;
        this.res = cs.res;
        this.srf = cs.req.srf;
        this.logger = cs.logger
        this.sdpB = cs.sdpB
        this.rClient = cs.req.locals.redisClient
        this.details = cs.details
        this.dests = conn.dest
        this.activeUACs = new Map()
        this.callConnected = false
        this.cs = cs
        this.reconnect = conn.reconnect || false
    }

    async getDest() {
        // Handle multiple destinations in params
        if (Array.isArray(this.dests)) {
            return Promise.all(this.dests.map(param => this.getDestForParam(param)));
        } else {
            return [await this.getDestForParam(this.dests)];
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
        if (this.cs.successfullyConnected && !this.reconnect){
            this.logger.info('Skipping action as call had already been connected ')
            this.emit('done')
        } 
        else {
            const destinations = await this.getDest();
            if (destinations.length >1){
                this.logger.info(`Offering call to ${destinations.length} destinations in parallel`);      
            }
                    
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
                let opts = {}
                opts.localSdpB = this.sdpB
                opts.localSdpA = getSdpA.bind(null, details)
                opts.passFailure = false
                opts.heaaders =  {
                    'X-Endpoint-Index': index
                }        
                if (this.auth) opts.auth = this.auth;
                this.logger.info(`Sending INVITE to  ${d.dest} index: ${index}`);
                return new Promise((resolve, reject) => {
                this.srf.createB2BUA(this.req, this.res, 
                    d.dest, 
                    opts,
                {
                    cbRequest: async(err, reqB) => {
                        if (err) return this.logger.error({err}, 'error sending INVITE for B leg');
                        this.b2bCalls[index] = {reqB, status: 'trying'}
                        this.b2bCalls[index].ringTimeout = setTimeout(() =>{   
                            this.logger.info(`Cancelling ringing index ${index} due to timeout`)   
                            reqB.cancel()
                        }, ringTimer)
                    }
                }
            )
                    .then((dialog) => {
                    // Store the successful dialog
                    this.b2bCalls[index].status= 'connected' ;
                    this.b2bCalls[index].dialog = dialog ;
                    this.logger.info(`Call was answered by index: ${index}`)
                    clearTimeout(this.b2bCalls[index].ringTimeout)
                    if (!this.isConnected) {
                        this.isConnected = true;
                        resolve(dialog);
                        
                        // End all other calls
                        this.b2bCalls.forEach((call, idx) => {
                        if (idx !== index && call && call.reqB) {
                            this.logger.info(`Cancel ringing on index: ${idx}`)
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
                        this.logger.error(`Error from call index: ${index} status ${err.status}`)
                        this.b2bCalls[index].status = 'failed';
                        clearTimeout(this.b2bCalls[index].ringTimeout)
                        //Check if all call attempts have now failed
                        let allFailed = true 
                        this.b2bCalls.forEach(c => {
                            if (c.status != "failed"){
                                allFailed=false
                            }
                        });
                        if (allFailed){
                            reject()
                        }
                        
                        
                    });
                });
            });
            
            // Wait for the first successful call
            Promise.race(b2bPromises)
                .then((dialog) => {
                    this.cs.successfullyConnected = true
                    this.cs.dialog = dialog
                    this.cs.uasActive = true
                    this.cs.uacActive = true
                    dialog.uas.on('destroy', () => {
                        this.logger.info('Call ended by A party')
                        this.cs.uasActive= false
                        dialog.uac.destroy()
                        .then(() => {
                            this.cs.uacActive = false
                            this.emit('callEnd', {complete: true, endedBy: 'A'})
                            this.emit('done', true)
                        });
                    });
                    dialog.uac.on('destroy', () => {
                        this.cs.uacActive=false
                        this.logger.info('Call ended by B party') 
                        this.emit('callEnd', {complete: true, endedBy: 'B'})
                        this.emit('done', true)
                    });
                    dialog.uac.on('modify', (req, res) => {
                        this.logger.info('ReINVITE Recieved')
                        res.send(200)
                    })
                    dialog.uac.on('refer', (req, res) => {
                        this.logger.info('REFER Recieved')
                        console.log(req)
                        res.send(200)
                    })
                })
                .catch((err) => {
                this.logger.error('All connection attempts failed:');
                // Only send failure response if no successful connection was made
                this.emit('done', false)
                });
        }     
    }  
}

module.exports = connectionMulti;