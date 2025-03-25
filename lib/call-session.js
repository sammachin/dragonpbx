const Emitter = require('events');
const connectCall = require('./connectCall');

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
    let params = {
      address: '1000',
      type: 'client',
      timeout: 60,
      cli: 8888
    }
    this.call = await new connectCall(this.logger, this.req, this.res, params)
    this.call.action();
  }
}

module.exports = CallSession;