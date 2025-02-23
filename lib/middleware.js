const parseUri = require('drachtio-srf').parseUri;
const { getDomain } = require('./data/json/lookup')


module.exports = function(srf, logger) {
  const initLocals = async (req, res, next) => {
    const callId = req.get('Call-ID');
    const fromHeader = req.getParsedHeader('To');
    const toHeader = req.getParsedHeader('To');
    req.locals = req.locals || {callId};
    const toUri = parseUri(toHeader.uri);
    const fromUri = parseUri(fromHeader.uri);
    const domain = parseUri(req.url).host
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
    initLocals, checkDomain
  }
}