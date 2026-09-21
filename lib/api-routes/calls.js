const express = require('express');
const router = express.Router({ mergeParams: true });
const {listDomains, getDomain} = require('../data/')
const {getCallScript} = require('../utils/callHook');
const getActiveCalls = () => require('../../app').activeCalls;

// Fetch a new callScript for an update-leg request, reusing the normal callHook
// machinery (same POST body params) but sourced from the live session and marked
// with trigger:"updateLeg" + the leg being kept.
async function fetchUpdateScript(session, callHook, leg) {
  const synthReq = {
    srf: session.req.srf,
    source_address: session.req.source_address,
    headers: session.req.headers,
    get: (h) => session.req.get(h),
    locals: {
      ...session.req.locals,
      callHook,
      trigger: 'updateLeg',
      leg,
      refer: false,
    },
  };
  let failCode = null;
  const synthRes = { send: (code) => { failCode = code; } };
  await getCallScript(synthReq, synthRes, null);
  if (failCode || !synthReq.locals.callScript) {
    throw new Error(`callHook fetch failed (${failCode || 'no script'})`);
  }
  return synthReq.locals.callScript;
}


// get all active calls
router.get('/', async (req, res) => {
  const activeCalls = getActiveCalls();
  const calls = [];
  for (const [callId, session] of activeCalls) {
    if (session.req.locals.domain == req.params.did) {
      const connected = session.successfullyConnected;
      const endpointB = session.dialog?.uac?.remote?.uri || null;
      const endpointA = session.dialog?.uas?.remote?.uri || null;
      from = session.req.locals.fromUri.user
      to = session.req.locals.toUri.user,
      lastStatus = session.res.msg.status
      calls.push({ domain: session.req.locals.domain, callId, from, to, connected, endpointB, endpointA, lastStatus });
    }
  }
  return res.status(200).json(calls);
});

// get call session
router.get('/:callId', async(req, res) => {
  const logger = req.app.locals.logger;
  const callId = req.params.callId;
  try {
    const session = getActiveCalls().get(callId);
    if (!session) return res.status(404).send('Call not found');
    if (session.req.locals.domain !== req.params.did) return res.status(400).send('Domain mismatch');
    const connected = session.successfullyConnected;
    const endpointB = session.dialog?.uac?.remote?.uri || null;
    const endpointA = session.dialog?.uas?.remote?.uri || null;
    const from = session.req.locals.fromUri.user;
    const to = session.req.locals.toUri.user;
    const lastStatus = session.res.msg.status;
    return res.status(200).json({ domain: session.req.locals.domain, callId, from, to, connected, endpointB, endpointA, lastStatus });
  } catch (err) {
    return res.status(404).send('Call not found')
  }
});

// Update a call leg: run a new callScript on the kept leg (?leg=A|B) and
// terminate the other. Body is either a verb array, or an object
// { callHook, statusHook } whose callHook is fetched (same params as a normal
// call hook, plus trigger:"updateLeg"). Async: returns 202 once accepted; any
// later failure is reported via the statusHook (updateLeg:failed).
router.put('/:callId', async (req, res) => {
  const logger = req.app.locals.logger;
  const callId = req.params.callId;
  const did = req.params.did;
  const leg = String(req.query.leg || 'A').toUpperCase();

  if (leg !== 'A' && leg !== 'B') {
    return res.status(400).send('leg must be A or B');
  }

  const session = getActiveCalls().get(callId);
  if (!session) return res.status(404).send('Call not found');
  if (session.req.locals.domain !== did) return res.status(400).send('Domain mismatch');

  if (!(session.successfullyConnected && session.dialog?.uas && session.dialog?.uac)) {
    return res.status(409).send('Call is not connected');
  }

  // Resolve the new callScript from the body.
  const body = req.body;
  let callScript, statusHook;
  if (Array.isArray(body)) {
    callScript = body;
  } else if (body && typeof body === 'object' && typeof body.callHook === 'string') {
    statusHook = body.statusHook;
    try {
      callScript = await fetchUpdateScript(session, body.callHook, leg);
    } catch (err) {
      logger.error({err: err.message || err}, 'updateLeg: callHook fetch failed');
      return res.status(480).send('Failed to fetch callHook');
    }
  } else {
    return res.status(400).send('Body must be a verb array or an object with a callHook URL');
  }

  if (!Array.isArray(callScript) || callScript.length === 0) {
    return res.status(400).send('callScript must be a non-empty array of verbs');
  }

  try {
    await session.updateLeg({ keep: leg, callScript, statusHook });
  } catch (err) {
    logger.error({err: err.message || err, code: err.code}, 'updateLeg failed');
    if (err.code === 'NOT_CONNECTED' || err.code === 'BAD_LEG_STATE') return res.status(409).send(err.message);
    if (err.code === 'BAD_SCRIPT' || err.code === 'BAD_LEG') return res.status(400).send(err.message);
    if (err.code === 'NOT_IMPLEMENTED') return res.status(501).send(err.message);
    return res.status(500).send('Failed to update call');
  }

  return res.status(202).send('Update accepted');
});

// End Call
router.delete('/:callId', async(req, res) => {
  const logger = req.app.locals.logger;
  const callId = req.params.callId;
  try {
    const session = getActiveCalls().get(callId);
    if (session.req.locals.domain == req.params.did) {
      logger.info(`Destroying call ${callId}`);
      const leg = req.query.leg || 'A';
      if (leg.toUpperCase() === 'A') {
        if (session.dialog?.uas) session.dialog.uas.emit('destroy');
      } else if (leg.toUpperCase() === 'B') {
        if (session.dialog?.uac) session.dialog.uac.emit('destroy');
      } else {
        if (session.dialog?.uas) session.dialog.uas.emit('destroy');
      }
      return res.status(200).send('Call terminated')
    } else {
      return res.status(400).send('Domain mismatch')
  }
  } catch (err) {
    logger.error({err}, `Error destroying call ${callId}`);
    return res.status(404).send('Call not found')
  }
});


module.exports = router;