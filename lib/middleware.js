const parseUri = require('drachtio-srf').parseUri;
const { getDomain} = require('./data/json/lookup')


module.exports = function(srf, logger) {
  const initLocals = async (req, res, next) => {
    const callId = req.get('Call-ID');
    const fromHeader = req.getParsedHeader('From');
    const toHeader = req.getParsedHeader('To');
    const toUri = parseUri(toHeader.uri);
    const fromUri = parseUri(fromHeader.uri);
    const domain = parseUri(req.url).host
    const logger = srf.locals.logger
    req.locals = req.locals || {callId, toUri, fromUri, domain, logger};
    next();
  };

  const checkDomain = async (req, res, next) => {
    if (getDomain(parseUri(req.url).host)){
      next();
    } else{
      console.log('Unknown Domain')
    }
  };


  return {
    initLocals, checkDomain,
  }
}