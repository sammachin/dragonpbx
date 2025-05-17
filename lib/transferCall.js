const Emitter = require('events');
const parseUri = require('drachtio-srf').parseUri;
const {getCallHook, getCallScript} = require('./utils/callHook');
const { getTrunkByIP} = require('./data/json/lookup')



const dummyNext = () => { return }

const prepareTransfer = (cs, req, res, referringLeg) => {
    return new Promise((resolve, reject) => {
      try {
        const callId = req.get('Call-ID');
        const fromHeader = req.getParsedHeader('referred-by');
        const toHeader = req.getParsedHeader('refer-to');
        const toUri = parseUri(toHeader.uri);
        const fromUri = parseUri(fromHeader.uri);
        const domain = cs.req.locals.domain;
        const redisClient = cs.req.locals.redisClient;
        const logger = cs.logger;
        const refer = true;
        const oldDialog = referringLeg == 'uac' ? cs.dialog.uas : cs.dialog.uac;
        const referringDialog = referringLeg == 'uac' ? cs.dialog.uac : cs.dialog.uas;
        trunk = getTrunkByIP(domain, req.source_address) || false;
        req.locals = {callId, toUri, fromUri, fromHeader, toHeader, domain, logger, redisClient, refer};
        
        // Chain the promises and resolve when done
        getCallHook(req, res, dummyNext)
          .then(() => getCallScript(req, res, dummyNext))
          .then(() => {
            console.log(req.locals.callScript);
            resolve(req.locals); // Resolve with the updated req.locals
          })
          .catch(err => {
            reject(err); // Reject if any promises in the chain fail
          });
      } catch (error) {
        reject(error); // Reject if there's an error in the synchronous part
      }
    });
  };


module.exports = {prepareTransfer};