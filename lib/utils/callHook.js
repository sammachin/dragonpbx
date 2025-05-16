const matcher = require('multimatch').default
const debug = require('debug')('dragonpbx:registrar');
const bent = require('bent');
const qs = require('qs');

function isFileURL(u) {
    return typeof u === 'string' &&
      u.startsWith('file://');
  }
  
async function httpRequest(logger, uri, req) {
  logger.info(`Fetching callScript from: ${uri}`);
  try {
    let body = {
      domain: req.locals.domain,
      from: req.locals.fromUri.user,
      to: req.locals.toUri.user,
      callId: req.locals.callId,
      sourceAddress: req.source_address,
      headers : req.headers, 
      source: req.locals.trunk ? req.locals.trunk : 'client'
    }
    let headers = {}
    const method = 'POST';
    const request = bent(
      'json',
      200,
      method,
      headers
    );
    const json = await request(uri, body, headers);
    return json;
  } catch (err) {
    logger.info(`Error from calling callHook callback: ${err}`);
    return false;
  }
}

function generateSigHeader(payload, secret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = computeSignature(payload, timestamp, secret);
  const scheme = 'v1';
  return {
    'Jambonz-Signature': `t=${timestamp},${scheme}=${signature}`
  };
}


const getCallHook = async(req, res, next) => {
  const {logger} = req.locals;
  let dialplan;
  if (req.locals.trunk){
    logger.info(`Using trunk dialplan `);
    dialplan = req.locals.trunk.dialplan
  } else{
    logger.info(`Fetching dialplan for client`);
    let key = `client:${req.locals.domain}:${req.locals.fromUri.user}`
    let dpjson = await req.locals.redisClient.hGet(key, 'dialplan');
    dialplan = JSON.parse(dpjson);
  }
  logger.info(`Fetching callHook from: dialplan`);
  let callHook = false
  Object.keys(dialplan).forEach((i) => {
    if (matcher(req.locals.toUri.user, [i]).length == 1){
      callHook =  dialplan[i]
    }
  })
  if (callHook){
    req.locals.callHook = callHook
    logger.info(`Found callHook: ${callHook}`);
    next()
  } else{
    res.send(404)
  }
}

const getCallScript = async(req, res, next) => {
  const {logger} = req.locals;
  if (isFileURL(req.locals.callHook)) {
    script = await fileRequest(
        logger,
        data,
        req.locals.callHook,
        req
    );
  } else {
    script = await httpRequest(
        logger,
        req.locals.callHook,
        req
    );
  }
  if (script){
    req.locals.callScript = script
    next();
  } else {
    res.send(500)
  }
}

module.exports = {getCallHook, getCallScript}

