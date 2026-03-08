const parseUri = require('drachtio-srf').parseUri;
const Emitter = require('events');
const { listDomains, getRegTrunks} = require('./data')
const _ = require('lodash');
const {createClient} = require('redis');
const crypto = require("crypto");

  class RegTrunks extends Emitter {
  constructor(srf, logger, redisClient) {
    super();
    this.srf = srf;
    this.logger = logger;
    this.trunks = {};
    this.timers = new Map();
    this.redisClient = redisClient || null;
    this._setupPromise = null;
  }

  async setup() {
    if (this._setupPromise) return this._setupPromise;
    if (this.redisClient) {
      this._setupPromise = Promise.resolve();
      return this._setupPromise;
    }
    this._setupPromise = (async () => {
      this.logger.info('RegTrunks Setup');
      this.redisClient = createClient();
      this.redisClient.on('error', err =>
        this.logger.error('Redis Client Error', err)
      );
      await this.redisClient.connect();
      this.logger.info('Redis client connected');
    })();
    return this._setupPromise;
  }

  async start() {
    // Ensure Redis is connected before proceeding
    await this.setup();
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
    await this.deleteKeysWithPrefix('regtrunk:');
    Object.keys(this.trunks).forEach((d) => {
      this.logger.info(`Regtrunks for ${d}: ${this.trunks[d].length}`);
      for (const t of this.trunks[d]) {
        this.register(t.regHost, t.regUser, t.regPass, d, t);
      }
    });
  }


  stop() {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
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


  async deleteKeysWithPrefix(prefix) {
  let deletedCount = 0;
  // Use scanIterator to iterate through keys matching the pattern
  for await (const key of this.redisClient.scanIterator({
    MATCH: `${prefix}*`,
    COUNT: 100 // Process 100 keys at a time
  })) {
    await this.redisClient.unlink(key);
    deletedCount++;
  }
  this.logger.info(`${deletedCount} regtrunks removed from redis`)
  return;
}

  async register(server, username, password, domain, trunk, uuid=false) {
    if (!uuid) uuid = crypto.randomUUID();
    const uri = `sip:${server}`;
    const contact = `<sip:${username}@${domain};reg-id=${uuid}>`;
    const callid = crypto.createHash('md5').update(`${domain}-${server}`).digest('hex')
    const expiry = 60;
    this.srf.request(uri, {
      method: 'REGISTER',
      headers: {
        'Contact': contact,
        'From': `<sip:${username}@${domain}>`,
        'To': `<sip:${username}@${server}>`,
        'Expires': expiry,
        'Allow': 'INVITE, ACK, BYE, CANCEL, OPTIONS, MESSAGE, INFO, UPDATE, REGISTER, REFER, NOTIFY',
        'Call-ID': callid
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
            let key = `regtrunk:${domain}:${uuid}`
            this.redisClient.multi()
              .hSet(key, 'trunkID', trunk.id)
              .expire(key, res.headers.expires)
              .execAsPipeline()
            let t = setTimeout(() => this.register(server, username, password, domain, trunk, uuid), timeout)
            this.timers.set(uuid, t);
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


