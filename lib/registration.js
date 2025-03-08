const Emitter = require('events');




class Registration extends Emitter {
  constructor(logger, req, res) {
    super();
    this.req = req;
    this.res = res;
    this.srf = req.srf;
    this.logger = logger.child({callId: req.get('Call-ID')});
  }

  async register() {
    console.log(this.req.authorization)
    this.res.send(200, {headers: {Expires: 300}})
  }
}

module.exports = Registration;