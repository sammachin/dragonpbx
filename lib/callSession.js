const Emitter = require('events');

const connection = require('./connectCall')
const announcement = require('./playAnnouncement')
const response = require('./sendResponse')
const pause = require('./pause')
const record = require('./record')
const pickup = require('./pickupCall')

const StatusHook = require('./utils/statusHook')
const rtpengine = require('rtpengine-client').Client
const { RTPENGINE_HOST, RTPENGINE_PORT, RTPENGINE_TIMEOUT, DEFAULT_CODECS } = require('../settings');
const rtpClient = new rtpengine({timeout: RTPENGINE_TIMEOUT});
const {getCallScript} = require('./utils/callHook');


class CallSession extends Emitter {
  constructor(logger, req, res) {
    super();
    this.req = req;
    this.res = res;
    this.srf = req.srf;
    this.logger = logger.child({callId: req.get('Call-ID')});
    this.rClient = this.req.locals.redisClient
    this.killRTP = false //set a marker to destroy rtpengine sessions in some scenarios
    this.callScript = req.locals.callScript,
    this.callActive = true
    this.successfullyConnected = false //set a marker to know if a connect was answered
    this.ringing = null //set by connectCall while ringing client extensions (for pickup)
    this.connectedClient = null //client extension currently connected (for connected pickup)
    this.connectedCodecs = null //codecs of the connected client leg (for connected pickup)
    this.activeConnection = null //the live connection activity, so pickup can unwind it
    this.handedOff = false //set true when this call is picked up/stolen by another session
    this.schedule = []
    this.req.on('cancel', () => {
      this.logger.info('Call cancelled')
      this.callActive = false
    })
    this.statusHook = new StatusHook(this.logger, this.req, this.req.locals.statusHook)
    this.activeRecording = false
  }

  async run(schedule){
    this.schedule = schedule;
    while (0< this.schedule.length) {
      let activity = this.schedule.shift()
      if (this.callActive && !this.handedOff){
        // Once a pickup verb in another session has taken over this call
        // (handedOff), stop running our remaining verbs. Otherwise a fallback
        // verb (e.g. response 486 after the stolen connect fails) would send a
        // final response on the caller's res that the pickup still needs to
        // answer with 200, causing "final response already sent".
        this.logger.info(`Starting activity: ${activity.name}`);
        await new Promise(resolve => {
          activity.once('done', (success) => {
            this.logger.info('Action complete');
            resolve();
          });
          activity.action();
        });
      } 
    }
    this.logger.info('All activities completed');
    if (this.handedOff) {
      // This call's A-leg, dialog and rtpengine session were taken over by a
      // pickup verb in another session, which now owns their teardown. Exit
      // without retrying, terminating the leg, or deleting rtpengine.
      this.logger.info('Session handed off (picked up); skipping cleanup');
      return;
    }
    if (this.killRTP){
      rtpClient.delete(RTPENGINE_PORT, RTPENGINE_HOST, this.details);
    }
    if (this.successfullyConnected && this.dialog.uas.connected){
      //terminate the inbound call
      this.logger.info('Terminating A Leg')
      this.dialog.uas.destroy()
    }
    if (!this.res.finished && this.callActive && this.req.locals.count < 3) {
      // Call did not reach a result and is still active, 
      // Increment the count, fetch the script and execute the build/run cycle again
      this.req.locals.count += 1
      await getCallScript(this.req, this.res, false)
      // Refresh from req.locals: getCallScript writes the newly-fetched script
      // to req.locals.callScript, but build() reads this.callScript, which was
      // only set in the constructor. Without this the retry re-runs the ORIGINAL
      // script (e.g. re-dialling a connect) instead of the new one.
      this.callScript = this.req.locals.callScript
      this.execute()
    } 
    else {
      this.logger.info(`Max count reached: ${this.req.locals.count}`)
      this.res.send(604)
    }
  }

