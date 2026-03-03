const crypto = require('crypto');
const algorithm = process.env.LEGACY_CRYPTO ? 'aes-256-ctr' : 'aes-256-cbc';
const secretKey = crypto.createHash('sha256')
  .update(process.env.ENCRYPTION_SECRET || process.env.JWT_SECRET || 'defaultSecret')
  .digest('base64')
  .substring(0, 32);

const matcher = require('multimatch').default
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * Normalise any audio file to 8kHz 16-bit mono PCM WAV
 * @param {string} inputPath - Path to input audio file (mp3, wav, ogg, etc.)
 * @param {string} [outputPath] - Optional output path; if omitted, writes to system temp dir
 * @returns {Promise<string>} - Resolves with the output file path
 */
const normaliseAudio = (inputPath, outputPath) => {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(inputPath)) {
      return reject(new Error(`Input file not found: ${inputPath}`));
    }

    if (!outputPath) {
      const basename = path.basename(inputPath, path.extname(inputPath));
      outputPath = path.join(os.tmpdir(), `${basename}_8k.wav`);
    }

    const args = [
      '-y',                  // overwrite output if exists
      '-i', inputPath,
      '-ar', '8000',         // 8kHz sample rate
      '-ac', '1',            // mono
      '-acodec', 'pcm_s16le', // 16-bit PCM
      '-f', 'wav',
      outputPath
    ];

    execFile('ffmpeg', args, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(`ffmpeg error: ${stderr || err.message}`));
      }
      resolve(outputPath);
    });
  });
}

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



const isAbsoluteUrl = (u) => {
  return typeof u === 'string' &&
    u.startsWith('https://') || u.startsWith('http://');
}

const isRelativeUrl = (u) =>  {
  return typeof u === 'string' && u.startsWith('/');
}

const isFileUrl = (u) => {
  return typeof u === 'string' &&
    u.startsWith('file:');
}

module.exports = {
  decrypt, generateDummySDP, isAbsoluteUrl, isRelativeUrl, isFileUrl, normaliseAudio
}