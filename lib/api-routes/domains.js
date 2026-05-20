const express = require('express');
const router = express.Router();
const {listDomains, getDomain} = require('../data/')


router.get('/:domain', async(req, res) => {
  const logger = req.app.locals.logger;
  try {
  const response = await getDomain(req.params.domain);
    return res.status(200).json(response);
  } catch (err) {
    logger.error({response}, 'error fetching domain');
    return res.status(400)
  }
});


// List domains
router.get('/', async (req, res) => {
  const domains = await listDomains();
  return res.status(200).json(domains);
});

module.exports = router;