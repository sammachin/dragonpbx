const nonce = require('nonce')();
const debug = require('debug')('dragonpbx:registrar');


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

const digestChallenge = async(req, res, next) => {
  const {logger} = req.srf.locals;
  const {
    domain,
    registration_hook_method
  } = req.locals;

  if (req.locals.trunk){
    logger.info('call from trunk, skipping digest')
    next() 
  } else {
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
      next()
    }
      catch (err) {
        logger.error(`Error ${err}, rejecting with 403`);
        return next(err);
    }
  }  
};

module.exports = digestChallenge;
