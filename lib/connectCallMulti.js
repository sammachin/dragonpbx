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
        let connectedUAC = null;
        let connectedDialog = null;
        let defaultRingTimer = 30000; // Default 30 seconds
        try {
            // Create a promise for each destination
            const dialPromises = destinations.map(async (destInfo, index) => {
                const opts = {
                    localSdpB: this.sdpB,
                    localSdpA: getSdpA.bind(null, details),
                    passFailure: true // Important: let the promise resolve even on failure
                };
                if (destInfo.auth) opts.auth = destInfo.auth;
                const ringTimer = (destInfo.timeout * 1000) || defaultRingTimer;
                let ringTimeout = null;
                try {
                    this.logger.info(`Dialing destination ${index + 1}: ${destInfo.dest}`);
                    
                    const resultPromise = this.srf.createUAC(destInfo.dest, {
                        headers: {},
                        ...opts,
                        cbRequest: async (err, reqB) => {
                            if (err) {
                                this.logger.error({err}, `Error sending INVITE for destination ${index + 1}`);
                                return;
                            }
                            // Store the request so we can cancel it later if needed
                            this.activeUACs.set(index, reqB);
                            // Set timeout for this destination
                            ringTimeout = setTimeout(() => {
                                this.logger.info(`Cancelling call to destination ${index + 1} due to timeout`);
                                if (!this.callConnected && this.activeUACs.has(index)) {
                                    reqB.cancel();
                                    this.activeUACs.delete(index);
                                }
                            }, ringTimer);
                        }
                    });
                    
                    // Return both the UAC promise and the index
                    return { uac: await resultPromise, index, ringTimeout };
                } catch (err) {
                    // Clear the timeout if there's an error
                    if (ringTimeout) clearTimeout(ringTimeout);
                    this.logger.info(`Failed to connect to destination ${index + 1}: ${err.message}`);
                    return { error: err, index };
                }
            });
            
            // Use Promise.race to get the first destination to answer
            const results = await Promise.allSettled(dialPromises);
            
            // Find the first successful connection
            const successfulConnection = results.find(result => 
                result.status === 'fulfilled' && result.value.uac && !result.value.error
            );
            
            if (!successfulConnection) {
                throw new Error('All destinations failed to connect');
            }
            
            // We have a successful connection
            this.logger.info('Call connected');
            const { uac, index, ringTimeout } = successfulConnection.value;
            clearTimeout(ringTimeout);
            this.callConnected = true;
            
            // Cancel all other pending calls
            this.activeUACs.forEach((req, i) => {
                if (i !== index) {
                    this.logger.info(`Cancelling call to destination ${i + 1} as another destination answered`);
                    req.cancel();
                }
            });
            
            // Clear the map
            this.activeUACs.clear();
            
            // Create the B2BUA with the answered UAC
            const uas = await this.srf.createUAS(this.req, this.res, {
                localSdp: uac.remote.sdp
            });
            
            this.logger.info(`Call connected to destination ${index + 1}`);
            
            // Setup event handlers for call teardown
            uas.on('destroy', () => {
                this.logger.info('Call ended by A party');
                uac.destroy();
                this.emit('callEnd', {complete: true, endedBy: 'A'});
                this.emit('done', true);
            });
            
            uac.on('destroy', () => {
                this.logger.info('Call ended by B party');
                uas.destroy();
                this.emit('callEnd', {complete: true, endedBy: 'B'});
                this.emit('done', true);
            });
            
        } catch (error) {
            // Cancel any remaining active calls
            this.activeUACs.forEach((req, i) => {
                this.logger.info(`Cancelling call to destination ${i + 1} due to error`);
                req.cancel();
            });
            this.activeUACs.clear();
            
            this.logger.info(`All calls failed: ${error.message}`);
            this.emit('callEnd', {complete: false, status: error.status || 500});
            this.emit('done', false);
        }
    }
}

module.exports = connectionMulti;