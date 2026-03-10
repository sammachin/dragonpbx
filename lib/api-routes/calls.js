const express = require('express');
const router = express.Router();
const {listDomains, getDomain} = require('../data/')


router.get('/:callId', async(req, res) => {
  const logger = req.app.locals.logger;
  const domain = await getDomain(domain);
  try {
  const domain = await getDomain(domain);
    return res.status(200).json();
  } catch (err) {
    sysError(logger, res, err);
  }
});


// health checks
router.get('/', async (req, res) => {
  const domains = await listDomains();
  return res.status(200).json(domains);
});

module.exports = router;