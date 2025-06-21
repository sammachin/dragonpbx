const Emitter = require('events');

const connection = require('./connectCall')
const announcement = require('./playAnnouncement')
const response = require('./sendResponse')
const pause = require('./pause')

const rtpengine = require('rtpengine-client').Client
const rtpClient = new rtpengine();
const { RTPENGINE_HOST, RTPENGINE_PORT } = require('../settings');
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
    this.schedule = []
    this.req.on('cancel', () => {
      this.logger.info('Call cancelled')
      this.callActive = false
    })
  }

  async run(schedule){
    this.schedule = schedule;
    while (0< this.schedule.length) {
      let activity = this.schedule.shift()
      if (this.callActive){
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
        let action = new response(this, this.callScript[0]);
        this.schedule.push(action);
        return;
    } else {
        // We're going to be doing something with media
        // Get the callers codecs
        if (this.req.locals.trunk) {
            this.srcCodecs = this.req.locals.trunk.codecs
        } else {
            let key = `client:${this.req.locals.domain}:${this.req.locals.fromUri.user}`;
            let codecs = await this.rClient.hGet(key, 'codecs');
            this.srcCodecs = JSON.parse(codecs)
        }
        this.logger.info(`Source Codecs: ${this.srcCodecs}`)
        this.details = {'call-id': this.req.get('Call-Id'), 'from-tag': this.req.locals.fromHeader.params.tag};
        this.killRTP = true

        // Return the Promise chain
        return rtpClient.offer(RTPENGINE_PORT, RTPENGINE_HOST, Object.assign(this.details, {'sdp': this.req.body}))
            .then((rtpResponse) => {
                if (rtpResponse && rtpResponse.result === 'ok') return rtpResponse.sdp;
                throw new Error('rtpengine failure');
            })
            .then((sdpB) => {
                this.sdpB = sdpB;
            })
            .then(async () => {
                // Use for...of loop to properly handle async operations
                for (const item of this.callScript) {
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
                        default:
                            this.logger.error(`Unknown Verb: ${item.verb}`)
                            break;
                    }
                }
                // Return the schedule at the end of the chain
                return this.schedule;
            });
    }
  }

  async execute() {
    const schedule = await this.build()
    await this.run(schedule)
  } 
}


module.exports = CallSession;