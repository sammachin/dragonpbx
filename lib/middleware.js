const { getTrunkIpAddress } = require('./utils');
const parseUri = require('drachtio-srf').parseUri;



module.exports = function(srf, logger) {
  const initLocals = async (req, res, next) => {
    const callId = req.get('Call-ID');
    const fromHeader = req.getParsedHeader('To');
    const toHeader = req.getParsedHeader('To');
    req.locals = req.locals || {callId};
    
    const toUri = parseUri(toHeader.uri);
    const fromUri = parseUri(fromHeader.uri);
    next();
  };

  return {
    initLocals
  }
}