const parseUri = require('drachtio-srf').parseUri;
const { getTrunkById} = require('./data')


  const isRegTrunk = async(req, res, next) =>{
    const {logger} = req.srf.locals;
    redisClient = req.locals.redisClient
    const regID = parseUri(req.url).params?.['x-regid']
    if (regID) {
        const domain = parseUri(req.url).host
        logger.debug(`Found x-regid checking for Reg Trunk on ${domain}`)
        let key = `regtrunk:${domain}:${regID}`;
        let trunkID = await redisClient.hGet(key, 'trunkID');
        if (trunkID) {
            const trunk = await getTrunkById(domain, trunkID)        
            if (trunk){
                logger.debug(trunk, 'Found Reg Trunk')
                req.locals.trunk = trunk
                req.locals.authenticated = true
                next()
            } else{
                logger.warn(`No Trunk found with ID ${trunkID}`)
                next()
            }
        } else {
            logger.info(`No RegTrunk found in redis for ${key}`)
            next()
        }
    } else {
        next()
    }
    
  }
module.exports = isRegTrunk;

