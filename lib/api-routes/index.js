const express = require('express');
const routes = express.Router();

routes.use('/domains', require('./domains'));
//routes.use('/domains/:did/users', require('./users'));
//routes.use('/domains/:did/clients', require('./clients'));
//routes.use('/domains/:did/trunks', require('./trunks'));
//routes.use('/domains/:did/calls', require('./calls'));

// health checks
routes.get('/', (req, res) => {
  res.sendStatus(200);
});

routes.get('/health', (req, res) => {
  res.sendStatus(200);
});

module.exports = routes;