const parseUri = require('drachtio-srf').parseUri;
const { getDomain, getAuthTrunks} = require('./data')
const crypto = require('crypto');

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

const isauthTrunk = async(req, res, next) =>{
  const {logger} = req.srf.locals;
      if (req.locals.authenticated){
        logger.info('call authenticated, skipping authTrunk')
        next() 
      } 
      else{
        const domain = parseUri(req.url).host
        const trunks = await getAuthTrunks(domain)
        trunks.forEach(t => {
          if (t.authUser == req.authData.username){
              validResponse = calculateResponse(req.authData, t.authPass)
              if (validResponse == req.authData.response) {
                req.locals.trunk = t;
                req.locals.authenticated = true;
                next()
              }
          }
        });
        next();
      }
}
module.exports = isauthTrunk;
