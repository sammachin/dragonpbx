
const debug = require('debug')('dragonpbx:registrar');
const bent = require('bent');
const qs = require('qs');
const { getRegHook } = require('../data/json/lookup');

function isFileURL(u) {
    return typeof u === 'string' &&
      u.startsWith('file://');
  }
  
  async function httpAuthenticate(logger, data, url, hook_method, secret, username, password, req) {
    const {AlertType, writeAlerts} = req.srf.locals;
    const {account_sid} = req.locals;
    try {
      let uri = url;
      let body;
      const method = hook_method ? hook_method.toUpperCase() : 'POST';
      if ('GET' === method) {
        const str = qs.stringify(data);
        uri = `${uri}?${str}`;
      } else {
        body = data;
      }
      const headers = {
        ...(username &&
          password &&
          basicAuth(username, password)),
        ...(secret && generateSigHeader(body || 'null', secret)),
        ...(process.env.JAMBONES_HTTP_USER_AGENT_HEADER && {'user-agent' : process.env.JAMBONES_HTTP_USER_AGENT_HEADER}),
      };
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
      let opts = { account_sid };
      if (err.code === 'ECONNREFUSED') {
        opts = { ...opts, alert_type: AlertType.WEBHOOK_CONNECTION_FAILURE, url: err.hook };
      }
      else if (err.code === 'ENOTFOUND') {
        opts = { ...opts, alert_type: AlertType.WEBHOOK_CONNECTION_FAILURE, url: err.hook };
      }
      else if (err.name === 'StatusError') {
        opts = { ...opts, alert_type: AlertType.WEBHOOK_STATUS_FAILURE, url: err.hook, status: err.statusCode };
      }
      if (opts.alert_type) {
        try {
          await writeAlerts(opts);
        } catch (err) {
          logger.error({ err, opts }, 'Error writing alert');
        }
      }
  
      return {
        status: 'failed',
        statusCode: err.statusCode || 500
      };
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

    const regHook = async(req, res, next) => {
        const {logger} = req.srf.locals;
        registration_hook = await getRegHook(req.locals.domain, req.locals.fromUri.user )
        const startAt = process.hrtime();
        // Authenticate via HTTP server
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
        const diff = process.hrtime(startAt);
        const rtt = diff[0] * 1e3 + diff[1] * 1e-6;
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
        //stats.histogram('app.hook.response_time', rtt.toFixed(0), ['hook_type:auth', `status:${403}`]);
        return;
        } else {
        // Authentication success
        req.authorization = {
            challengeResponse: req.authData.pieces,
            grant: authResult
        };
        //res.send(200)
        }
        next();
    }

module.exports = regHook;

