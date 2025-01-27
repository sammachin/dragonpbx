const express = require('express');
const routes = express.Router();
const Client = require('../../models/client');

router.get('/:did', async(req, res) => {
  const logger = req.app.locals.logger;
  try {
    const results = await Client.retrieve(req.params.sid);
    if (results.length === 0) return res.sendStatus(404);
    const client = results[0];
    client.password = obscureKey(decrypt(client.password), 1);
    if (req.user.hasAccountAuth && client.account_sid !== req.user.account_sid) {
      return res.sendStatus(404);
    } else if (req.user.hasServiceProviderAuth) {
      const accounts = await Account.retrieve(client.account_sid, req.user.service_provider_sid);
      if (!accounts.length) {
        return res.sendStatus(404);
      }
    }
    return res.status(200).json(client);
  } catch (err) {
    sysError(logger, res, err);
  }
});


// health checks
routes.get('/', (req, res) => {
  res.sendStatus(200);
});

routes.get('/health', (req, res) => {
  res.sendStatus(200);
});

module.exports = routes;