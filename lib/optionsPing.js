const Emitter = require('events');
const _ = require('lodash');
const { listDomains, getTrunks } = require('./data');
const { OPTIONSPINGINTERVAL } = require('../settings');

// Sends a periodic SIP OPTIONS keepalive to each trunk's outbound host as a
// liveness probe. Enabled per-trunk via the `options_ping` config flag, which
// defaults to on (only an explicit `false` disables it). Results are logged at
// debug level only — no state is stored and routing is unaffected.
class OptionsPing extends Emitter {
  constructor(srf, logger) {
    super();
    this.srf = srf;
    this.logger = logger;
    this.trunks = {};
    this.timers = new Map();
  }

  async refresh() {
    let trunklist = {};
    const domains = await listDomains();
    for (const domain of domains) {
      trunklist[domain] = await getTrunks(domain);
    }
    if (!_.isEqual(this.trunks, trunklist)) {
      this.logger.info('Trunklist updated, rescheduling OPTIONS pings');
      this.trunks = trunklist;
      this.start();
    }
  }

  start() {
    this.stop();
    Object.keys(this.trunks).forEach((domain) => {
      for (const t of this.trunks[domain]) {
        if (t.options_ping === false) continue;   // default on
        if (!t.outbound || !t.outbound.host) continue;
        this.schedule(domain, t);
      }
    });
  }

  stop() {
    this.timers.forEach((t) => clearInterval(t));
    this.timers.clear();
  }

  schedule(domain, trunk) {
    const key = `${domain}:${trunk.id || trunk.name || trunk.outbound.host}`;
    this.ping(domain, trunk);   // probe immediately, then on the interval
    const timer = setInterval(() => this.ping(domain, trunk), OPTIONSPINGINTERVAL);
    this.timers.set(key, timer);
  }

  ping(domain, trunk) {
    const host = trunk.outbound.host;
    const uri = `sip:${host}`;
    this.srf.request(uri, {
      method: 'OPTIONS',
      headers: {
        'From': `<sip:dragonpbx@${host}>`,
        'To': `<sip:${host}>`
      }
    }, (err, req) => {
      if (err) {
        this.logger.debug({err: err.message || err, domain, trunk: trunk.id, host},
          'OPTIONS ping: error sending');
        return;
      }
      req.on('response', (res) => {
        this.logger.debug({domain, trunk: trunk.id, host, status: res.status},
          'OPTIONS ping response');
      });
    });
  }
}

module.exports = OptionsPing;
