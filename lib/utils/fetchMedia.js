const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { normaliseAudio, isFileUrl } = require('./utils');
const { MEDIA_PATH } = require('../../settings');

async function fetchMedia(url) {
    if (isFileUrl(url)) {
        return MEDIA_PATH + url.split(':')[1];
    }

    try {
        const urlHash = crypto.createHash('sha256').update(url).digest('hex');
        const wavFilePath = path.join('/tmp', `${urlHash}.wav`);

        try {
            await fs.access(wavFilePath);
            console.log(`Normalised WAV already exists in cache: ${wavFilePath}`);
            return wavFilePath;
        } catch (_) {}

        console.log(`File not in cache, downloading from: ${url}`);
        let contentType = '';
        const fileBuffer = await new Promise((resolve, reject) => {
            const client = url.startsWith('https:') ? https : http;
            const request = client.get(url, (response) => {
                if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                    return fetchMedia(response.headers.location)
                        .then(resolve)
                        .catch(reject);
                }
                if (response.statusCode !== 200) {
                    reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
                    return;
                }
                contentType = response.headers['content-type'] || '';
                const chunks = [];
                response.on('data', (chunk) => chunks.push(chunk));
                response.on('end', () => resolve(Buffer.concat(chunks)));
                response.on('error', reject);
            });
            request.on('error', reject);
            request.setTimeout(30000, () => {
                request.destroy();
                reject(new Error('Request timeout'));
            });
        });

        const isWav = contentType.includes('audio/wav') ||
                      contentType.includes('audio/wave') ||
                      contentType.includes('audio/x-wav');

        if (isWav) {
            await fs.writeFile(wavFilePath, fileBuffer);
            console.log(`WAV file downloaded and cached: ${wavFilePath}`);
            return wavFilePath;
        } else {
            const urlPath = new URL(url).pathname;
            const extension = path.extname(urlPath) || '.tmp';
            const rawFilePath = path.join('/tmp', `${urlHash}_raw${extension}`);
            await fs.writeFile(rawFilePath, fileBuffer);
            console.log(`Non-WAV content-type "${contentType}" - normalising to 8kHz WAV`);
            try {
                await normaliseAudio(rawFilePath, wavFilePath);
                console.log(`Normalised and cached: ${wavFilePath}`);
            } finally {
                await fs.unlink(rawFilePath).catch(() => {});
            }
            return wavFilePath;
        }
    } catch (error) {
        throw new Error(`Failed to fetch and cache file: ${error.message}`);
    }
}

module.exports = fetchMedia;
