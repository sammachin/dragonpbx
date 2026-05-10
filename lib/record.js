const Emitter = require('events');
const crypto = require('crypto');

const rtpengine = require('rtpengine-client').Client;
const rtpClient = new rtpengine();
const { RTPENGINE_HOST, RTPENGINE_PORT } = require('../settings');
const { buildMetadata, buildMultipartBody, newBoundary, uuid } = require('./utils/siprec');

class record extends Emitter {
  constructor(cs, params) {
    super();
    this.name = 'record';
    this.cs = cs;
    this.req = cs.req;
    this.srf = cs.req.srf;
    this.logger = cs.logger;
    this.params = params;
    this.statusHook = cs.statusHook;

    this.siprecServer = params.siprecServer;
    this.from = this._normaliseFrom(params.from);
    this.proxy = params.proxy || null;
    this.auth = params.auth || null;
    this.extraHeaders = params.headers || {};
    this.metaExtra = params.metadata || {};
    // Optional codec override. Accepts a single codec name or an array.
    // If set, the offer to the SRS will only contain these codecs and
    // rtpengine will transcode the source legs as needed.
    if (params.codec) {
      this.codec = Array.isArray(params.codec) ? params.codec : [params.codec];
    } else {
      this.codec = null;
    }
    // Which call legs to record: 'a' (caller only), 'b' (callee only), or
    // 'both' (default).
    const legsParam = (params.legs || 'both').toLowerCase();
    if (!['a', 'b', 'both'].includes(legsParam)) {
      throw new Error(`record: invalid legs value '${params.legs}', expected 'a', 'b', or 'both'`);
    }
    this.legs = legsParam;
    // Some SRSes (e.g. jambonz) reject `Require: siprec`. Default true; set
    // params.requireSiprec=false to advertise via `Supported` instead.
    this.requireSiprec = params.requireSiprec !== false;

    this.siprecDialog = null;
    this.subscriberTag = null;
    this.sessionId = null;
    this.recording = false;
    this.starting = false;
  }

  static async create(cs, params) {
    return new record(cs, params);
  }

  async action() {
    if (!this.siprecServer) {
      this.logger.error('record: siprecServer is required');
      this.emit('done', false);
      return;
    }

    if (this.cs.recording) {
      this.logger.warn('record: another record verb is already armed; replacing');
    }
    this.cs.recording = this;
    this.logger.info(`record: armed for SIPREC server ${this.siprecServer}`);
    this.statusHook.send('record:armed', this.params);
    this.emit('done', true);
  }

  /**
   * Initiate the SIPREC dialog with the SRS.
   * Called by connectCall once the underlying call has been answered.
   */
  async start(dialog, details, calleeTag) {
    if (this.recording || this.starting) {
      this.logger.info('record: start called but session already active/starting');
      return;
    }
    this.starting = true;

    try {
      this.sessionId = uuid();
      // Pre-generate the subscriber tag and pass it via `to-tag`. rtpengine
      // identifies the subscription monologue by this tag for both
      // `subscribe answer` and `unsubscribe`.
      this.subscriberTag = crypto.randomBytes(8).toString('hex');

      this.logger.info(`record: opening SIPREC session ${this.sessionId} to ${this.siprecServer}`);
      this.statusHook.send('record:starting', this.params, { sessionId: this.sessionId });

      // Step 1: ask rtpengine for a forked-media offer SDP for both legs.
      // We pass an explicit `from-tags` list naming the caller's and callee's
      // tags rather than `flags: ['all']`. The "all" keyword pulls in any
      // phantom monologues left in rtpengine (e.g. the fake monologue
      // ringbacktone creates for early media), which produces an extra m=
      // line that the SRS won't answer and breaks the original call's media
      // routing. `siprec` populates per-stream labels for the metadata XML.
      const fromTags = [];
      if (this.legs === 'a' || this.legs === 'both') fromTags.push(details['from-tag']);
      if ((this.legs === 'b' || this.legs === 'both') && calleeTag) fromTags.push(calleeTag);
      if (fromTags.length === 0) {
        throw new Error(`record: no tags available for legs='${this.legs}' (calleeTag missing?)`);
      }
      const subRequest = {
        'call-id': details['call-id'],
        'to-tag': this.subscriberTag,
        'from-tags': fromTags,
        'flags': ['siprec']
      };
      if (this.codec) {
        // strip every codec from the source legs and offer only the chosen
        // one(s); rtpengine transcodes as required.
        subRequest.codec = { mask: ['all'], transcode: this.codec };
      }
      const subResponse = await rtpClient.subscribeRequest(RTPENGINE_PORT, RTPENGINE_HOST, subRequest);
      if (!subResponse || subResponse.result !== 'ok') {
        throw new Error(`rtpengine subscribe request failed: ${subResponse && subResponse['error-reason']}`);
      }
      // rtpengine echoes the to-tag (or generates one if we hadn't pre-set it)
      if (subResponse['to-tag']) this.subscriberTag = subResponse['to-tag'];
      const offerSdp = subResponse.sdp;
      this.logger.debug({ offerSdp, fromTags: subResponse['from-tags'], toTag: subResponse['to-tag'] }, 'record: subscribe request response');

      // Step 2: build SIPREC metadata XML
      const callerAor = this._getCallerAor();
      const calleeAor = this._getCalleeAor(dialog);
      const metadataXml = buildMetadata({
        sessionId: this.sessionId,
        originalCallId: details['call-id'],
        callerAor,
        callerName: this.metaExtra.callerName || this.req.locals.fromUri.user,
        calleeAor,
        calleeName: this.metaExtra.calleeName,
        startTime: new Date(),
        extra: this.metaExtra.session,
        legs: this.legs
      });

      // Step 3: send SIP INVITE to the SRS with multipart body
      const boundary = newBoundary();
      const body = buildMultipartBody(boundary, offerSdp, metadataXml);

      const headers = {
        'Content-Type': `multipart/mixed;boundary=${boundary}`,
        ...(this.requireSiprec ? { 'Require': 'siprec' } : { 'Supported': 'siprec' }),
        ...(this.from ? { From: this.from } : {}),
        ...this.extraHeaders
      };

      const opts = { headers, localSdp: body };
      if (this.proxy) opts.proxy = this.proxy;
      if (this.auth) opts.auth = this.auth;

      this.logger.debug({ uri: this.siprecServer, headers }, 'record: sending SIPREC INVITE');

      this.siprecDialog = await this.srf.createUAC(this.siprecServer, opts);
      this.logger.info(`record: SRS answered, completing media fork`);

      // Step 4: hand the SRS answer SDP back to rtpengine.
      // `allow transcoding` lets rtpengine accept an answer that doesn't
      // mirror every offered codec - SRSes often only accept a subset.
      this.logger.debug({ srsSdp: this.siprecDialog.remote.sdp }, 'record: SRS answer SDP');
      const ansResponse = await rtpClient.subscribeAnswer(RTPENGINE_PORT, RTPENGINE_HOST, {
        'call-id': details['call-id'],
        'to-tag': this.subscriberTag,
        'sdp': this.siprecDialog.remote.sdp,
        'flags': ['siprec', 'allow transcoding']
      });
      if (!ansResponse || ansResponse.result !== 'ok') {
        throw new Error(`rtpengine subscribe answer failed: ${ansResponse && ansResponse['error-reason']}`);
      }

      this.recording = true;
      this.starting = false;
      this.logger.info(`record: SIPREC session ${this.sessionId} active`);
      this.statusHook.send('record:active', this.params, { sessionId: this.sessionId });

      this.siprecDialog.on('destroy', () => {
        this.logger.info('record: SRS terminated SIPREC dialog');
        this.recording = false;
        this.statusHook.send('record:ended', this.params, { sessionId: this.sessionId, endedBy: 'SRS' });
      });
    } catch (err) {
      this.starting = false;
      this.recording = false;
      this.logger.error({ err: err.message || err }, 'record: failed to start SIPREC session');
      this.statusHook.send('record:failed', this.params, {
        sessionId: this.sessionId,
        error: err.message || String(err)
      });
      // best-effort cleanup of any rtpengine subscription that may have been created
      try {
        if (this.subscriberTag) {
          await rtpClient.unsubscribe(RTPENGINE_PORT, RTPENGINE_HOST, {
            'call-id': details['call-id'],
            'to-tag': this.subscriberTag
          });
        }
      } catch (_) { /* ignore */ }
    }
  }

