const parseUri = require('drachtio-srf').parseUri;
const { getDomain, getTrunk} = require('./data/json/lookup')


module.exports = function(srf, logger) {
  const initLocals = async (req, res, next) => {
    const callId = req.get('Call-ID');
    const fromHeader = req.getParsedHeader('From');
    const toHeader = req.getParsedHeader('To');
    const toUri = parseUri(toHeader.uri);
    const fromUri = parseUri(fromHeader.uri);
    const domain = parseUri(req.url).host
    req.locals = req.locals || {callId, toUri, fromUri, domain, logger};
    next();
  };

  const checkDomain = async (req, res, next) => {
    const domain = parseUri(req.url).host
    if (await getDomain(domain)){
      next();
    } else{
      logger.info(`rejecting unknown domain ${domain}`)
      res.send(500)
    }
  };

  const isTrunk = async(req, res, next) =>{
    next()
  }

  return {
    initLocals, checkDomain, isTrunk
  }
}