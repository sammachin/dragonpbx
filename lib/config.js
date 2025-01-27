const DRACHTIO_HOST = process.env.DRACHTIO_HOST || '127.0.0.1';
const DRACHTIO_PORT = process.env.DRACHTIO_PORT || 9022;
const DRACHTIO_SECRET = process.env.DRACHTIO_SECRET || 'cymru';
const LOGLEVEL = process.env.LOGLEVEL || 'info';

module.exports = {
  DRACHTIO_HOST,
  DRACHTIO_PORT,
  DRACHTIO_SECRET,
  LOGLEVEL
}