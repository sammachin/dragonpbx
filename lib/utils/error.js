class NonFatalTaskError extends Error {
    constructor(msg) {
      super(msg);
    }
  }

  
  class HTTPResponseError extends Error {
    constructor(statusCode) {
      super('Unexpected HTTP Response');
      delete this.stack;
      this.statusCode = statusCode;
    }
  }
  
  module.exports = {
    NonFatalTaskError,
    HTTPResponseError
  };
  