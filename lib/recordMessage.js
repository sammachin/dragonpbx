const Emitter = require('events');
const { setTimeout } = require("timers/promises")
const {generateRecordSDP, isFileUrl} = require('./utils/utils')
const { RTPENGINE_HOST, RTPENGINE_PORT, MAX_RECORDING_DURATION } = require('../settings');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');  

class record extends Emitter {
    constructor(cs, rtpClient, params) {
        super();
        this.name = 'record'
        this.req = cs.req;
        this.res = cs.res;
        this.srf = cs.req.srf;
        this.logger = cs.logger;
        this.rtpClient = rtpClient;
        this.sdpB = cs.sdpB;
        this.params = params;
        this.statusHook = cs.statusHook
        this.duration = Math.min(this.params.duration || MAX_RECORDING_DURATION, MAX_RECORDING_DURATION)*1000;
        this.details = {}
        this.timeout = false
        this.cs = cs

        this.on('stopRecording', (reason) => {
            clearTimeout(this.timeout)
            if (this.active){
                this.logger.info(`stopRecording received due to: ${reason}`)
                this.rtpClient.stopRecording(RTPENGINE_PORT, RTPENGINE_HOST, this.details, (err, result) => {
                    if (err) { console.error('Error stopping recording audio:', err);}
                    this.emit('done', true)
                    this.statusHook.send('record:complete', this.params, {duration: this.duration})
                })
                this.active=false
            }
        })
    }

    // Static factory method to create and initialize the instance
    static async create(cs, rtpClient, params) {
        const instance = new record(cs, rtpClient, params);
        return instance;
    }


    async action(){
        this.details = {'call-id': this.req.get('Call-Id'), 'from-tag': this.req.locals.fromHeader.params.tag};
        const dummyAnswer = {
            'call-id': this.req.get('Call-Id'),
            'sdp': generateRecordSDP(),
            'from-tag' : this.req.locals.fromHeader.params.tag,
            'to-tag': this.req.locals.fromHeader.params.tag.split("").reverse().join("")
        }
        this.rtpClient.answer(RTPENGINE_PORT, RTPENGINE_HOST, dummyAnswer)
            .then((response) => {
                this.srf.createUAS(this.req, this.res, {
                    localSdp: response.sdp,
                })
                .then((uas) => {
                this.cs.dialog = {uas: uas}
                this.cs.successfullyConnected = true
                uas.on('destroy', (msg) => {
                    this.emit('stopRecording', 'hangup')
                });
                this.logger.info(`Start recording`)
                this.statusHook.send('record:start', this.params)
                this.rtpClient.startRecording(RTPENGINE_PORT, RTPENGINE_HOST,
                    {
                    ...this.details
                    }, (err, result) => {
                    if (err) {
                        console.error('Error recording audio:', err);
                        this.emit('done', false)
                        this.sendStatus('record:failed',this.params, {error: err})
                    }
                    this.active=true
                    this.timeout = setTimeout(this.duration)
                    .then(() => {
                        this.emit('stopRecording', 'timerEnd')
                    })
                })
            })
        });

        this.req.on('cancel', () =>{
            console.log('RECORD CANCEL')
            this.emit('stopRecording', 'callCancelled')
            this.emit('done', false)
        })

        this.req.on('bye', () => {
            console.log('Received BYE request');
        });
  
    }
    
}

module.exports = record;

