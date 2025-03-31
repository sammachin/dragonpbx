const Emitter = require('events');
const { REGISTRATION_MAX_SECS, REGISTRATION_MIN_SECS } = require('../settings');



function clampRegistration(registration) {
  return Math.min(Math.max(registration, REGISTRATION_MIN_SECS), REGISTRATION_MAX_SECS);
}

class Registration extends Emitter {
  constructor(logger, req, res) {
    super();
    this.req = req;
    this.res = res;
    this.srf = req.srf;
    this.logger = logger.child({callId: req.get('Call-ID')});
    this.rclient = this.req.locals.redisClient
  }

  async register() {
    this.logger.info(`REGISTER ${this.req.locals.fromUri.user}`)
    let expires = clampRegistration(this.req.authorization.grant.expires ||this.req.headers.expires)
    let key = `client:${this.req.locals.domain}:${this.req.locals.fromUri.user}`
    let contactHeader = this.req.getParsedHeader('contact')[0]
    await this.rclient.multi()
      .hSet(key, 'contact', contactHeader.uri)
      .hSet(key, 'dialplan', JSON.stringify(this.req.authorization.grant.dialplan))
      .expire(key, expires)
      .execAsPipeline()
      .then((results) => {
          this.res.send(200, {headers: {expires: expires}})
      })
      .catch((error) => {
        this.logger.error(error)
        this.res.send(500)
      })

  }
}

module.exports = Registration;