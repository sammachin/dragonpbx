
const debug = require('debug')('dragonpbx:registrar');
const bent = require('bent');
const qs = require('qs');
const { getRegHook } = require('../data/json/lookup');
const crypto = require('crypto');

function calculateResponse({username, realm, method, nonce, uri, nc, cnonce, qop}, password) {
  const ha1 = crypto.createHash('md5');
  ha1.update([username, realm, password].join(':'));
  const ha2 = crypto.createHash('md5');
  ha2.update([method, uri].join(':'));

  // Generate response hash
  const response = crypto.createHash('md5');
  const responseParams = [
    ha1.digest('hex'),
    nonce
  ];

  if (cnonce) {
    responseParams.push(nc);
    responseParams.push(cnonce);
  }

  if (qop) {
    responseParams.push(qop);
  }
  responseParams.push(ha2.digest('hex'));
  response.update(responseParams.join(':'));

  return response.digest('hex');
}

function isFileURL(u) {
    return typeof u === 'string' &&
      u.startsWith('file://');
  }
  
  async function httpAuthenticate(logger, data, uri, hook_method, secret, username, password, req) {
    const {AlertType, writeAlerts} = req.srf.locals;
    const {account_sid} = req.locals;
    try {
      let body = data
      const method =  'POST';
      let headers = {}
      const request = bent(
        'json',
        200,
        method,
        headers
      );
      const json = await request(uri, body, headers);
      return {
        ...json,
        statusCode: 200
      };
    } catch (err) {
      logger.info(`Error from calling auth callback: ${err}`);
      return {
        status: 'failed',
        statusCode: err.statusCode || 500
      };
    }
  }

  async function fileAuthenticate(logger, data, req) {
    const calculated = calculateResponse(req.authData, data.password)
    if (calculated == req.authData.response) {
      return {
        status: 'ok',
        statusCode: 200,
        expires: data.expires || req.expires,
        dialplan: data.dialplan,
        ...(data.codecs && { codecs: data.codecs })
      }
    } else {
      return {
        status: 'authfail',
        statusCode: 403
      }
    }
    
  }

  const regHook = async(req, res, next) => {
      const {logger} = req.srf.locals;
      registration = await getRegHook(req.locals.domain, req.locals.fromUri.user )
      let authResult;
      if (registration.hasOwnProperty('url')) {
        logger.debug(registration, req.authData, 'Using regHook')
        authResult = await httpAuthenticate(
          logger,
          req.authData,
          registration.url,
          registration.method,
          req.locals.webhook_secret,
          registration.username,
          registration.password,
          req
      );
      } else {
        logger.debug(registration, req.authData, 'Using fileAuth')
        authResult = await fileAuthenticate(
          logger,
          registration,
          req
        )
      }
      if (authResult.statusCode !== 200) {
      // Error happens
      return res.send(authResult.statusCode);
      } else if (authResult.status.toLowerCase() !== 'ok') {
      // Authentication failed
        res.send(403, {headers: {
            'X-Reason': authResult.blacklist === true ?
            `detected potential spammer from ${req.source_address}:${req.source_port}` :
            'Invalid credentials'
        }});
      return;
      } else {
      // Authentication success
      req.authorization = {
          challengeResponse: req.authData.pieces,
          grant: authResult
      };
      }
      next();
  }

module.exports = regHook;

