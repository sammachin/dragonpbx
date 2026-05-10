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

  async getClientContacts(key, full=false) {
        const hKeys = await this.rclient.hKeys(key)
        const regex = /^contact:/
        let contacts = []
        for (const k of hKeys) {
          if (regex.test(k)) {
            if (full) {
              let c = await this.rclient.hGet(key, k)
              let exp = await this.rclient.hTTL(key, k)
              contacts.push(c+";expires="+exp)
            } else{
              let cid = k.substring('contact:'.length)
              contacts.push(cid)
            }
          }
        }
        return contacts
    }

  

  async removeShortestExpiryContact(key){
    const contacts = await this.getClientContacts(key)
    if (contacts.length === 0) return
    const contactFields = contacts.map(c => `contact:${c}`)
    const ttls = await this.rclient.hTTL(key, contactFields)
    let minIdx = 0
    for (let i = 1; i < ttls.length; i++) {
      if (ttls[i] < ttls[minIdx]) minIdx = i
    }
    const evictId = contacts[minIdx]
    this.logger.info(`Evicting contact ${evictId} with TTL ${ttls[minIdx]}`)
    await this.rclient.hDel(key, [`contact:${evictId}`, `proxy:${evictId}`])
  }

  async deregister() {
    let key = `client:${this.req.locals.domain}:${this.req.locals.fromUri.user}`
    let contactHeader = this.req.get('Contact')
    try {
      if (contactHeader.trim() === '*') {
        this.logger.info(`DE-REGISTER all contacts for ${this.req.locals.fromUri.user}`)
        await this.rclient.del(key)
      } else {
        this.logger.info(`DE-REGISTER contact ${this.callID} for ${this.req.locals.fromUri.user}`)
        await this.rclient.hDel(key, [`contact:${this.callID}`, `proxy:${this.callID}`])
      }
      this.res.send(200, {headers: {expires: 0}})
    } catch (error) {
      this.logger.error(error)
      this.res.send(500)
    }
  }

  async register() {
    this.logger.info(`REGISTER ${this.req.locals.fromUri.user}, maxClients: ${this.maxClients}`)
    let expires = parseInt(this.req.authorization.grant.expires || this.req.headers.expires) || REGISTRATION_MIN_SECS
    let key = `client:${this.req.locals.domain}:${this.req.locals.fromUri.user}`
    if (this.req.headers.expires === 0) {
      return this.deregister()
    }
    expires = clampRegistration(expires)
    let contactHeader = this.req.getParsedHeader('contact')[0]
    const contacts = await this.getClientContacts(key)
    if (contacts.includes(this.callID) || contacts.length < this.maxClients)
    {
       this.logger.info('Updating/adding  existing registraiton')
    } else {
      this.logger.info('maxClients reached, evicting shortest expiry')
      await this.removeShortestExpiryContact(key);
    }
    let otherContacts = await this.getClientContacts(key, true)
    await this.rclient.multi()
    .hSet(key, `contact:${this.callID}`, contactHeader.uri)
    .hSet(key, `proxy:${this.callID}`, `sip:${this.req.source_address}:${this.req.source_port}`)
    .hSet(key, 'dialplan', JSON.stringify(this.req.authorization.grant.dialplan))
    .hSet(key, 'codecs', JSON.stringify(this.req.authorization.grant.codecs))
    .hExpire(key, [`contact:${this.callID}`, `proxy:${this.callID}`], expires)
    .execAsPipeline()
    .then((results) => {
        this.res.send(200, {headers: {expires: expires, contact: otherContacts}})
    })
    .catch((error) => {
      this.logger.error(error)
      this.res.send(500)
    })
    
  
    

  }
}

module.exports = Registration;