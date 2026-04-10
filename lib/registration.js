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
    this.callID = req.get('Call-ID')
    this.logger = logger.child({callId: this.callID});
    this.rclient = this.req.locals.redisClient,
    this.maxClients = this.req.authorization.grant.maxClients || 1
  }

  async register() {
    this.logger.info(`REGISTER ${this.req.locals.fromUri.user}`)
    let expires = clampRegistration(this.req.authorization.grant.expires ||this.req.headers.expires)
    let key = `client:${this.req.locals.domain}:${this.req.locals.fromUri.user}`
    let contactHeader = this.req.getParsedHeader('contact')[0]
    await this.rclient.multi()
      .hSet(key, `contact:${this.callID}`, contactHeader.uri)
      .hSet(key, `proxy:${this.callID}`, `sip:${this.req.source_address}:${this.req.source_port}`)
      .hSet(key, 'dialplan', JSON.stringify(this.req.authorization.grant.dialplan))
      .hSet(key, 'codecs', JSON.stringify(this.req.authorization.grant.codecs))
      .hExpire(key, [`contact:${this.callID}`, `proxy:${this.callID}`], expires)
      .execAsPipeline()
      .then((results) => {
          this.res.send(200, {headers: {expires: expires, contact: this.req.headers.contact}})
      })
      .catch((error) => {
        this.logger.error(error)
        this.res.send(500)
      })

  }
}

module.exports = Registration;