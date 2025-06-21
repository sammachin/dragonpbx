const {request, getGlobalDispatcher, setGlobalDispatcher, Dispatcher, ProxyAgent, Client, Pool} = require('undici');
const parseUrl = require('parse-url');
const assert = require('assert');
const crypto = require('crypto');
const pools = new Map();
const {
  HTTP_POOL,
  HTTP_POOLSIZE,
  HTTP_PIPELINING,
  HTTP_TIMEOUT,
  HTTP_PROXY_IP,
  HTTP_PROXY_PORT,
  HTTP_PROXY_PROTOCOL,
  NODE_ENV,
  HTTP_USER_AGENT_HEADER,
  LOGLEVEL
} = require('../../settings');
const {HTTPResponseError} = require('./error');
const {isAbsoluteUrl, isRelativeUrl} = require('./utils')

const toBase64 = (str) => Buffer.from(str || '', 'utf8').toString('base64');

function basicAuth(username, password) {
  if (!username || !password) return {};
  const creds = `${username}:${password || ''}`;
  const header = `Basic ${toBase64(creds)}`;
  return {Authorization: header};
}

const defaultDispatcher = HTTP_PROXY_IP ?
  new ProxyAgent(`${HTTP_PROXY_PROTOCOL}://${HTTP_PROXY_IP}${HTTP_PROXY_PORT ? `:${HTTP_PROXY_PORT}` : ''}`) :
  getGlobalDispatcher();

setGlobalDispatcher(new class extends Dispatcher {
  dispatch(options, handler) {
    return defaultDispatcher.dispatch(options, handler);
  }
}());




function computeSignature(payload, timestamp, secret) {
  assert(secret);
  const data = `${timestamp}.${JSON.stringify(payload)}`;
  return crypto
    .createHmac('sha256', secret)
    .update(data, 'utf8')
    .digest('hex');
}

function roundTrip(startAt) {
  const diff = process.hrtime(startAt);
  const time = diff[0] * 1e3 + diff[1] * 1e-6;
  return time.toFixed(0);
}

function generateSigHeader(payload, secret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = computeSignature(payload, timestamp, secret);
  const scheme = 'v1';
  return {
    'Signature': `t=${timestamp},${scheme}=${signature}`
  };
}




class HttpRequestor extends Emitter {
  constructor(logger, account_sid, hook, secret) {
    super();

    assert(typeof hook === 'object');

    this.logger = logger;
    this.url = hook.url;
    this.method = hook.method || 'POST';

    this.username = hook.username;
    this.password = hook.password;
    this.secret = secret;
    this.account_sid = account_sid;

    assert(isAbsoluteUrl(this.url));
    assert(['GET', 'POST'].includes(this.method));

    this.method = hook.method || 'POST';
    this.authHeader = basicAuth(hook.username, hook.password);
    
    const u = this._parsedUrl = parseUrl(this.url);
    if (u.port) this._baseUrl = `${u.protocol}://${u.resource}:${u.port}`;
    else this._baseUrl = `${u.protocol}://${u.resource}`;
    this._protocol = u.protocol;
    this._resource = u.resource;
    this._port = u.port;
    this._search = u.search;
    this._usePools = HTTP_POOL && parseInt(HTTP_POOL);

    if (this._usePools) {
      if (pools.has(this._baseUrl)) {
        this.client = pools.get(this._baseUrl);
      }
      else {
        const connections = HTTP_POOLSIZE ? parseInt(HTTP_POOLSIZE) : 10;
        const pipelining = HTTP_PIPELINING ? parseInt(HTTP_PIPELINING) : 1;
        const pool = this.client = new Pool(this._baseUrl, {
          connections,
          pipelining
        });
        pools.set(this._baseUrl, pool);
        this.logger.debug(`HttpRequestor:created pool for ${this._baseUrl}`);
      }
    }
    else {
      if (u.port) this.client = new Client(`${u.protocol}://${u.resource}:${u.port}`);
      else this.client = new Client(`${u.protocol}://${u.resource}`);
    }

    if (NODE_ENV == 'test' && process.env.JAMBONES_HTTP_PROXY_IP) {
      const defDispatcher =
        new ProxyAgent(`${process.env.JAMBONES_HTTP_PROXY_PROTOCOL}://${process.env.JAMBONES_HTTP_PROXY_IP}${
          process.env.JAMBONES_HTTP_PROXY_PORT ? `:${process.env.JAMBONES_HTTP_PROXY_PORT}` : ''}`);

      setGlobalDispatcher(new class extends Dispatcher {
        dispatch(options, handler) {
          return defDispatcher.dispatch(options, handler);
        }
      }());
    }
  }

