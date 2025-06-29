const matcher = require('multimatch').default
const debug = require('debug')('dragonpbx:registrar');
const qs = require('qs');
const http = require('http');
const https = require('https');
const {fileRequest} = require('./callScriptFile')

function isFileURL(u) {
    return typeof u === 'string' &&
      u.startsWith('file:');
  }
  
async function httpRequest(logger, uri, req) {
  logger.info(`Fetching callScript from: ${uri}`);
  try {
    const body = {
      domain: req.locals.domain,
      from: req.locals.fromUri.user,
      to: req.locals.toUri.user,
      callId: req.locals.callId,
      sourceAddress: req.source_address,
      headers: req.headers,
      source: req.locals.trunk ? req.locals.trunk : 'client',
      refer: req.locals.refer ? true : false,
      count: req.locals.count
    };

    // Parse the URI to determine if it's HTTP or HTTPS
    const url = new URL(uri);
    const protocol = url.protocol === 'https:' ? https : http;
    
    return new Promise((resolve, reject) => {
      const requestOptions = {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 3000  // Set timeout to 3000ms (3 seconds)
      };
      
      const request = protocol.request(requestOptions, (response) => {
        let data = '';
        
        response.on('data', (chunk) => {
          data += chunk;
        });
        
        response.on('end', () => {
          if (response.statusCode !== 200) {
            logger.info(`Non-200 status code: ${response.statusCode}`);
            reject(new Error(`HTTP status code: ${response.statusCode}`));
            return;
          }
          
          try {
            const json = JSON.parse(data);
            resolve(json);
          } catch (err) {
            reject(new Error(`Failed to parse JSON: ${err.message}`));
          }
        });
      });
      
      // Handle request timeout
      request.on('timeout', () => {
        logger.info('Request timed out after 3000ms');
        request.destroy();
        reject(new Error('Request timeout after 3000ms'));
      });
      
      // Handle request errors
      request.on('error', (err) => {
        logger.info(`Error from calling callHook callback: ${err}`);
        reject(err);
      });
      
      // Send the request body
      request.write(JSON.stringify(body));
      request.end();
    });
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
    if (typeof(callHook) == 'object') {
      req.locals.callHook = callHook.callHook
      req.locals.statusHook = callHook.statusHook || false      
    } else {
      req.locals.callHook = callHook
      req.locals.statusHook = false
    }
    logger.info(`Found callHook: ${req.locals.callHook}`);
    logger.info(`Found statusHook: ${req.locals.statusHook}`);
    next()
  } else{
    res.send(404)
  }
}

const getCallScript = async(req, res, next) => {
  const {logger} = req.locals;
  try {
  if (isFileURL(req.locals.callHook)) {
    logger.info('Callhook is file')
    script = await fileRequest(
        logger,
        req.locals.callHook.slice(5),
        req
    );
  } else {
    logger.info('Callhook is url')
    script = await httpRequest(
        logger,
        req.locals.callHook,
        req
    );
  }
  if (script){
    req.locals.callScript = script
    if (next){
      next()
    } else {
      return
    }
  } else {
    res.send(500)
  }
  } catch (error) {
    logger.error(error)
    logger.info(`Faild to fetch callScript, sending 480`)
    res.send(480)  
  }
}

module.exports = {getCallHook, getCallScript}

