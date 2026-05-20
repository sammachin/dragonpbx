const express = require('express');
const router = express.Router({ mergeParams: true });
const {listDomains, getDomain} = require('../data/')
const getActiveCalls = () => require('../../app').activeCalls;


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