  get baseUrl() {
    return this._baseUrl;
  }

  close() {
    if (!this._usePools && !this.client?.closed) this.client.close();
  }

  /**
   * Make an HTTP request.
   * All requests use json bodies.
   * All requests expect a 200 statusCode on success
   * @param {object|string} hook - may be a absolute or relative url, or an object
   * @param {string} [hook.url] - an absolute or relative url
   * @param {string} [hook.method] - 'GET' or 'POST'
   * @param {string} [hook.username] - if basic auth is protecting the endpoint
   * @param {string} [hook.password] - if basic auth is protecting the endpoint
   * @param {object} [params] - request parameters
   */
  async request(type, hook, params, httpHeaders = {}) {

    //assert(HookMsgTypes.includes(type));

    const payload = params
    const url = hook.url || hook;
    const method = hook.method || 'POST';
    let buf = '';
    httpHeaders = {
      ...httpHeaders,
      ...(HTTP_USER_AGENT_HEADER && {'user-agent' : HTTP_USER_AGENT_HEADER})
    };

    assert.ok(url, 'HttpRequestor:request url was not provided');
    assert.ok, (['GET', 'POST'].includes(method), `HttpRequestor:request method must be 'GET' or 'POST' not ${method}`);
    const startAt = process.hrtime();

    let newClient;
    try {
      let client, path, query;
      if (isRelativeUrl(url)) {
        client = this.client;
        path = url;
      }
      else {
        const u = parseUrl(url);
        if (u.resource === this._resource && u.port === this._port && u.protocol === this._protocol) {
          client = this.client;
          path = u.pathname;
          query = u.query;
        }
        else {
          if (u.port) client = newClient = new Client(`${u.protocol}://${u.resource}:${u.port}`);
          else client = newClient = new Client(`${u.protocol}://${u.resource}`);
          path = u.pathname;
          query = u.query;
        }
      }
      const sigHeader = generateSigHeader(payload, this.secret);
      const hdrs = {
        ...sigHeader,
        ...this.authHeader,
        ...httpHeaders,
        ...('POST' === method && {'Content-Type': 'application/json'})
      };
      const absUrl = isRelativeUrl(url) ? `${this.baseUrl}${url}` : url;
      this.logger.debug({url, absUrl, hdrs}, 'send webhook');
      const {statusCode, headers, body} =  HTTP_PROXY_IP ? await request(
        this.baseUrl,
        {
          path,
          query,
          method,
          headers: hdrs,
          ...('POST' === method && {body: JSON.stringify(payload)}),
          timeout: HTTP_TIMEOUT,
          followRedirects: false
        }
      ) : await client.request({
        path,
        query,
        method,
        headers: hdrs,
        ...('POST' === method && {body: JSON.stringify(payload)}),
        timeout: HTTP_TIMEOUT,
        followRedirects: false
      });
      if (![200, 202, 204].includes(statusCode)) {
        const err = new HTTPResponseError(statusCode);
        throw err;
      }
      if (headers['content-type']?.includes('application/json')) {
        buf = await body.json();
      }
      if (newClient) newClient.close();
    } catch (err) {
      if (err.statusCode) {
        this.logger.info({baseUrl: this.baseUrl, url},
          `web callback returned unexpected status code ${err.statusCode}`);
      }
      else {
        this.logger.error({err, baseUrl: this.baseUrl, url},
          'web callback returned unexpected error');
      }
      let opts = {account_sid: this.account_sid};
      if (err.code === 'ECONNREFUSED') {
        opts = {...opts, alert_type: this.Alerter.AlertType.WEBHOOK_CONNECTION_FAILURE, url};
      }
      else if (err.name === 'StatusError') {
        opts = {...opts, alert_type: this.Alerter.AlertType.WEBHOOK_STATUS_FAILURE, url, status: err.statusCode};
      }
      else {
        opts = {...opts, alert_type: this.Alerter.AlertType.WEBHOOK_CONNECTION_FAILURE, url, detail: err.message};
      }
      this.Alerter.writeAlerts(opts).catch((err) => this.logger.info({err, opts}, 'Error writing alert'));

      if (newClient) newClient.close();
      throw err;
    }
    const rtt = roundTrip(startAt);
    //if (buf) this.stats.histogram('app.hook.response_time', rtt, ['hook_type:app']);

    if (buf) {
      this.logger.info({response: buf}, `HttpRequestor:request ${method} ${url} succeeded in ${rtt}ms`);
      return buf;
    }
  }
}

module.exports = HttpRequestor;
