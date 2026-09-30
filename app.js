const assert = require('assert');

const Srf = require('drachtio-srf');
const {createClient} = require('redis');
const { LOGLEVEL, DRACHTIO_HOST, DRACHTIO_PORT, DRACHTIO_SECRET, WEBPORT, REGTRUNKREFRESH, REDIS_URL } = require('./settings');

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

const redisClient = createClient({url: REDIS_URL});
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
const OptionsPing = require('./lib/optionsPing')

let regtrunks = null;
let optionsPing = null;
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

// drachtio-srf reconnects automatically on connection loss (with backoff); we
// just cap the retry delay so it keeps trying at a sane interval rather than
// growing unbounded. There is no manual reconnect loop — see the reconnecting/
// error/close handlers below, which only pause our own timers while down.
srf.connect({
  host: DRACHTIO_HOST,
  port: DRACHTIO_PORT,
  secret: DRACHTIO_SECRET,
  reconnect: { retryMaxDelay: 30000 }
});
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
  if (!optionsPing) {
    optionsPing = new OptionsPing(srf, logger);
  }
  await regtrunks.setup();
  await regtrunks.start();
  // Restart OPTIONS pings explicitly: on a reconnect the trunk list is unchanged
  // so optionsPing.refresh() (called from regTrunksRefresh) won't re-schedule the
  // timers that pauseWhileDisconnected() stopped. start() is a no-op on the very
  // first connect (no trunks loaded yet) — regTrunksRefresh seeds them below.
  optionsPing.start();
  if (regTrunksRefreshTimer) {
    clearTimeout(regTrunksRefreshTimer);
    regTrunksRefreshTimer = null;
  }
  regTrunksRefresh();
});

// Pause our own periodic work while the drachtio connection is down, so we
// don't fire OPTIONS pings / reg-trunk refreshes at a dead socket. The 'connect'
// handler above restarts them on (re)connect. Idempotent — safe to call for
// each of the reconnecting/error/close events that a single drop produces.
function pauseWhileDisconnected() {
  if (regTrunksRefreshTimer) {
    clearTimeout(regTrunksRefreshTimer);
    regTrunksRefreshTimer = null;
  }
  if (optionsPing) optionsPing.stop();
  if (regtrunks) regtrunks.stop();
}

// drachtio-srf handles reconnection internally and emits these events (there is
// no 'disconnect' event); we only log and pause our timers.
srf.on('reconnecting', (opts) => {
  logger.warn({opts}, 'Reconnecting to drachtio server');
  pauseWhileDisconnected();
});

srf.on('close', () => {
  logger.warn('drachtio connection closed; awaiting automatic reconnect');
  pauseWhileDisconnected();
});

srf.on('error', (err) => {
  logger.error({err: err.message || err}, 'drachtio connection error');
  pauseWhileDisconnected();
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
  try {
    await regtrunks.refresh();
  } catch (err) {
    logger.warn({err}, 'regTrunksRefresh failed, will retry');
  }
  try {
    await optionsPing.refresh();
  } catch (err) {
    logger.warn({err}, 'optionsPing refresh failed, will retry');
  }
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