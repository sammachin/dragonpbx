const crypto = require('crypto');
const algorithm = process.env.LEGACY_CRYPTO ? 'aes-256-ctr' : 'aes-256-cbc';
const secretKey = crypto.createHash('sha256')
  .update(process.env.ENCRYPTION_SECRET || process.env.JWT_SECRET || 'defaultSecret')
  .digest('base64')
  .substring(0, 32);

const matcher = require('multimatch').default


const decrypt = (data) => {
  const hash = JSON.parse(data);
  const decipher = crypto.createDecipheriv(algorithm, secretKey, Buffer.from(hash.iv, 'hex'));
  const decrpyted = Buffer.concat([decipher.update(Buffer.from(hash.content, 'hex')), decipher.final()]);
  return decrpyted.toString();
};


const generateDummySDP = () => {
  const sessionName = 'Dummy Session'
  const connectionIP = '127.0.0.1'

  // Generate random session ID, version and port
  const sessionId = Math.floor(Math.random() * 1000000000);
  const sessionVersion = Math.floor(Date.now() / 1000);
  const  audioPort = Math.floor(Math.random() * 5000) * 2 + 50000;

  let sdp = '';
  
  // Session description
  sdp += 'v=0\r\n'; // Version
  sdp += `o=- ${sessionId} ${sessionVersion} IN IP4 ${connectionIP}\r\n`; // Origin
  sdp += `s=${sessionName}\r\n`; // Session name
  sdp += `c=IN IP4 ${connectionIP}\r\n`; // Connection information
  sdp += 't=0 0\r\n'; // Time description (permanent session)
  
  // Audio media description
  sdp += `m=audio ${audioPort} RTP/AVP 0\r\n`; // Media description
  sdp += 'a=rtpmap:0 PCMU/8000\r\n'; // RTP map for PCMU
  sdp += 'a=sendonly\r\n'; // Send only
  
  return sdp;
}


module.exports = {
  decrypt, generateDummySDP
}