  /**
   * Tear down the SIPREC dialog and rtpengine subscription.
   * Called by connectCall when the underlying call ends.
   */
  async stop() {
    if (!this.recording && !this.starting) return;
    const wasRecording = this.recording;
    this.recording = false;
    this.starting = false;

    if (this.siprecDialog && this.siprecDialog.connected) {
      try {
        this.logger.info('record: sending BYE to SRS');
        await this.siprecDialog.destroy();
      } catch (err) {
        this.logger.error({ err: err.message || err }, 'record: error destroying SIPREC dialog');
      }
    }

    try {
      const details = this.cs.details;
      if (details && this.subscriberTag) {
        await rtpClient.unsubscribe(RTPENGINE_PORT, RTPENGINE_HOST, {
          'call-id': details['call-id'],
          'to-tag': this.subscriberTag
        });
      }
    } catch (err) {
      this.logger.error({ err: err.message || err }, 'record: error unsubscribing from rtpengine');
    }

    if (wasRecording) {
      this.statusHook.send('record:stopped', this.params, { sessionId: this.sessionId });
    }
  }

  /**
   * Normalise the `from` param. Accepts:
   *   - a bare user (e.g. "pbx")               => sip:pbx@<call's domain>
   *   - a full URI (sip:user@host)             => used as-is
   *   - a display-name form ("X" <sip:...>)    => used as-is
   */
  _normaliseFrom(from) {
    if (!from) return null;
    const s = String(from).trim();
    if (!s) return null;
    if (/^sips?:/i.test(s) || s.includes('<')) return s;
    const domain = this.req.locals && this.req.locals.domain;
    if (!domain) {
      this.logger.warn(`record: from='${s}' is a bare user but no domain on the call - using verbatim`);
      return s;
    }
    return `sip:${s}@${domain}`;
  }

  _getCallerAor() {
    const user = this.req.locals.fromUri && this.req.locals.fromUri.user;
    const domain = this.req.locals.domain;
    if (user && domain) return `sip:${user}@${domain}`;
    try {
      return this.req.getParsedHeader('From').uri || 'sip:unknown@unknown';
    } catch {
      return 'sip:unknown@unknown';
    }
  }

  _getCalleeAor(dialog) {
    try {
      if (dialog && dialog.uac && dialog.uac.remote && dialog.uac.remote.uri) {
        return dialog.uac.remote.uri;
      }
      if (dialog && dialog.remote && dialog.remote.uri) {
        return dialog.remote.uri;
      }
    } catch (_) { /* ignore */ }
    return 'sip:unknown@unknown';
  }
}

module.exports = record;
