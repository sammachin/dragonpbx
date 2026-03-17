const express = require('express');
const router = express.Router({ mergeParams: true });
const {listDomains, getDomain} = require('../data')


// get registered clients
router.get('/', async (req, res) => {
  const logger = req.app.locals.logger;
  const redisClient = req.app.locals.redisClient;
  const domain = req.params.did;
  if (!/^[\w.\-@]+$/.test(domain)) {
    return res.status(400).send('Invalid domain');
  }
  const key = `client:${domain}:*`
  await redisClient.keys(key)
  .then((results) => {
          clients = []
          results.forEach(r => {
            clients.push(r.split(":")[2])
          });
          res.status(200).json(clients);
      })
  .catch((error) => {
        logger.error(error)
        res.send(500)
      })
});

// get  client
router.get('/:cid', async (req, res) => {
  const logger = req.app.locals.logger;
  const redisClient = req.app.locals.redisClient;
  const domain = req.params.did;
  const client = req.params.cid;
  if (!/^[\w.\-@]+$/.test(domain)) {
    return res.status(400).send('Invalid domain');
  }
  if (!/^[\w.\-@]+$/.test(client)) {
    return res.status(400).send('Invalid client ID');
  }
  const key = `client:${domain}:${client}`
  await redisClient.hGetAll(key)
  .then((results) => {
      res.status(200).json(results);
  })
  .catch((error) => {
        logger.error(error)
        res.send(404)
      })
});

module.exports = router;