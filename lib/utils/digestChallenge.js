const nonce = require('nonce')();
const debug = require('debug')('dragonpbx:registrar');
const bent = require('bent');
const qs = require('qs');
const crypto = require('crypto');
const { decrypt } = require('./utils');
const toBase64 = (str) => Buffer.from(str || '', 'utf8').toString('base64');

function basicAuth(username, password) {
  if (!username || !password) return {};
  const creds = `${username}:${password || ''}`;
  const header = `Basic ${toBase64(creds)}`;
  return {Authorization: header};
}

function respondChallenge(req, res) {
  const nonceValue = nonce();
  const {realm} = req.locals;
  const headers = {
    'WWW-Authenticate': `Digest realm="${realm}", algorithm=MD5, qop="auth", nonce="${nonceValue}"`
  };
  debug('sending a 401 challenge');
  res.send(401, {headers});
}

function parseAuthHeader(hdrValue) {
  const pieces = { scheme: 'digest'} ;
  ['username', 'realm', 'nonce', 'uri', 'algorithm', 'response', 'qop', 'nc', 'cnonce', 'opaque']
    .forEach((tok) => {
      const re = new RegExp(`[,\\s]{1}${tok}="?(.+?)[",]`) ;
      const arr = re.exec(hdrValue) ;
      if (arr) {
        pieces[tok] = arr[1];
        if (pieces[tok] && pieces[tok] === '"') pieces[tok] = '';
      }
    }) ;

  pieces.algorithm = pieces.algorithm || 'MD5' ;

  // this is kind of lame...nc= (or qop=) at the end fails the regex above,
  // should figure out how to fix that
  if (!pieces.nc && /nc=/.test(hdrValue)) {
    const arr = /nc=(.*)$/.exec(hdrValue) ;
    if (arr) {
      pieces.nc = arr[1];
    }
  }
  if (!pieces.qop && /qop=/.test(hdrValue)) {
    const arr = /qop=(.*)$/.exec(hdrValue) ;
    if (arr) {
      pieces.qop = arr[1];
    }
  }

  // check mandatory fields
  ['username', 'realm', 'nonce', 'uri', 'response'].forEach((tok) => {
    if (!pieces[tok]) throw new Error(`missing authorization component: ${tok}`);
  }) ;
  debug(`parsed header: ${JSON.stringify(pieces)}`);
  return pieces ;
}



function calculateResponse({username, realm, method, nonce, uri, nc, cnonce, qop}, password) {
  const ha1 = crypto.createHash('md5');
  ha1.update([username, realm, password].join(':'));
  const ha2 = crypto.createHash('md5');
  ha2.update([method, uri].join(':'));

  // Generate response hash
  const response = crypto.createHash('md5');
  const responseParams = [
    ha1.digest('hex'),
    nonce
  ];

  if (cnonce) {
    responseParams.push(nc);
    responseParams.push(cnonce);
  }

  if (qop) {
    responseParams.push(qop);
  }
  responseParams.push(ha2.digest('hex'));
  response.update(responseParams.join(':'));

  return response.digest('hex');
}


const digestChallenge = async(req, res, next) => {
  const {logger} = req.srf.locals;
  //const {stats} = req.srf.locals;
  logger.debug('digestChallenge')
  const {
    domain,
    registration_hook_method
  } = req.locals;

  // Cannot detect account, reject register request
  try {
    if (!domain) {
      return res.send(403, {
        headers: {
          'X-Reason': 'Unknown or invalid realm'
        }
      });
    }

    // challenge requests without credentials
    if (!req.has('Authorization')) return respondChallenge(req, res);

    const pieces = parseAuthHeader(req.get('Authorization'));
    const expires = req.registration ? req.registration.expires : null;
    req.authData = {
      source_address: req.source_address,
      source_port: req.source_port,
      method: req.method,
      ...('POST' === registration_hook_method && {headers: req.headers}),
      expires,
      ...pieces
    };
    logger.debug(req.authData, 'Authorization data');
    next()
  }
    catch (err) {
      logger.error(`Error ${err}, rejecting with 403`);
      return next(err);
  }
};

module.exports = digestChallenge;
