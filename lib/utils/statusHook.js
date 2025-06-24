const Emitter = require('events');

const http = require('http');
const https = require('https');



class StatusHook extends Emitter {
  constructor(logger, req, url) {
    super();
    this.req = req;
    this.logger = logger
    this.url = url
    this.callId = req.get('Call-ID')
  }

  async send(event, params, data=false) {
    if (params.statusLabel === false) return;
    if (this.url){
      let body = {
        callId : this.callId,
        event,
        ...data
      }
      if (params.statusLabel !== undefined) {
        body.label = params.statusLabel;
      }
      this.logger.info(`statusHook: Sending ${JSON.stringify(body)}, to ${this.url}`)
      httpRequest(this.logger, this.url, body)
    }
  }
}

async function httpRequest(logger, uri, body) {
  try {
    // Parse the URI to determine if it's HTTP or HTTPS
    const url = new URL(uri);
    const protocol = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const requestOptions = {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 3000  // Set timeout to 3000ms (3 seconds)
      };
      const request = protocol.request(requestOptions, (response) => {
        let data = '';
        
        response.on('data', (chunk) => {
          data += chunk;
        });
        response.on('end', () => {
          if (response.statusCode !== 200) {
            logger.info(`Non-200 status code: ${response.statusCode}`);
            reject(new Error(`HTTP status code: ${response.statusCode}`));
            return;
          }
          try {
            const json = JSON.parse(data);
            resolve(json);
          } catch (err) {
            reject(new Error(`Failed to parse JSON: ${err.message}`));
          }
        });
      });
      // Handle request timeout
      request.on('timeout', () => {
        logger.info('Request timed out after 3000ms');
        request.destroy();
        reject(new Error('Request timeout after 3000ms'));
      });
      // Handle request errors
      request.on('error', (err) => {
        logger.info(`Error from calling callHook callback: ${err}`);
        reject(err);
      });
      // Send the request body
      request.write(JSON.stringify(body));
      request.end();
    });
  } catch (err) {
    logger.info(`Error from calling callHook callback: ${err}`);
    return false;
  }
}

module.exports = StatusHook;