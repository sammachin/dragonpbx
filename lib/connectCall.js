const Emitter = require('events');

const rtpengine = require('rtpengine-client').Client
const rtpClient = new rtpengine();
const { RTPENGINE_HOST, RTPENGINE_PORT, DEFAULT_CODECS } = require('../settings');
const { getTrunkById, getTrunkByName} = require('./data')
const {prepareTransfer} = require('./transferCall')
const ringbacktone = require('./ringBackTone')
const sipInfo = require('./sipInfo');
const { asyncWrapProviders } = require('async_hooks');

function getSdpA(details, remoteSdp, res) {
    const toTag = res.getParsedHeader('To').params.tag;
    return rtpClient.answer(RTPENGINE_PORT, RTPENGINE_HOST, {
        'call-id': details['call-id'],
        'from-tag': details['from-tag'],
        'sdp': remoteSdp,
        'flags': ['inject DTMF'],
        'to-tag': toTag
    })
    .then((response) => {
      if (response.result !== 'ok') throw new Error(`Error calling answer: ${response['error-reason']}`);
      return response.sdp;
    })
}

async function getSdpB(details, sdp, srcCodecs, dstCodecs ){
    let srcHasTelephoneEvent = sdp.toLowerCase().includes('telephone-event')
    let codecOpts = { 'mask': srcCodecs }
    if (srcHasTelephoneEvent) {
        codecOpts.accept = ['telephone-event']
        codecOpts.transcode = dstCodecs
    } else {
        codecOpts.transcode = [...dstCodecs, 'telephone-event']
    }
    return rtpClient.offer(RTPENGINE_PORT, RTPENGINE_HOST, Object.assign(details, {
        'sdp': sdp,
        'flags': ['inject DTMF'],
        'codec': codecOpts
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
        this.sipInfo = false
        
    }

    static async create(cs, params, transfer) {
        const instance = new connection(cs, params, transfer);
        instance.ringtone = new ringbacktone(cs, params)
        await instance.ringtone.init()
        instance.sipInfo = new sipInfo(cs)
        return instance;
    }

    async getDest() {
    // Handle multiple destinations in params
    if (Array.isArray(this.dests)) {
        const results = await Promise.all(this.dests.map(param => this.getDestForParam(param)));
        return results.filter(result => result !== false).flat();
    } else {
        const result = await this.getDestForParam(this.dests);
        return result !== false ? result : [];
    }
    } 

    async getClientContacts(key) {
        const hKeys = await this.rClient.hKeys(key)
        const regex = /^contact:/
        let contacts = []
        hKeys.forEach((k) => {
          if (regex.test(k)) {
            let cid = k.substring('contact:'.length)
            contacts.push(cid)
          }
        })
        return contacts
    }

    async getDestForParam(param) {
        let domain = this.req.locals.domain;
        switch (param.type) {
            case 'client': {
                let destInfo = []
                this.logger.info(`Looking up dest for client ${param.address} in ${domain}`);
                let key = `client:${domain}:${param.address}`
                let contacts = await this.getClientContacts(key)
                if (contacts.length == 0){
                    this.logger.info(`No registered contact found for ${param.address} in ${domain}`);
                    return false
                }
                else {
                    let codecs = await this.rClient.hGet(key, 'codecs');
                    let clientCodecs = JSON.parse(codecs);
                    for (const c of contacts) {
                        let d = {}
                        let proxy =  await this.rClient.hGet(key, `proxy:${c}`);
                        let cdest = await this.rClient.hGet(key, `contact:${c}`);
                        d.dest = cdest;
                        d.proxy = proxy ? proxy : null;
                        d.timeout = param.timeout || 30;
                        d.directMedia =(clientCodecs.indexOf('DIRECT') > 0);
                        if (d.directMedia) clientCodecs.splice(clientCodecs.indexOf('DIRECT'), 1)
                        d.codecs = clientCodecs;
                        d.headers = param.headers
                        destInfo.push(d)
                    }
                }
                return destInfo
            }
            case 'sip': {
                let destInfo = {}
                if ('username' in param) {
                    destInfo.auth = {
                        username: param.username,
                        password: param.password
                    };
                }
                destInfo.dest = param.address;
                destInfo.timeout = param.timeout || 30;
                destInfo.directMedia = (param.codecs?.indexOf('DIRECT') >0);
                if (destInfo.directMedia) param.codecs?.splice(param.codecs.indexOf('DIRECT'), 1)
                destInfo.codecs = param.codecs || DEFAULT_CODECS;
                destInfo.headers = param.headers
                destInfo.proxy = param.proxy || null;
                return [destInfo];
            }
            case 'trunk': {
                this.logger.info(`Looking up trunk ${param.trunk_id ? param.trunk_id : param.trunk_name} in ${domain}`);
                let trunk;
                if ('trunk_id' in param) {
                    trunk = await getTrunkById(domain, param.trunk_id);
                } else if ('trunk_name' in param) {
                    trunk = await getTrunkByName(domain, param.trunk_name);
                } else {
                    throw new Error('Trunk must specify ID or Name');
                }
                let destInfo = {}
                destInfo.dest = `${param.address}@${trunk.outbound.host}`;
                if ('username' in trunk.outbound) {
                    destInfo.auth = {
                        username: trunk.outbound.username,
                        password: trunk.outbound.password
                    };
                }
                destInfo.timeout = param.timeout || 30;
                destInfo.directMedia = (trunk.codecs.indexOf('DIRECT') >0);
                if (destInfo.directMedia) trunk.codecs.splice(trunk.codecs.indexOf('DIRECT'), 1)
                destInfo.codecs = trunk.codecs || DEFAULT_CODECS
                destInfo.headers = param.headers
                this.logger.info(destInfo)
                return [destInfo];
            }
            default:
                throw new Error(`Unknown destination type: ${param.type}`);
        }
    }
    
    async action() {
        this.statusHook.send('connect:start', this.params)

        if (this.cs.successfullyConnected && !this.reconnect && !this.transfer) {
            this.logger.info('Skipping action as call had already been connected ')
            this.emit('done')
            this.statusHook.send('connect:skipped', this.params)
            return;
        }

        const isReconnect = this.cs.successfullyConnected && (this.reconnect || this.transfer);
        if (isReconnect) {
            this.logger.info('reConnect or transfer action')
        }

        const destinations = await this.getDest();
        if (destinations.length > 1) {
            this.logger.info(`Offering call to ${destinations.length} destinations in parallel`);
        }

        const details = {
            'call-id': this.req.get('Call-Id'),
            'from-tag': this.req.locals.fromHeader.params.tag
        };

        this.calls = [];
        this.isConnected = false;

        this.req.once('cancel', () => {
            if (this.isConnected) return;
            this.logger.info('A party cancelled during call setup');
            this.calls.forEach((call, idx) => {
                if (call && call.reqB && call.status === 'trying') {
                    clearTimeout(call.ringTimeout);
                    this._cancelWithReason(call.reqB, idx, 487, 'Request Terminated');
                }
            });
        });

        // Pre-compute B-side SDP once per unique codec set to avoid
        // sending redundant rtpengine offers that cause port mismatches.
        const sdpBCache = new Map();
        if (!isReconnect) {
            for (const d of destinations) {
                if (!(d.directMedia && this.cs.srcDirectMedia)) {
                    const key = d.codecs.join(',');
                    if (!sdpBCache.has(key)) {
                        sdpBCache.set(key, await getSdpB(details, this.req.body, this.cs.srcCodecs, d.codecs));
                    }
                    d._sdpB = sdpBCache.get(key);
                }
            }
        }

        const callPromises = destinations.map((d, index) =>
            this._attemptCall(d, index, details, isReconnect)
        );

        Promise.race(callPromises)
            .then((result) => this._onConnected(result, isReconnect))
            .catch((err) => {
                this.logger.error('All connection attempts failed:');
                this.logger.error(err);
                this.emit('done', false)
                this.statusHook.send('connect:complete ', this.params)
            });
    }

    _cancelWithReason(reqB, index, cause, text) {
        if (!reqB) return;
        try {
            reqB.cancel({
                headers: {
                    'Reason': `SIP;cause=${cause};text="${text}"`
                }
            });
        } catch (err) {
            this.logger.error({err, index}, 'Error cancelling B leg');
        }
    }

    async _attemptCall(d, index, details, isReconnect) {
        let ringTimer = d.timeout * 1000 || 30000
        let opts = {}

        this.logger.debug(`Dest DIRECT ${d.directMedia}`)
        this.logger.debug(`Src DIRECT ${this.cs.srcDirectMedia}`)

        if (d.directMedia && this.cs.srcDirectMedia) {
            this.logger.info(`Using Direct Media`)
        } else if (isReconnect) {
            opts.localSdp = await getSdpB(details, this.req.body, this.cs.srcCodecs, d.codecs)
        } else {
            this.logger.info(`Using Proxy Media`)
            opts.localSdpB = d._sdpB || await getSdpB(details, this.req.body, this.cs.srcCodecs, d.codecs)
            opts.localSdpA = getSdpA.bind(null, details)
        }

        opts.headers = {
            'X-Endpoint-Index': index,
            ...d.headers
        }
        opts.callingNumber = this.params.callerId || this.req.locals.fromUri.user
        opts.callingName = this.params.callerName || opts.callingNumber
        opts.proxy = d.proxy ? d.proxy : null
        if (d.auth) opts.auth = d.auth;

        if (!isReconnect) {
            opts.passFailure = false
            opts.passProvisionalResponses = false
        }

        this.logger.info(`Sending INVITE to  ${d.dest} index: ${index}`);
        // For reconnect we don't have a B-party to wait for, so emit play
        // immediately (it'll use the reversed-from-tag fallback). For
        // initial calls, wait until 180 arrives in cbProvisional so we can
        // use B's real to-tag for the dummy answer.
        if (isReconnect) {
            this.ringtone.emit('play', {reconnect: true});
        }

        return new Promise((resolve, reject) => {
            const cbRequest = async (err, reqB) => {
                if (err) {
                    this.statusHook.send('connect:error ', this.params, {dest: d.dest, index: index, error: err})
                    return this.logger.error({err}, 'error sending INVITE for B leg');
                }
                this.statusHook.send('connect:trying ', this.params, {dest: d.dest, index: index})
                this.calls[index] = {reqB, status: 'trying'}
                this.calls[index].ringTimeout = setTimeout(() => {
                    this.logger.info(`Cancelling ringing index ${index} due to timeout`)
                    this.ringtone.emit('stop');
                    this.statusHook.send('connect:timeout ', this.params, {dest: d.dest, index: index})
                    this._cancelWithReason(reqB, index, 487, 'Request Terminated')
                }, ringTimer)
            };

            const onAnswer = (result) => {
                this.ringtone.emit('stop');
                this.calls[index].status = 'connected';
                this.calls[index].result = result;
                this.logger.info(`Call was answered by index: ${index}`)
                this.statusHook.send('connect:answered ', this.params, {dest: d.dest, index: index})
                clearTimeout(this.calls[index].ringTimeout)

                if (isReconnect) {
                    let newSDP = rtpClient.answer(RTPENGINE_PORT, RTPENGINE_HOST, {
                        'call-id': details['call-id'],
                        'from-tag': details['from-tag'],
                        'sdp': result.remote.sdp,
                        'to-tag': result.sip.localTag
                    })
                    .then((response) => {
                        if (response.result !== 'ok') throw new Error(`Error calling answer: ${response['error-reason']}`);
                        return response.sdp;
                    })
                    this.cs.dialog.uas.modify(newSDP)
                }

                if (!this.isConnected) {
                    this.isConnected = true;
                    resolve(result);

                    // Cancel all other ringing calls
                    this.calls.forEach((call, idx) => {
                        if (idx !== index && call && call.reqB) {
                            this.logger.info(`Cancel ringing on index: ${idx}`)
                            this.statusHook.send('connect:cancel ', this.params, {index: idx})
                            clearTimeout(call.ringTimeout)
                            this._cancelWithReason(call.reqB, idx, 200, 'Call completed elsewhere');
                        }
                    });
                } else {
                    // Another call already won the race
                    if (isReconnect) {
                        result.destroy();
                    } else {
                        result.uas.destroy();
                    }
                    reject(new Error('Another call was already connected'));
                }
            };

            const onError = (err) => {
                this.logger.error(`Error from call index: ${index} status ${err.status}`)
                this.statusHook.send('connect:error ', this.params, {dest: d.dest, index: index, error: err})
                if (err.status == undefined) {
                    this.logger.error(err)
                }
                this.calls[index].status = 'failed';
                clearTimeout(this.calls[index].ringTimeout)
                // Check if all call attempts have now failed
                let allFailed = this.calls.every(c => c.status === 'failed');
                if (allFailed) {
                    this.ringtone.emit('stop');
                    reject()
                }
            };

            if (isReconnect) {
                this.srf.createUAC(d.dest, opts, { cbRequest })
                    .then(onAnswer)
                    .catch(onError);
            } else {
                this.srf.createB2BUA(this.req, this.res, d.dest, opts, {
                    cbRequest,
                    cbProvisional: async (response) => {
                        this.logger.info(`Recieved ${response.status}`)
                        if (response.status == 180) {
                            // Capture B's real to-tag from 180 Ringing and
                            // use it for the rtpengine dummy answer. This
                            // makes the dummy answer's callee monologue
                            // own the offer's B-side port allocation — when
                            // the real 200 OK arrives, getSdpA updates the
                            // same monologue rather than creating a new one
                            // with a fresh port. Bria-as-B then lands on the
                            // real callee monologue instead of a phantom.
                            //
                            // Don't forward 180 to A — our 183 (which will
                            // follow from the dummy answer) keeps A's UA in
                            // early-media mode so the custom ringback plays.
                            try {
                                const toHeader = response.getParsedHeader('To');
                                const bToTag = toHeader && toHeader.params && toHeader.params.tag;
                                if (bToTag) {
                                    this.ringtone.emit('play', {reconnect: false, toTag: bToTag});
                                } else {
                                    // No to-tag in 180 (rare); fall back so ringback still plays.
                                    this.ringtone.emit('play', {reconnect: false});
                                }
                            } catch (e) {
                                this.logger.debug({err: e.message || e}, 'could not parse To header on 180');
                                this.ringtone.emit('play', {reconnect: false});
                            }
                        } else if (response.status == 183) {
                            // B-party sent its own 183 with early media SDP —
                            // stop our ringback and forward B's media to A.
                            this.ringtone.emit('stop')
                            this.res.send(response.status, response.reason, {body: response.body})
                        } else {
                            this.res.send(response.status, response.reason)
                        }
                    }
                })
                .then(onAnswer)
                .catch(onError);
            }
        });
    }

    _onConnected(result, isReconnect) {
        let dialog;
        if (isReconnect) {
            dialog = this.cs.dialog
            dialog.uac = result
            this.cs.uacActive = true
        } else {
            this.cs.successfullyConnected = true
            this.cs.dialog = result
            dialog = result
            this.cs.uasActive = true
            this.cs.uacActive = true
        }

        // If a record verb has armed SIPREC recording, start it now.
        // Pass the real callee's to-tag explicitly so the SIPREC subscription
        // targets only the live call legs and not any phantom monologues left
        // behind by ringback/early-media playback.
        if (this.cs.recording && !this.cs.recording.recording && !this.cs.recording.starting) {
            const calleeTag = dialog && dialog.uac && dialog.uac.sip && dialog.uac.sip.remoteTag;
            this.logger.debug({calleeTag, callerTag: this.cs.details['from-tag']}, 'connectCall: SIPREC tags');
            this.cs.recording.start(dialog, this.cs.details, calleeTag).catch((err) => {
                this.logger.error({err}, 'connectCall: error starting SIPREC recording')
            })
        }

        const stopRecording = () => {
            if (this.cs.recording) {
                this.cs.recording.stop().catch((err) => {
                    this.logger.error({err}, 'connectCall: error stopping SIPREC recording')
                })
            }
        }

        dialog.uas.on('destroy', () => {
            this.logger.info('connectCall: Call ended by A party')
            this.statusHook.send('connect:hangup ', this.params, {endedby: "A"})
            this.cs.uasActive = false
            stopRecording()
            if (isReconnect || this.cs.uacActive) {
                dialog.uac.destroy()
                .then(() => {
                    this.cs.uacActive = false
                    this.emit('callEnd', {complete: true, endedBy: 'A'})
                    this.emit('done', true)
                    this.statusHook.send('connect:complete ', this.params)
                });
            }
        });

        dialog.uac.on('destroy', () => {
            this.cs.uacActive = false
            this.logger.info('connectCall: Call ended by B party')
            this.statusHook.send('connect:hangup ', this.params, {endedby: "B"})
            stopRecording()
            this.emit('callEnd', {complete: true, endedBy: 'B'})
            this.emit('done', true)
            this.statusHook.send('connect:complete ', this.params)
        });

        dialog.uac.on('modify', (req, res) => {
            this.logger.info('ReINVITE Recieved')
            this.statusHook.send('connect:reinvite ', this.params, {req: req})
            res.send(200)
        })

        if (isReconnect) {
            dialog.uac.on('refer', (req, res) => {
                this.logger.info('REFER Recieved')
                this.statusHook.send('connect:refer ', this.params, {req: req})
                res.send(200)
            })
        } else {
            dialog.uac.on('refer', (req, res) => {
                this.logger.info('REFER Recieved from UAC')
                this.statusHook.send('connect:refer ', this.params, {req: req})
                req.locals = {logger: this.logger}
                prepareTransfer(this.cs, req, res, 'uas')
                .then(result => {
                    this.logger.info('Transfer preparation completed');
                    this.cs.callScript = result.callScript
                    this.cs.build(true)
                    .then(() => {
                        res.send(200)
                        this.cs.uacActive = false
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
            dialog.uac.on('info', (req, res) => {
                const body = req.msg.body;
                this.logger.debug({body}, 'SIP INFO from UAC')
                this.sipInfo.emit('info', req, res, 'uac')
            })
            dialog.uas.on('info', (req, res) => {
                const body = req.msg.body;
                this.logger.debug({body}, 'SIP INFO from UAS')
                this.sipInfo.emit('info', req, res, 'uas')
            })
        }
    }
}
module.exports = connection;