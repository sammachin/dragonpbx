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
    console.log(this.req.msg)
    console.log(this.req.source_address)
    //Look at requestor code in jambonz: https://github.com/jambonz/jambonz-feature-server/blob/59d9c62cbe2bf49d9f17b420e2b560b633c0653c/lib/utils/place-outdial.js#L373
    this.res.send(200, {headers: {Expires: 300}})
  }
}

module.exports = Registration;