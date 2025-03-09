const Emitter = require('events');

class CallSession extends Emitter {
  constructor(logger, req, res) {
    super();
    this.req = req;
    this.res = res;
    this.srf = req.srf;
    this.logger = logger.child({callId: req.get('Call-ID')});
  }

  async invite() {
    this.logger.info('INVITE', this.req)
  }
  
}

module.exports = CallSession;