const assert = require('assert');

const Srf = require('drachtio-srf');
const { LOGLEVEL, DRACHTIO_HOST, DRACHTIO_PORT, DRACHTIO_SECRET, WEBPORT } = require('./settings');

const CallSession = require('./lib/call-session');
const Registration = require('./lib/registration');
const srf = new Srf('sbc-inbound');
const opts = Object.assign({
  timestamp: () => {return `, "time": "${new Date().toISOString()}"`;}
}, {level: LOGLEVEL});
const logger = require('pino')(opts);

const express = require('express');
const routes = require('./lib/api-routes');

srf.locals = {
  ...srf.locals,
  logger,
}

const { initLocals, checkDomain, addRegHook } = require('./lib/middleware')(srf, logger);
const digestChallenge = require('./lib/utils/digestChallenge');
const regHook = require('./lib/utils/regHook');

const getActiveSbcAddress = (hostports) => {
  let host = '', port = -1;
  for (const hp of hostports) {
    const arr = /^(.*)\/(.*):(\d+)$/.exec(hp);
    // use tcp interface to get private IP address
    if (arr && 'tcp' === arr[1]) {
      host = arr[2];
    }
    // use udp interface to get the port, due to jambonz's components send OPTIONS to sbc on UDP
    else if (arr && 'udp' === arr[1]) {
      port = arr[3] ? Number(arr[3]) : 5060;
    }
  }

  if (!host || port === -1) {
    throw new Error('Drachtio server is not configured for Jambonz,' +
      'please run drachtio with udp interface and one tcp interface without extenal-ip');
  }

  return `${host}:${port}`;
};

const parseHostPorts = (logger, hostports, srf) => {
  typeof hostports === 'string' && (hostports = hostports.split(','));
  const obj = {};
  for (const hp of hostports) {
    const [, protocol, ipv4, port] = hp.match(/^(.*)\/(.*):(\d+)$/);
    if (protocol && ipv4 && port) {
      obj[protocol] = `${ipv4}:${port}`;
    }
  }
  return obj;
};

srf.connect({ host: DRACHTIO_HOST, port: DRACHTIO_PORT, secret: DRACHTIO_SECRET });
srf.on('connect', (err, hp, version, localHostports) => {
  if (err) return this.logger.error({err}, 'Error connecting to drachtio server');
  const hostports = localHostports ? localHostports.split(',') : hp.split(',');
  srf.locals.privateSipAddress = getActiveSbcAddress(hostports);
  srf.locals.sbcPublicIpAddress = parseHostPorts(logger, hostports, srf);

  logger.info(`Successfully connected to drachtio server`);
  logger.info(srf.locals.privateSipAddress, 'Drachtio server private IP address');
  logger.info(srf.locals.sbcPublicIpAddress, `Drachtio server hostports`);
});


srf.use(checkDomain)

/* install middleware */
srf.use('invite', [
  initLocals,
]);

srf.use('register', [
  initLocals,
  digestChallenge,
  regHook,
]);



srf.invite((req, res) => {
  const session = new CallSession(logger, req, res);
  session.invite();
});


srf.register((req, res) => {
  const session = new Registration(logger, req, res);
  session.register();
});


srf.use((req, res, next, err) => {
  logger.error(err, 'hit top-level error handler');
  res.send(500);
});


// API Server
const api = express()
api.use(express.json());

api.use('/', routes);
api.listen(WEBPORT, () => {
  console.log(`API listening on port ${WEBPORT}`)
})





module.exports = {srf, logger, api};