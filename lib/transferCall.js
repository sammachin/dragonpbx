const Emitter = require('events');
const parseUri = require('drachtio-srf').parseUri;

const rtpengine = require('rtpengine-client').Client
const rtpClient = new rtpengine();
const { RTPENGINE_HOST, RTPENGINE_PORT } = require('../settings');
const {getCallHook, getCallScript} = require('./utils/callHook');
const { getTrunkByIP} = require('./data/json/lookup')
//const { initLocals, checkDomain, isTrunk} = require('./lib/middleware')(srf, logger);

const dummyNext = () => { return }

class Transfer extends Emitter {
    constructor() {
        super();
        this.name = 'transfer'
    }    

    async prepare(cs, req, res, referringLeg){
        this.req = req
        this.res = res
        const callId = req.get('Call-ID');
        const fromHeader = req.getParsedHeader('referred-by');
        const toHeader = req.getParsedHeader('refer-to');
        const toUri = parseUri(toHeader.uri);
        const fromUri = parseUri(fromHeader.uri);
        const domain = cs.req.locals.domain
        const redisClient =  cs.req.locals.redisClient
        const logger = cs.logger
        this.origincs = cs
        this.oldDialog = referringLeg == 'uac' ? cs.dialog.uas : cs.dialog.uac
        this.referringDialog = referringLeg == 'uac' ? cs.dialog.uac : cs.dialog.uas
        this.trunk =  getTrunkByIP(domain, req.source_address) || false
        this.req.locals = {callId, toUri, fromUri, fromHeader, toHeader, domain, logger, redisClient};
        await getCallHook(this.req, this.res, dummyNext)
        await getCallScript(this.req, this.res, dummyNext)
        console.log(this.req.callscript)
    }
}

module.exports = Transfer;