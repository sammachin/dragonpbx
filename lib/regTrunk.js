const parseUri = require('drachtio-srf').parseUri;
const Emitter = require('events');
const { listDomains, getRegTrunks} = require('./data')
const _ = require('lodash');
const {createClient} = require('redis');
const crypto = require("crypto");



class RegTrunks extends Emitter {
  constructor(srf, logger) {
    super();
    this.srf = srf;
    this.logger = logger;
    this.trunks = {};
    this.timers = []
    
  }

  async setup(){
    this.logger.info('RegTrunks Setup')
    this.redisClient = await createClient()
      .on('error', err => logger.error('Redis Client Error', err))
      .connect();
  }

  async refresh() {
    let trunklist = {};
    const domains = await listDomains();
    for (const domain of domains) {
      let tl = await getRegTrunks(domain);
      trunklist[domain] = tl;
    }
    if (!_.isEqual(this.trunks, trunklist)){
      this.logger.info('Trunklist Updated, re-registering all trunks')
      this.trunks = trunklist;
      this.start(); 
    }
  }

  async start() {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers = [];
    Object.keys(this.trunks).forEach((d) => {
      this.logger.info(`Regtrunks for ${d}: ${this.trunks[d].length} `)
      for (const t of this.trunks[d]) {
        this.register(t.regHost, t.regUser, t.regPass, d, t)
      }
    })
  }

  async register(server, username, password, domain, trunk, uuid=false) {
    if (!uuid) uuid = crypto.randomUUID();
    const uri = `sip:${server}`;
    const contact = `<sip:${username}@${domain};reg-id=${uuid}>`;
    const expiry = 60;
    this.srf.request(uri, {
      method: 'REGISTER',
      headers: {
        'Contact': contact,
        'From': `<sip:${username}@${domain}>`,
        'To': `<sip:${username}@${server}>`,
        'Expires': expiry,
        'Allow': 'INVITE, ACK, BYE, CANCEL, OPTIONS, MESSAGE, INFO, UPDATE, REGISTER, REFER, NOTIFY'
      },
      auth: {
        username: username,
        password: password
      }
    }, (err, req) => {
      if (err) {this.logger.error(err)};
      req.on('response', (res) => {
        if (res.status === 200) {
          if (expiry != 0) {
            let timeout = (res.headers.expires/2)*1000
            this.logger.info(`${username}@${server} Registered OK, timeout ${timeout}`)
            let t = setTimeout(() => this.register(server, username, password, domain, trunk, uuid), timeout)
            this.timers.push(t);
            let key = `regtrunk:${domain}:${uuid}`
            this.redisClient.multi()
              .hSet(key, 'trunkID', trunk.id)
              .expire(key, expiry)
              .execAsPipeline()
          }
          else {
            console.log(`REGISTER was rejected after auth with ${res.status}`);
          }
        };
      });
    });
  }
}
module.exports = RegTrunks


