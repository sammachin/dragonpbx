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

// Modified to handle separate UAS/UAC instead of B2BUA
class connection extends Emitter {
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
        
        // Track UAS and UACs separately
        this.uas = null;
        this.uacs = [];
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
            try {
                // First create the UAS for the incoming call
                await this.createUAS();
                
                // Then create the UACs to the destinations
                const destinations = await this.getDest();
                if (destinations.length > 1){
                    this.logger.info(`Offering call to ${destinations.length} destinations in parallel`);      
                }
                
                // Create UACs to each destination
                await this.createUACs(destinations);
            } catch (err) {
                this.logger.error({err}, 'Failed to create calls');
                this.emit('done', false);
            }
        }     
    }
    
    async createUAS() {
        return new Promise((resolve, reject) => {
            // Create UAS for the incoming call
            const details = {
                'call-id': this.req.get('Call-Id'), 
                'from-tag': this.req.locals.fromHeader.params.tag
            };
            
            // Process media with RTPEngine
            rtpClient.offer(RTPENGINE_PORT, RTPENGINE_HOST, {
                'call-id': this.req.get('Call-Id'),
                'from-tag': this.req.locals.fromHeader.params.tag,
                'sdp': this.req.body,
                'direction': ['internal', 'external']
            })
            .then((response) => {
                if (response.result !== 'ok') {
                    this.logger.error(`Error from rtpengine: ${response['error-reason']}`);
                    reject(new Error(`RTPEngine error: ${response['error-reason']}`));
                    return;
                }
                
                // Create the UAS with the processed SDP
                this.srf.createUAS(this.req, this.res, {
                    localSdp: response.sdp
                })
                .then((uas) => {
                    this.uas = uas;
                    this.cs.uasActive = true;
                    
                    // Set up UAS event handlers
                    uas.on('destroy', () => {
                        this.logger.info('Call ended by A party');
                        this.cs.uasActive = false;
                        
                        // Destroy all active UACs
                        this.destroyAllUACs();
                        
                        this.emit('callEnd', {complete: true, endedBy: 'A'});
                        this.emit('done', true);
                    });
                    
                    uas.on('modify', (req, res) => {
                        this.logger.info('ReINVITE received on UAS');
                        
                        // If we have an active UAC, propagate the reinvite
                        if (this.activeUAC) {
                            this.activeUAC.modify({
                                sdp: req.body
                            })
                            .then((uacResponse) => {
                                res.send(200, {
                                    body: uacResponse.body
                                });
                            })
                            .catch((err) => {
                                this.logger.error({err}, 'Error propagating reinvite to UAC');
                                res.send(488);
                            });
                        } else {
                            // No active UAC, just accept the reinvite
                            res.send(200, {
                                body: uas.local.sdp
                            });
                        }
                    });
                    
                    resolve(uas);
                })
                .catch((err) => {
                    this.logger.error({err}, 'Error creating UAS dialog');
                    reject(err);
                });
            })
            .catch((err) => {
                this.logger.error({err}, 'Error processing SDP with rtpengine');
                reject(err);
            });
        });
    }
    
    async createUACs(destinations) {
        // Array to store UAC attempts
        this.uacAttempts = [];
        this.isConnected = false;
        
        // Create promises for each UAC attempt
        const uacPromises = destinations.map((d, index) => {
            let ringTimer = d.timeout * 1000 || 30000;
            let opts = {
                headers: {
                    'X-Endpoint-Index': index
                }
            };
            
            if (d.auth) opts.auth = d.auth;
            
            this.logger.info(`Sending INVITE to ${d.dest} index: ${index}`);
            
            return new Promise((resolve, reject) => {
                // Process SDP for this leg with rtpengine
                rtpClient.offer(RTPENGINE_PORT, RTPENGINE_HOST, {
                    'call-id': `${this.req.get('Call-Id')}-uac-${index}`, // Unique call-id for each UAC
                    'from-tag': `uac-${index}-${Date.now()}`, // Unique from-tag
                    'sdp': this.uas.remote.sdp, // Use the remote SDP from the UAS
                    'direction': ['external', 'internal']
                })
                .then((response) => {
                    if (response.result !== 'ok') {
                        reject(new Error(`RTPEngine error: ${response['error-reason']}`));
                        return;
                    }
                    
                    // Create UAC with the processed SDP
                    this.srf.createUAC(d.dest, {
                        headers: opts.headers,
                        auth: opts.auth,
                        body: response.sdp
                    })
                    .then((uac) => {
                        // Store successful UAC
                        this.uacAttempts[index] = {
                            status: 'connected',
                            uac: uac,
                            rtpDetails: {
                                'call-id': `${this.req.get('Call-Id')}-uac-${index}`,
                                'from-tag': `uac-${index}-${Date.now()}`,
                                'to-tag': uac.remote.params.tag
                            }
                        };
                        
                        clearTimeout(this.uacAttempts[index].ringTimeout);
                        this.logger.info(`Call was answered by index: ${index}`);
                        
                        // Set up UAC event handlers
                        uac.on('destroy', () => {
                            this.cs.uacActive = false;
                            this.logger.info('Call ended by B party');
                            
                            // Destroy the UAS if it's still active
                            if (this.uas && this.cs.uasActive) {
                                this.uas.destroy()
                                .then(() => {
                                    this.cs.uasActive = false;
                                    this.emit('callEnd', {complete: true, endedBy: 'B'});
                                    this.emit('done', true);
                                });
                            } else {
                                this.emit('callEnd', {complete: true, endedBy: 'B'});
                                this.emit('done', true);
                            }
                        });
                        
                        uac.on('modify', (req, res) => {
                            this.logger.info('ReINVITE received on UAC');
                            
                            // If the UAS is active, propagate the reinvite
                            if (this.uas && this.cs.uasActive) {
                                this.uas.modify({
                                    sdp: req.body
                                })
                                .then((uasResponse) => {
                                    res.send(200, {
                                        body: uasResponse.body
                                    });
                                })
                                .catch((err) => {
                                    this.logger.error({err}, 'Error propagating reinvite to UAS');
                                    res.send(488);
                                });
                            } else {
                                // No active UAS, just accept the reinvite
                                res.send(200, {
                                    body: uac.local.sdp
                                });
                            }
                        });
                        
                        uac.on('refer', (req, res) => {
                            this.logger.info('REFER received');
                            console.log(req);
                            res.send(200);
                        });
                        
                        if (!this.isConnected) {
                            this.isConnected = true;
                            this.activeUAC = uac;
                            this.cs.successfullyConnected = true;
                            this.cs.uacActive = true;
                            
                            // Cancel all other UAC attempts
                            this.cancelOtherUACs(index);
                            
                            resolve(uac);
                        } else {
                            // This UAC was successful but another one already won
                            uac.destroy();
                            reject(new Error('Another call was already connected'));
                        }
                    })
                    .catch((err) => {
                        this.logger.error({err}, `Error creating UAC dialog for index: ${index}`);
                        this.handleUACFailure(index, err);
                        reject(err);
                    });
                })
                .catch((err) => {
                    this.logger.error({err}, `Error processing SDP for UAC index: ${index}`);
                    this.handleUACFailure(index, err);
                    reject(err);
                });
                
                // Set up ring timeout for this UAC attempt
                this.uacAttempts[index] = {
                    status: 'trying',
                    ringTimeout: setTimeout(() => {
                        this.logger.info(`Cancelling ringing index ${index} due to timeout`);
                        // The UAC request might not be created yet, so we'll check
                        if (this.uacAttempts[index].uacRequest) {
                            this.uacAttempts[index].uacRequest.cancel();
                        }
                        this.handleUACFailure(index, new Error('Ring timeout'));
                        reject(new Error('Ring timeout'));
                    }, ringTimer)
                };
            });
        });
        
        // Wait for the first successful UAC or for all to fail
        Promise.race(uacPromises)
            .then((uac) => {
                this.logger.info('Successfully connected to a destination');
            })
            .catch((err) => {
                // Check if all UACs failed
                const allFailed = this.uacAttempts.every(attempt => attempt.status === 'failed');
                
                if (allFailed) {
                    this.logger.error('All connection attempts failed');
                    
                    // Destroy the UAS
                    if (this.uas) {
                        this.uas.destroy()
                        .then(() => {
                            this.cs.uasActive = false;
                            this.emit('done', false);
                        });
                    } else {
                        this.emit('done', false);
                    }
                }
            });
    }
    
    handleUACFailure(index, err) {
        this.logger.error(`Error from call index: ${index} status ${err.status || 'unknown'}`);
        
        this.uacAttempts[index].status = 'failed';
        if (this.uacAttempts[index].ringTimeout) {
            clearTimeout(this.uacAttempts[index].ringTimeout);
        }
        
        // Check if all attempts have failed
        const allFailed = this.uacAttempts.every(attempt => attempt.status === 'failed');
        
        if (allFailed && !this.isConnected) {
            this.logger.error('All UAC attempts failed');
            
            // Destroy the UAS if it exists
            if (this.uas) {
                this.uas.destroy()
                .then(() => {
                    this.cs.uasActive = false;
                    this.emit('done', false);
                });
            } else {
                this.emit('done', false);
            }
        }
    }
    
    cancelOtherUACs(winnerIndex) {
        this.uacAttempts.forEach((attempt, idx) => {
            if (idx !== winnerIndex && attempt) {
                this.logger.info(`Cancel ringing on index: ${idx}`);
                
                if (attempt.uacRequest) {
                    attempt.uacRequest.cancel();
                }
                
                if (attempt.ringTimeout) {
                    clearTimeout(attempt.ringTimeout);
                }
            }
        });
    }
    
    destroyAllUACs() {
        this.uacAttempts.forEach((attempt) => {
            if (attempt && attempt.uac) {
                attempt.uac.destroy()
                .catch((err) => {
                    this.logger.error({err}, 'Error destroying UAC');
                });
            }
            
            if (attempt && attempt.ringTimeout) {
                clearTimeout(attempt.ringTimeout);
            }
        });
    }
}

module.exports = connection;