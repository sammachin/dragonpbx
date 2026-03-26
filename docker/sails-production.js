module.exports.sockets = {
  onlyAllowOrigins: (process.env.ALLOWED_ORIGINS || 'http://localhost:1337').split(',')
};

module.exports.tokens = {};

if (process.env.MASTER_API_TOKEN) {
  module.exports.tokens[process.env.MASTER_API_TOKEN] = 1;
}
