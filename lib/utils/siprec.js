const crypto = require('crypto');

const uuid = () => crypto.randomUUID();

const escapeXml = (s) => {
  if (s === undefined || s === null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
};

/**
 * Build SIPREC recording metadata XML per RFC 7865/7866.
 *
 * @param {Object} p
 * @param {string} p.sessionId           Recording session id (UUID)
 * @param {string} p.originalCallId      Original call's SIP Call-ID
 * @param {string} p.callerAor           Caller AOR (sip:user@host)
 * @param {string} [p.callerName]        Caller display name
 * @param {string} p.calleeAor           Callee AOR (sip:user@host)
 * @param {string} [p.calleeName]        Callee display name
 * @param {Date}   [p.startTime]         Recording start time
 * @param {Object} [p.extra]             Custom name/value pairs added under <session>
 * @param {string} [p.legs]              Which legs are recorded: 'a', 'b', or 'both' (default)
 */
const buildMetadata = (p) => {
  const startTime = (p.startTime || new Date()).toISOString();
  const sId = p.sessionId;
  const legs = p.legs || 'both';

  let extras = '';
  if (p.extra && typeof p.extra === 'object') {
    for (const [k, v] of Object.entries(p.extra)) {
      extras += `    <${escapeXml(k)}>${escapeXml(v)}</${escapeXml(k)}>\n`;
    }
  }

  const participantBlock = (id, aor, name) =>
    `  <participant participant_id="${id}" session_id="${sId}">
    <nameID aor="${escapeXml(aor)}">
      <name>${escapeXml(name || aor)}</name>
    </nameID>
  </participant>
`;
  const streamBlock = (id, label) =>
    `  <stream stream_id="${id}" session_id="${sId}">
    <label>${label}</label>
  </stream>
`;

  const p1 = `${sId}-p1`;
  const p2 = `${sId}-p2`;
  const s1 = `${sId}-s1`;
  const s2 = `${sId}-s2`;

  let participants = '';
  let streams = '';
  let assocs = '';

  if (legs === 'both') {
    participants += participantBlock(p1, p.callerAor, p.callerName);
    participants += participantBlock(p2, p.calleeAor, p.calleeName);
    streams += streamBlock(s1, 1);
    streams += streamBlock(s2, 2);
    assocs +=
      `  <participantstreamassoc participant_id="${p1}">
    <send>${s1}</send>
    <recv>${s2}</recv>
  </participantstreamassoc>
  <participantstreamassoc participant_id="${p2}">
    <send>${s2}</send>
    <recv>${s1}</recv>
  </participantstreamassoc>
`;
  } else if (legs === 'a') {
    participants += participantBlock(p1, p.callerAor, p.callerName);
    streams += streamBlock(s1, 1);
    assocs +=
      `  <participantstreamassoc participant_id="${p1}">
    <send>${s1}</send>
  </participantstreamassoc>
`;
  } else if (legs === 'b') {
    participants += participantBlock(p2, p.calleeAor, p.calleeName);
    streams += streamBlock(s2, 1);
    assocs +=
      `  <participantstreamassoc participant_id="${p2}">
    <send>${s2}</send>
  </participantstreamassoc>
`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<recording xmlns="urn:ietf:params:xml:ns:recording:1">
  <datamode>complete</datamode>
  <session session_id="${sId}">
    <sipSessionID>${escapeXml(p.originalCallId)}</sipSessionID>
    <associate-time>${startTime}</associate-time>
${extras}  </session>
${participants}${streams}${assocs}</recording>
`;
};

/**
 * Build a multipart/mixed body containing the SDP offer and SIPREC metadata.
 * The boundary returned by this function should also be set in the
 * Content-Type header on the SIP request.
 */
const buildMultipartBody = (boundary, sdp, metadata) => {
  return `--${boundary}\r\n` +
    `Content-Type: application/sdp\r\n` +
    `Content-Disposition: session;handling=required\r\n` +
    `\r\n` +
    `${sdp}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/rs-metadata+xml\r\n` +
    `Content-Disposition: recording-session\r\n` +
    `\r\n` +
    `${metadata}\r\n` +
    `--${boundary}--\r\n`;
};

const newBoundary = () => `boundary-${crypto.randomBytes(8).toString('hex')}`;

module.exports = { buildMetadata, buildMultipartBody, newBoundary, uuid };
