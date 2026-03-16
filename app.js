const assert = require('assert');

const Srf = require('drachtio-srf');
const {createClient} = require('redis');
const { LOGLEVEL, DRACHTIO_HOST, DRACHTIO_PORT, DRACHTIO_SECRET, WEBPORT, REGTRUNKREFRESH } = require('./settings');

const CallSession = require('./lib/callSession');
const Registration = require('./lib/registration');
const srf = new Srf('sbc-inbound');
const opts = Object.assign({
  base: null,
  timestamp: () => {return `, "time": "${new Date().toISOString()}"`;}
}, {level: LOGLEVEL});
const logger = require('pino')(opts);
console.log(`Loglevel is ${LOGLEVEL}`)
const express = require('express');
const routes = require('./lib/api-routes');

const redisClient = createClient();
redisClient.on('error', err => logger.error('Redis Client Error', err));
redisClient.connect();

srf.locals = {
  ...srf.locals,
  logger,
  redisClient,
}

const { initLocals, checkDomain, isTrunk} = require('./lib/middleware')(srf, logger);
const digestChallenge = require('./lib/utils/digestChallenge');
const regHook = require('./lib/utils/regHook');
const {getCallHook, getCallScript} = require('./lib/utils/callHook');
const isauthTrunk = require('./lib/authTrunk');
const isRegTrunk = require('./lib/isRegTrunk');
const RegTrunks = require('./lib/regTrunk')

let regtrunks = null;
let regTrunksRefreshTimer = null;

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

let reconnectAttempts = 0;
const maxReconnectAttempts = 10;
const baseDelay = 1000; // 1 second

srf.connect({ host: DRACHTIO_HOST, port: DRACHTIO_PORT, secret: DRACHTIO_SECRET });
srf.on('connect', async (err, hp, version, localHostports) => {
  if (err) return logger.error({err}, 'Error connecting to drachtio server');
  const hostports = localHostports ? localHostports.split(',') : hp.split(',');
  srf.locals.privateSipAddress = getActiveSbcAddress(hostports);
  srf.locals.sbcPublicIpAddress = parseHostPorts(logger, hostports, srf);
  logger.info(`Successfully connected to drachtio server`);
  logger.info(srf.locals.privateSipAddress, 'Drachtio server private IP address');
  logger.info(srf.locals.sbcPublicIpAddress, `Drachtio server hostports`);
  if (!regtrunks) {
    regtrunks = new RegTrunks(srf, logger, redisClient);
  }
  await regtrunks.setup();
  await regtrunks.start();
  if (regTrunksRefreshTimer) {
    clearTimeout(regTrunksRefreshTimer);
    regTrunksRefreshTimer = null;
  }
  regTrunksRefresh();
});

function reconnect() {
  if (reconnectAttempts >= maxReconnectAttempts) {
    logger.fatal('Max reconnection attempts reached');
    return;
  }
  const delay = Math.min(baseDelay * Math.pow(2, reconnectAttempts), 30000); // Cap at 30 seconds
  logger.info(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts + 1})`);
  setTimeout(() => {
    reconnectAttempts++;
  }, delay);
}

srf.on('disconnect', () => {
  logger.error('Disconnected from drachtio server');
  reconnect();
});

srf.on('error', (err) => {
  logger.error('Connection error:', err);
  // Don't reconnect on error - wait for disconnect event
});



/* we check the domain for all incomming requests and if it doens't match reject early */
srf.use(checkDomain)

/* middleware for invite */
srf.use('invite', [
  initLocals,
  isTrunk,
  isRegTrunk,
  digestChallenge,
  isauthTrunk,
  regHook,
  getCallHook,
  getCallScript
]);

/* middleware for register */
srf.use('register', [
  initLocals,
  digestChallenge,
  regHook,
]);


const activeCalls = new Map();

srf.invite(async (req, res) => {
  const callId = req.get('Call-ID');
  logger.info(`New Incomming Call Session for callId: ${callId}`);
  const session = new CallSession(logger, req, res);
  activeCalls.set(callId, session);
  try {
    await session.execute();
  } finally {
    activeCalls.delete(callId);
  }
});

srf.register((req, res) => {
  const session = new Registration(logger, req, res);
  session.register();
});

srf.options((req, res) => {
  res.send(200)
})

srf.refer((req, res) => {
  logger.info(`Out of sesson REFER  for callId: ${req.get('Call-ID')} from ${req.get('Referred-By')}`);
  res.send(400)
})

/* catch other stuff and reject it */
srf.use((req, res, next, err) => {
  logger.error(err, 'hit top-level error handler');
  res.send(500);
});



// Outbound Registrations
async function regTrunksRefresh() {
  await regtrunks.refresh();
  regTrunksRefreshTimer = setTimeout(regTrunksRefresh, REGTRUNKREFRESH);
}


// API Server
const api = express()
api.locals.logger = logger;
api.locals.redisClient = srf.locals.redisClient;
api.use(express.json());

api.use('/', routes);
api.listen(WEBPORT, () => {
  console.log(`API listening on port ${WEBPORT}`)
})

module.exports = {srf, logger, activeCalls};