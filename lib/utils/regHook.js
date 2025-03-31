
const debug = require('debug')('dragonpbx:registrar');
const bent = require('bent');
const qs = require('qs');
const { getRegHook } = require('../data/json/lookup');

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


  const regHook = async(req, res, next) => {
      const {logger} = req.srf.locals;
      registration_hook = await getRegHook(req.locals.domain, req.locals.fromUri.user )
      let authResult;
      if (isFileURL(registration_hook.url)) {
      authResult = await fileAuthenticate(
          logger,
          data,
          registration_hook_url,
          req
      );
      } else {
      authResult = await httpAuthenticate(
          logger,
          req.authData,
          registration_hook.url,
          registration_hook.method,
          req.locals.webhook_secret,
          registration_hook.username,
          registration_hook.password,
          req
      );
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

