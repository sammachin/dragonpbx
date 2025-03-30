const Emitter = require('events');
const connectCall = require('./connectCall');
const announcement = require('./playAnnouncement')

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
  }

  async invite() {
    const details = {'call-id': this.req.get('Call-Id'), 'from-tag': this.req.locals.fromHeader.params.tag};
    rtpClient.offer(RTPENGINE_PORT, RTPENGINE_HOST, Object.assign(details, {'sdp': this.req.body}))
    .then((rtpResponse) => {
        if (rtpResponse && rtpResponse.result === 'ok') return rtpResponse.sdp;
        throw new Error('rtpengine failure');
    })
    .then((sdpB) => {
      this.sdpB = sdpB
      let params = {
        address: '1000',
        type: 'client',
        timeout: 60,
        cli: 8888
      }
      console.log(sdpB)
      let cs = this
      this.ancmt = new announcement(cs, rtpClient)
      this.ancmt.action()
      this.ancmt.on('accouncementEnd', result =>{
        this.call = new connectCall(cs)
        this.call.action(params);
        this.call.on('callEnd', result => {
        if (result.complete){
          console.log(`Call ended by ${result.endedBy} party`) 
        } else{
          console.log(`Call failed with status  ${result.status}`) 
        }
        })
      })
    })    
  }
}

module.exports = CallSession;