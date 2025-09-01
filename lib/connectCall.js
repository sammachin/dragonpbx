const Emitter = require('events');

const rtpengine = require('rtpengine-client').Client
const rtpClient = new rtpengine();
const { RTPENGINE_HOST, RTPENGINE_PORT, DEFAULT_CODECS } = require('../settings');
const { getTrunkById, getTrunkByName} = require('./data/json/lookup')
const {prepareTransfer} = require('./transferCall')
const ringbacktone = require('./ringBackTone')

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

async function getSdpB(details, sdp, srcCodecs, dstCodecs ){
    return rtpClient.offer(RTPENGINE_PORT, RTPENGINE_HOST, Object.assign(details, {
        'sdp': sdp,
        'codec': { accept: ['telephone-event'], 'mask': srcCodecs, 'transcode': dstCodecs }
    }))
    .then((rtpResponse) => {
        if (rtpResponse && rtpResponse.result === 'ok') return rtpResponse.sdp;
        throw new Error('rtpengine failure');
    })
}


class connection extends Emitter {
    constructor(cs, params, transfer) {
        super();
        this.name = 'connection'
        this.req = cs.req;
        this.res = cs.res;
        this.srf = cs.req.srf;
        this.logger = cs.logger
        this.sdpB = cs.sdpB
        this.rClient = cs.req.locals.redisClient
        this.details = cs.details
        this.dests = params.dest
        this.activeUACs = new Map()
        this.callConnected = false
        this.cs = cs
        this.reconnect = params.reconnect || false
        this.transfer = transfer,
        this.statusHook = cs.statusHook
        this.params = params
        this.ringtone = false
    }

    static async create(cs, params, transfer) {
        const instance = new connection(cs, params, transfer);
        instance.ringtone = new ringbacktone(cs, params)
        await instance.ringtone.fetchMedia()
        return instance;
    }

    async getDest() {
    // Handle multiple destinations in params
    if (Array.isArray(this.dests)) {
        const results = await Promise.all(this.dests.map(param => this.getDestForParam(param)));
        return results.filter(result => result !== false);
    } else {
        const result = await this.getDestForParam(this.dests);
        return result !== false ? [result] : [];
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
                let codecs = await this.rClient.hGet(key, 'codecs');
                let proxy =  await this.rClient.hGet(key, 'proxy');
                destInfo.dest = cdest;
                destInfo.timeout = param.timeout || 30;
                destInfo.codecs = JSON.parse(codecs);
                destInfo.proxy = proxy ? proxy : null;
                destInfo.headers = param.headers
		this.logger.info(destInfo);
		if (destInfo.dest === null) {
                  return false;
		} else {
		  return destInfo
		}
            case 'sip':
                if ('username' in param) {
                    destInfo.auth = {
                        username: param.username,
                        password: param.password
                    };
                }
                destInfo.dest = param.address;
                destInfo.timeout = param.timeout || 30;
                destInfo.codecs = param.codecs || DEFAULT_CODECS;
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
                destInfo.codecs = trunk.codecs
                return destInfo;
            default:
                throw new Error(`Unknown destination type: ${param.type}`);
        }
    }
    
