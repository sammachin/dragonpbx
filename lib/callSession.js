const Emitter = require('events');

const connection = require('./connectCall');
const announcement = require('./playAnnouncement')
const response = require('./sendResponse')

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
  }

  async run(schedule){
    for (const activity of schedule) {
      if (this.callActive){
        console.log(`Starting activity: ${activity.name}`);
      await new Promise(resolve => {
        activity.once('done', (success) => {
          console.log('Action complete');
          resolve();
        });
        activity.action();
      });
      } 
    }
    console.log('All activities completed');
    if (this.killRTP){
      rtpClient.delete(RTPENGINE_PORT, RTPENGINE_HOST, this.details);
    }
  }

  async build() {
    let schedule = [];
    if (JSON.stringify(Object.keys(this.callScript)) === JSON.stringify(['response'])) {
      // just a simple response script so no need to setup RTPEngine
      console.log('SIMPLE RESPONSE')
      let action = new response(this, this.callScript.response);
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
          // First we do the announcements
          if (Object.keys(this.callScript).includes('announce')) {
            this.callScript.announce.forEach(a => {
              let action = new announcement(this, rtpClient, a);
              schedule.push(action);
            });
          }
          
          // Then we connect the call
          if (Object.keys(this.callScript).includes('connect')) {
            this.callScript.connect.forEach(a => {
              let action = new connection(this, a);
              schedule.push(action);
            });
          }
          
          // If there was an announcement followed by response add it here
          if (Object.keys(this.callScript).includes('response')) {
            // no need to loop as response is never an array
            let action = new response(this, this.callScript.response);
            schedule.push(action);
          }
          
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