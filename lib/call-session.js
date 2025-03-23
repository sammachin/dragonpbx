const Emitter = require('events');
const connectCall = require('connectCall');

class CallSession extends Emitter {
  constructor(logger, req, res) {
    super();
    this.req = req;
    this.res = res;
    this.srf = req.srf;
    this.logger = logger.child({callId: req.get('Call-ID')});
    this.rclient = this.req.locals.redisClient

  }

  async invite() {
    this.logger.info(this.req.locals)
    let params = 
    this.call = new connectCall(logger, req, res, params)
  }
}

module.exports = CallSession;