    async action() {
        this.statusHook.send('connect:start', this.params)
        if (this.cs.successfullyConnected && !this.reconnect && !this.transfer){
            this.logger.info('Skipping action as call had already been connected ')
            this.emit('done')
            this.statusHook.send('connect:skipped', this.params)
        } else if (this.cs.successfullyConnected && (this.reconnect || this.transfer)) {
            // this is a reConnect attempt
            this.logger.info('reConnect or transfer action')
            const destinations = await this.getDest();
            if (destinations.length >1){
                this.logger.info(`Offering call to ${destinations.length} destinations in parallel`);      
            }
                    
            const details = {
                'call-id': this.req.get('Call-Id'), 
                'from-tag': this.req.locals.fromHeader.params.tag
            };
            // Array to store all uac attempts
            this.uacCalls = [];
            this.isConnected = false;
            
            // Create promises for each UAC attempt
            const uacPromises = destinations.map(async (d, index) => {
                let ringTimer = d.timeout*1000 || 30000
                let opts = {}
                // send another offer message to rtpengine with the src and dest codecs
                opts.localSdp = await getSdpB(details, this.req.body, this.cs.srcCodecs, d.codecs )
                opts.headers =  {
                    'X-Endpoint-Index': index,
                    ...d.headers
                }
                opts.callingNumber = this.params.callerId || this.req.locals.fromUri.user
                opts.callingName = this.params.callerName || opts.callingNumber
                opts.proxy = d.proxy ? d.proxy : null        
                if (this.auth) opts.auth = this.auth;
                this.logger.info(`Sending INVITE to  ${d.dest} index: ${index}`);
                return new Promise((resolve, reject) => {
                this.srf.createUAC(d.dest, 
                    opts,
                    {
                    cbRequest: async(err, reqB) => {
                        if (err) {
                            this.statusHook.send('connect:error ', this.params, {dest: d.dest, index: index, error: err})
                            return this.logger.error({err}, 'error sending INVITE for B leg');
                        }
                        this.statusHook.send('connect:trying ', this.params, {dest: d.dest, index: index})
                        this.uacCalls[index] = {reqB, status: 'trying'}
                        this.uacCalls[index].ringTimeout = setTimeout(() =>{   
                            this.logger.info(`Cancelling ringing index ${index} due to timeout`)
                            this.statusHook.send('connect:timeout ', this.params, {dest: d.dest, index: index})
                            reqB.cancel()
                        }, ringTimer)
                    }

                    
                    }
                )
                .then((uac) => {
                      // Store the successful dialog
                    this.uacCalls[index].status= 'connected' ;
                    this.uacCalls[index].uac = uac ;
                    this.logger.info(`Call was answered by index: ${index}`)
                    this.statusHook.send('connect:answered ', this.params, {dest: d.dest, index: index})
                    clearTimeout(this.uacCalls[index].ringTimeout)
                    let newSDP = rtpClient.answer(RTPENGINE_PORT, RTPENGINE_HOST, Object.assign(details, {
                        'sdp': uac.remote.sdp,
                        'to-tag': uac.sip.localTag
                    }))
                    .then((response) => {
                      if (response.result !== 'ok') throw new Error(`Error calling answer: ${response['error-reason']}`);
                      return response.sdp;
                    })
                    this.cs.dialog.uas.modify(newSDP)
                    if (!this.isConnected) {
                        this.isConnected = true;
                        resolve(uac);
                        
                        // End all other calls
                        this.uacCalls.forEach((call, idx) => {
                        if (idx !== index && call && call.reqB) {
                            this.logger.info(`Cancel ringing on index: ${idx}`)
                            this.statusHook.send('connect:cancel ', this.params, {index: idx})
                            call.reqB.cancel();
                            clearTimeout(call.ringTimeout)

                        }
                        });
                    } else {
                        // This call was successful but another one already won the race
                        uac.destroy();
                        reject(new Error('Another call was already connected'));
                    }
                    })
                .catch((err) => {
                        this.logger.error(`Error from call index: ${index} status ${err.status}`)
                        this.statusHook.send('connect:error ', this.params, {dest: d.dest, index: index, error: err})
                        if (err.status == undefined){
                            this.logger.error(err)
                        }
                        this.uacCalls[index].status = 'failed';
                        clearTimeout(this.uacCalls[index].ringTimeout)
                        //Check if all call attempts have now failed
                        let allFailed = true 
                        this.uacCalls.forEach(c => {
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
            // Wait for the first successful answer
            Promise.race(uacPromises)
                .then((uac) => {
                    let dialog = this.cs.dialog
                    dialog.uac = uac
                    this.cs.uacActive = true
                    dialog.uas.on('destroy', () => {
                        this.logger.info('connectCall: Call ended by A party')
                        this.statusHook.send('connect:hangup ', this.params, {endedby: "A"})
                        this.cs.uasActive= false
                        dialog.uac.destroy()
                        .then(() => {
                            this.cs.uacActive = false
                            this.emit('callEnd', {complete: true, endedBy: 'A'})
                            this.emit('done', true)
                            this.statusHook.send('connect:complete ', this.params)
                        });
                    });
                    dialog.uac.on('destroy', () => {
                        this.cs.uacActive=false
                        this.logger.info('Call ended by B party')
                        this.statusHook.send('connect:hangup ', this.params, {endedby: "B"})
                        this.emit('callEnd', {complete: true, endedBy: 'B'})
                        this.emit('done', true)
                        this.statusHook.send('connect:complete ', this.params)
                    });
                    dialog.uac.on('modify', (req, res) => {
                        this.logger.info('ReINVITE Recieved')
                        this.statusHook.send('connect:reinvite ', this.params, {req: req})
                        res.send(200)
                    })
                    dialog.uac.on('refer', (req, res) => {
                        this.logger.info('REFER Recieved')
                        this.statusHook.send('connect:refer ', this.params, {req: req})
                        res.send(200)
                    })
                })
                .catch((err) => {
                this.logger.error('All connection attempts failed:');
		this.logger.error(err);
                // Only send failure response if no successful connection was made
                this.emit('done', false)
                this.statusHook.send('connect:complete ', this.params)
            });
            


        }
        else {
                    //Call has not previously been connected
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
                    const b2bPromises = destinations.map(async (d, index) => {
                        let ringTimer = d.timeout*1000 || 30000
                        let opts = {}
                        // send another offer message to rtpengine with the src and dest codecs
                        opts.localSdpB = await getSdpB(details, this.req.body, this.cs.srcCodecs, d.codecs )
                        opts.localSdpA = getSdpA.bind(null, details)
                        opts.passFailure = false
                        opts.headers =  {
                            'X-Endpoint-Index': index,
                            ...d.headers
                        }
                        opts.callingNumber = this.params.callerId || this.req.locals.fromUri.user
                        opts.callingName = this.params.callerName || opts.callingNumber
                        opts.proxy = d.proxy ? d.proxy : null
                        opts.passProvisionalResponses = false
                        if (this.auth) opts.auth = this.auth;
                        this.logger.info(`Sending INVITE to  ${d.dest} index: ${index}`);
                        this.ringtone.emit('play');
                        return new Promise((resolve, reject) => {
                        this.srf.createB2BUA(this.req, this.res, 
                            d.dest, 
                            opts,
                            {
                                cbRequest: async(err, reqB) => {
                                    if (err) {
                                        this.statusHook.send('connect:error ', this.params, {dest: d.dest, index: index, error: err})
                                        return this.logger.error({err}, 'error sending INVITE for B leg');
                                    }
                                    this.statusHook.send('connect:trying ', this.params, {dest: d.dest, index: index})
                                    this.b2bCalls[index] = {reqB, status: 'trying'}
                                    this.b2bCalls[index].ringTimeout = setTimeout(() =>{   
                                        this.logger.info(`Cancelling ringing index ${index} due to timeout`)
                                        this.ringtone.emit('stop');
                                        this.statusHook.send('connect:timeout ', this.params, {dest: d.dest, index: index})   
                                        reqB.cancel()
                                    }, ringTimer)
                                },
                                cbProvisional: async(response) => {
                                    this.logger.info(`Recieved ${response.status}`)
                                    if (response.status == 183) {
                                        this.ringtone.emit('stop')
                                        this.res.send(response.status, response.reason, {body: response.body})
                                    } else {
                                        this.res.send(response.status, response.reason)
                                    }
                                }
                            }
                        )
                        .then((dialog) => {
                            // Store the successful dialog
                            this.ringtone.emit('stop');
                            this.b2bCalls[index].status= 'connected' ;
                            this.b2bCalls[index].dialog = dialog ;
                            this.logger.info(`Call was answered by index: ${index}`)
                            this.statusHook.send('connect:answered ', this.params, {dest: d.dest, index: index})
                            clearTimeout(this.b2bCalls[index].ringTimeout)
                            if (!this.isConnected) {
                                this.isConnected = true;
                                resolve(dialog);
                                
                                // End all other calls
                                this.b2bCalls.forEach((call, idx) => {
                                if (idx !== index && call && call.reqB) {
                                    this.logger.info(`Cancel ringing on index: ${idx}`)
                                    this.statusHook.send('connect:cancel ', this.params, {index: idx})
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
                                this.statusHook.send('connect:error ', this.params, {dest: d.dest, index: index, error: err})
                                if (err.status == undefined){
                                    this.logger.error(err)
                                }
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
                                    this.ringtone.emit('stop');
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
                                this.logger.info('connectCall: Call ended by A party')
                                this.statusHook.send('connect:hangup ', this.params, {endedby: "A"})
                                this.cs.uasActive= false
                                dialog.uac.destroy()
                                .then(() => {
                                    this.cs.uacActive = false
                                    this.emit('callEnd', {complete: true, endedBy: 'A'})
                                    this.emit('done', true)
                                    this.statusHook.send('connect:complete ', this.params)
                                });
                            });
                            dialog.uac.on('destroy', () => {
                                this.cs.uacActive=false
                                this.logger.info('connectCall: Call ended by B party')
                                this.statusHook.send('connect:hangup ', this.params, {endedby: "B"})
                                this.emit('callEnd', {complete: true, endedBy: 'B'})
                                this.emit('done', true)
                                this.statusHook.send('connect:complete ', this.params)
                            });
                            dialog.uac.on('modify', (req, res) => {
                                this.logger.info('ReINVITE Recieved')
                                this.statusHook.send('connect:reinvite ', this.params, {req: req})
                                res.send(200)
                            })
                            dialog.uac.on('refer', (req, res) => {
                                this.logger.info('REFER Recieved from UAC')
                                this.statusHook.send('connect:refer ', this.params, {req: req})
                                req.locals = {logger : this.logger}
                                prepareTransfer(this.cs, req, res, 'uas')
                                .then(result => {
                                    this.logger.info('Transfer preparation completed');
                                    this.cs.callScript= result.callScript
                                    this.cs.build(true)
                                    .then( () => {
                                        res.send(200)
                                        this.cs.uacActive=false
                                        dialog.uas.removeAllListeners()
                                        dialog.uac.destroy()
                                        this.emit('done', true)
                                        this.statusHook.send('connect:complete ', this.params)
                                    })
                                })
                            })
                            dialog.uas.on('refer', (req, res) => {
                                this.logger.info('REFER Recieved from UAS, not supported')
                                res.send(405)
                                
                            })
                        })
                        .catch((err) => {
                        this.logger.error('All connection attempts failed:');
			this.logger.error(err)
                        // Only send failure response if no successful connection was made
                        this.emit('done', false)
                        this.statusHook.send('connect:complete ', this.params)
                    });
                }     
            }  
        }
        
        module.exports = connection;