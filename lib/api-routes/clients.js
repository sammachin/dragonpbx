const express = require('express');
const router = express.Router({ mergeParams: true });
const {listDomains, getDomain} = require('../data')


// get registered clients
router.get('/', async (req, res) => {
  const logger = req.app.locals.logger;
  const redisClient = req.app.locals.redisClient;
  
});



module.exports = router;