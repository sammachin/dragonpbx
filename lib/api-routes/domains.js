const express = require('express');
const router = express.Router();

router.get('/:did', async(req, res) => {
  const logger = req.app.locals.logger;
  try {
    client = ['sbc.sammachin.com', 'sip.sammachin.com']
    return res.status(200).json(client);
  } catch (err) {
    sysError(logger, res, err);
  }
});


// health checks
router.get('/', (req, res) => {
  res.sendStatus(200);
});

router.get('/health', (req, res) => {
  res.sendStatus(200);
});

module.exports = router;