const Emitter = require('events');

const rtpengine = require('rtpengine-client').Client
const rtpClient = new rtpengine();
const { RTPENGINE_HOST, RTPENGINE_PORT, DEFAULT_RINGTONE, MEDIA_PATH } = require('../../settings');
const {generateDummySDP, isFileUrl} = require('./utils')
const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const http = require('http');  
const crypto = require('crypto');


class ringbacktone extends Emitter {
    constructor(cs, params) {
        super();
        this.req = cs.req;
        this.res = cs.res;
        this.srf = cs.req.srf;
        this.logger = cs.logger;
        this.sdpB = cs.sdpB;
        this.ringtone = params.ringtone || DEFAULT_RINGTONE
        this.details = {}
        this.playing = false
        this.ringBackToneFile = null
    

    this.on('play', () => {
        this.logger.info('PLAY')
        const dummyAnswer = {
            'call-id': this.req.get('Call-Id'),
            'sdp': generateDummySDP(),
            'from-tag' : this.req.locals.fromHeader.params.tag,
            'to-tag': this.req.locals.fromHeader.params.tag.split("").reverse().join("")
        }
        this.details = {'call-id': this.req.get('Call-Id'), 'from-tag': this.req.locals.fromHeader.params.tag};
        rtpClient.answer(RTPENGINE_PORT, RTPENGINE_HOST, dummyAnswer)
        .then((response) => {
            this.res.send(183, {
                body: response.sdp,
                headers: {
                    'Content-Type': 'application/sdp'
                }
            });
            this.logger.info(`Playing ringbacktone ${this.ringBackToneFile}`)
            this.playing = true
            rtpClient.playMedia(RTPENGINE_PORT, RTPENGINE_HOST,
                {
                'file': this.ringBackToneFile,
                'repeat-times': 600,
                ...this.details
                }, (err, result) => {
                if (err) {
                    console.error('Error playing ringbacktone:', err);
                    this.emit('done', false)
                }
            })
        });
    })
    this.on('stop', () => {
         this.logger.info('STOP')
        if (this.playing) {
            this.logger.info('STOPPING')
            rtpClient.stopMedia(RTPENGINE_PORT, RTPENGINE_HOST,
                {...this.details
                }, (err, result) => {
                if (err) {
                    console.error('Error stopping ringbacktone:', err);
                    this.emit('done', false)
                }
            })
        }
    })
    }

    async fetchMedia(){
        const url = this.ringtone
        if (isFileUrl(url)) {
            this.ringBackToneFile = MEDIA_PATH+url.split(':')[1]
            return
        } else {
            try {
                // Generate a hash of the URL to use as filename
                const urlHash = crypto.createHash('sha256').update(url).digest('hex');
                // Extract file extension from URL
                const urlPath = new URL(url).pathname;
                const extension = path.extname(urlPath);  
                // Create filename with hash and original extension
                const fileName = urlHash + extension;
                const filePath = path.join('/tmp', fileName);
                
                // Check if file already exists
                try {
                  await fs.access(filePath);
                  console.log(`File already exists in cache: ${filePath}`);
                  this.ringBackToneFile = filePath;
                  return
                } catch (error) {
                  // File doesn't exist, proceed with download
                  console.log(`File not in cache, downloading from: ${url}`);
                }
                
                // Download the file using embedded download logic
                const fileBuffer = await new Promise((resolve, reject) => {
                    const client = url.startsWith('https:') ? https : http;
                    const request = client.get(url, (response) => {
                        // Handle redirects
                        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                            return this.fetchMedia(response.headers.location)
                                .then(resolve)
                                .catch(reject);
                        }
                        // Check for successful response
                        if (response.statusCode !== 200) {
                            reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
                            return;
                        }
                        const chunks = [];
                        response.on('data', (chunk) => {
                            chunks.push(chunk);
                        });
                        response.on('end', () => {
                            const buffer = Buffer.concat(chunks);
                            resolve(buffer);
                        });
                        response.on('error', (error) => {
                            reject(error);
                        });
                    });
                    request.on('error', (error) => {
                        reject(error);
                    });
                    // Set a timeout
                    request.setTimeout(30000, () => {
                        request.destroy();
                        reject(new Error('Request timeout'));
                    });
                });
                
                // Write the file to /tmp
                await fs.writeFile(filePath, fileBuffer);
                console.log(`File downloaded and cached: ${filePath}`);
                this.ringBackToneFile = filePath;
                return
            } catch (error) {
                throw new Error(`Failed to fetch and cache file: ${error.message}`);
            }
        }
    }
}
 module.exports = ringbacktone;