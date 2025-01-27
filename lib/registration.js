const Emitter = require('events');

class Registration extends Emitter {
  constructor(logger, req, res) {
    super();
    this.req = req;
    this.res = res;
    this.srf = req.srf;
    this.logger = logger.child({callId: req.get('Call-ID')});
  }

  async connect() {
    this.srf.proxyRequest(this.req, this.req.locals.proxy)
    .then((results) => console.log(JSON.stringify(results, null, 2)) );
  }
}

module.exports = Registration;