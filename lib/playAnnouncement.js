const Emitter = require('events');
const { setTimeout } = require("timers/promises")
const {generateDummySDP, isFileUrl} = require('./utils/utils')
const { RTPENGINE_HOST, RTPENGINE_PORT, MEDIA_PATH } = require('../settings');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');  

class announcement extends Emitter {
    constructor(cs, rtpClient, params) {
        super();
        this.name = 'announcement'
        this.req = cs.req;
        this.res = cs.res;
        this.srf = cs.req.srf;
        this.logger = cs.logger;
        this.rtpClient = rtpClient;
        this.sdpB = cs.sdpB;
        this.params = params;
        this.media = null; // Will be set by static factory method
        this.statusHook = cs.statusHook
    }

    // Static factory method to create and initialize the instance
    static async create(cs, rtpClient, params) {
        const instance = new announcement(cs, rtpClient, params);
        instance.media = await instance.fetchMedia(params.url);
        return instance;
    }

    async fetchMedia(url){
        if (isFileUrl(url)) {
            return MEDIA_PATH+url.split(':')[1]
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
                  return filePath;
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
                return filePath;
            } catch (error) {
                throw new Error(`Failed to fetch and cache file: ${error.message}`);
            }
        }
    }

    async action(){
        const details = {'call-id': this.req.get('Call-Id'), 'from-tag': this.req.locals.fromHeader.params.tag};
        const dummyAnswer = {
            'call-id': this.req.get('Call-Id'),
            'sdp': generateDummySDP(),
            'from-tag' : this.req.locals.fromHeader.params.tag,
            'to-tag': this.req.locals.fromHeader.params.tag.split("").reverse().join("")
        }
        this.rtpClient.answer(RTPENGINE_PORT, RTPENGINE_HOST, dummyAnswer)
        .then((response) => {
            this.res.send(183, {
                body: response.sdp,
                headers: {
                    'Content-Type': 'application/sdp'
                }
            });
            this.logger.info(`Playing media ${this.media}`)
            this.statusHook.send('playback:start', this.params)
            this.rtpClient.playMedia(RTPENGINE_PORT, RTPENGINE_HOST,
                {
                'file': this.media,
                ...details
                }, (err, result) => {
                if (err) {
                    console.error('Error playing audio:', err);
                    this.emit('done', false)
                    this.sendStatus('playback:failed',this.params, {error: err})
                }
                setTimeout(result.duration)
                .then(() => {
                    this.emit('done', true)
                     this.statusHook.send('playback:complete', this.params, {duration: result.duration})
                })
            })
        });
        this.req.on('cancel', () =>{
            this.rtpClient.stopMedia(RTPENGINE_PORT, RTPENGINE_HOST, details)
            this.emit('done', false)
        })
    } 
}

module.exports = announcement;

// Usage:
// const announcementInstance = await announcement.create(cs, rtpClient, params);