const Emitter = require('events');

//const connection = require('./connectCallSimple');
const connection = require('./connectCallMulti')
const announcement = require('./playAnnouncement')
const response = require('./sendResponse')
const pause = require('./pause')

const rtpengine = require('rtpengine-client').Client
const rtpClient = new rtpengine();
const { RTPENGINE_HOST, RTPENGINE_PORT } = require('../settings');


class CallSession extends Emitter {
  constructor(logger, req, res) {
    super();
    this.req = req;
    this.res = res;
    this.srf = req.srf;
    this.logger = logger.child({callId: req.get('Call-ID')});
    this.rclient = this.req.locals.redisClient
    this.killRTP = false //set a marker to destroy rtpengine sessions in some scenarios
    this.callScript = req.locals.callScript,
    this.callActive = true
    this.successfullyConnected = false //set a marker to know if a connect was answered
  }

  async run(schedule){
    for (const activity of schedule) {
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
    if (this.successfullyConnected && this.uasActive){
      //terminate the inbound call
      this.logger.info('Terminating A Leg')
      this.dialog.uas.destroy()
    }
  }

  async build() {
    let schedule = [];
    if (this.callScript.length ==1 && this.callScript[0].verb=='response') {
      // just a simple response script so no need to setup RTPEngine
      console.log('SIMPLE RESPONSE')
      let action = new response(this, this.callScript[0]);
      schedule.push(action);
      return schedule;
    }
    else {
      //We're going to be doing something with media
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
        .then(() => {
          this.callScript.forEach(item => {
            switch (item.verb) {
              case 'announce':
                let ann = new announcement(this, rtpClient, item);
                schedule.push(ann);
                break;
              case 'connect':
                let conn = new connection(this, item);
                schedule.push(conn);
                break
              case 'response':
                let resp = new response(this, item);
                schedule.push(resp);
                break
              case 'pause':
                let pse = new pause(this, item);
                schedule.push(pse);
                break
              default:
                this.logger.error(`Unknown Verb: $item.verb`)
                break;
            }
          });      
          // Return the schedule at the end of the chain
          return schedule;
        });
    }
  }


  async execute() {
    this.req.on('cancel', () => {
      console.log('CANCELED')
      this.callActive = false
    })
    let schedule = await this.build()
    this.run(schedule)
  } 
}


module.exports = CallSession;