  async build(transfer=false) {
    if (this.callScript.length == 1 && this.callScript[0].verb == 'response') {
        // just a simple response script so no need to setup RTPEngine
        let action = await response.create(this, this.callScript[0]);
        this.schedule.push(action);
        return this.schedule;
    } else {
        // We're going to be doing something with media
        // Get the callers codecs
        if (this.req.locals.trunk) {
            // Copy so we don't mutate (and corrupt) the cached trunk config, and
            // default to DEFAULT_CODECS when the trunk has none configured.
            let codecs = Array.isArray(this.req.locals.trunk.codecs)
                ? [...this.req.locals.trunk.codecs]
                : [...DEFAULT_CODECS];
            this.srcDirectMedia = (codecs.indexOf('DIRECT') > 0);
            if (this.srcDirectMedia) codecs.splice(codecs.indexOf('DIRECT'), 1)
            this.srcCodecs = codecs
        } else {
            let key = `client:${this.req.locals.domain}:${this.req.locals.fromUri.user}`;
            let codecsJ = await this.rClient.hGet(key, 'codecs');
            let codecs = JSON.parse(codecsJ)
            this.srcDirectMedia = (codecs.indexOf('DIRECT') > 0);
            if (this.srcDirectMedia) codecs.splice(codecs.indexOf('DIRECT'), 1)
            this.srcCodecs = codecs
        }
        this.logger.info(`Source Codecs: ${this.srcCodecs}`)
        this.details = {'call-id': this.req.get('Call-Id'), 'from-tag': this.req.locals.fromHeader.params.tag};
        this.killRTP = true

        for (const item of this.callScript) {
            // Build each verb defensively: a failure in one verb's create()
            // (e.g. a media fetch error) should skip that verb and let the
            // rest of the call script run, not crash the whole process.
            try {
                switch (item.verb) {
                    case 'announce':
                        const ann = await announcement.create(this, rtpClient, item);
                        this.schedule.push(ann);
                        break;
                    case 'connect':
                        let conn = await connection.create(this, item, transfer);
                        this.schedule.push(conn);
                        break;
                    case 'response':
                        let resp = await response.create(this, item);
                        this.schedule.push(resp);
                        break;
                    case 'pause':
                        let pse = await pause.create(this, item);
                        this.schedule.push(pse);
                        break;
                    case 'record':
                        let rec = await record.create(this, item);
                        this.schedule.push(rec);
                        break;
                    case 'pickup':
                        let pu = await pickup.create(this, item);
                        this.schedule.push(pu);
                        break;
                    default:
                        this.logger.error(`Unknown Verb: ${item.verb}`)
                        break;
                }
            } catch (err) {
                this.logger.error({err: err.message || err, verb: item.verb, item},
                    `build: failed to create verb "${item.verb}", skipping`);
            }
        }
        return this.schedule;
    }
  }

  async execute() {
    const schedule = await this.build()
    await this.run(schedule)
  }

  // Re-control a live call from the REST API: run a new callScript on the kept
  // leg and terminate the other. Phase 1 supports keeping leg A (the uas) with a
  // connect (reconnect) — it mirrors the REFER/transfer flow in connectCall.
  // Returns once the new script has been applied and started; the script then
  // runs asynchronously on the call. Throws (with err.code) on validation
  // failures so the caller can map them to HTTP status codes.
  async updateLeg({ keep = 'A', callScript, statusHook } = {}) {
    keep = String(keep).toUpperCase();

    if (!(this.successfullyConnected && this.dialog && this.dialog.uas && this.dialog.uac)) {
      const err = new Error('call is not connected'); err.code = 'NOT_CONNECTED'; throw err;
    }
    if (keep !== 'A') {
      // Keeping leg B requires promoting the uac to the controlling leg (the
      // leg abstraction) — a later phase.
      const err = new Error('updating with leg=B is not yet implemented'); err.code = 'NOT_IMPLEMENTED'; throw err;
    }
    if (!Array.isArray(callScript) || callScript.length === 0) {
      const err = new Error('callScript must be a non-empty array of verbs'); err.code = 'BAD_SCRIPT'; throw err;
    }

    this.logger.info({keep, verbs: callScript.map(v => v && v.verb)}, 'updateLeg: applying new script to kept leg');

    // A provided statusHook replaces the session's for the remainder of the call.
    if (statusHook) {
      this.req.locals.statusHook = statusHook;
      this.statusHook = new StatusHook(this.logger, this.req, statusHook);
    }

    const keptDialog = this.dialog.uas;       // leg A
    const dropDialog = this.dialog.uac;       // leg B
    const activeConn = this.activeConnection; // the parked connect activity

    // Discard any verbs still queued from the original script so the new script
    // fully replaces the remainder of the call rather than running after it.
    this.schedule = [];

    // Build the new script in reconnect mode; activities are appended to
    // this.schedule (the array the parked run loop iterates).
    this.callScript = callScript;
    await this.build(true);

    // Detach the previous connect's handlers from both legs so neither its
    // teardown cascade nor its 'done' emit interferes. The new (reconnect)
    // connect re-wires the kept leg in _onConnected.
    try { keptDialog.removeAllListeners(); } catch (e) {}
    try { dropDialog.removeAllListeners(); } catch (e) {}

    // Terminate the other leg.
    this.uacActive = false;
    try { dropDialog.destroy(); } catch (e) {}

    this.statusHook.send('updateLeg:accepted', { leg: keep });

    // Unpark the run loop so it runs the appended activities on the kept leg.
    if (activeConn) {
      activeConn.emit('done', true);
    } else {
      this.logger.warn('updateLeg: no active connection to unpark; running schedule directly');
      this.run(this.schedule);
    }
  }
}


module.exports = CallSession;