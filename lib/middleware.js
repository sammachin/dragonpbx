const parseUri = require('drachtio-srf').parseUri;
const { getDomain, getTrunkByIP} = require('./data/json/lookup')
const {createClient} = require('redis');

module.exports = function(srf, logger) {
  const initLocals = async (req, res, next) => {
    const callId = req.get('Call-ID');
    const fromHeader = req.getParsedHeader('From');
    const toHeader = req.getParsedHeader('To');
    const toUri = parseUri(toHeader.uri);
    const fromUri = parseUri(fromHeader.uri);
    const domain = parseUri(req.url).host
    const redisClient =  await createClient()
      .on('error', err => logger.error('Redis Client Error', err))
      .connect();
    req.locals = req.locals || {callId, toUri, fromUri, fromHeader, toHeader, domain, logger, redisClient};
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
    const domain = parseUri(req.url).host
    const trunk = await getTrunkByIP(domain, req.source_address)
    if (trunk){
      req.locals.trunk = trunk
      next()
    } else{
      next()
    }
    
  }

  return {
    initLocals, checkDomain, isTrunk
  }
}