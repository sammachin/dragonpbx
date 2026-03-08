const parseUri = require('drachtio-srf').parseUri;
const { getDomain, getTrunkByIP} = require('./data');

module.exports = function(srf, logger) {
  const initLocals = async (req, res, next) => {
    const callId = req.get('Call-ID');
    const fromHeader = req.getParsedHeader('From');
    const toHeader = req.getParsedHeader('To');
    const toUri = parseUri(toHeader.uri);
    const fromUri = parseUri(fromHeader.uri);
    const domain = parseUri(req.url).host
    const count = 0;
    const authenticated = false;
    const redisClient = req.srf.locals.redisClient;
    req.locals = req.locals || {callId, toUri, fromUri, fromHeader, toHeader, domain, logger, redisClient, count, authenticated};
    next();
  };

  const checkDomain = async (req, res, next) => {
    const domain = parseUri(req.url).host
    const {logger} = req.srf.locals;
    if (await getDomain(domain)){
      next();
    } else{
      logger.info(`rejecting unknown domain ${domain}`)
      res.send(500)
    }
  };

  const isTrunk = async(req, res, next) =>{
    const {logger} = req.srf.locals;
    const domain = parseUri(req.url).host
    logger.debug(`Checking for IP Trunk on ${domain}`)
    const trunk = await getTrunkByIP(domain, req.source_address)
    if (trunk){
      logger.debug(trunk, 'Found IP Trunk')
      req.locals.trunk = trunk
      req.locals.authenticated = true
      next()
    } else{
      next()
    }
  }

  return {
    initLocals, checkDomain, isTrunk
  }
}