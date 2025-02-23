const DRACHTIO_HOST = process.env.DRACHTIO_HOST || 'sbc.sammachin.com';
const DRACHTIO_PORT = process.env.DRACHTIO_PORT || 9022;
const DRACHTIO_SECRET = process.env.DRACHTIO_SECRET || 'cymru';
const LOGLEVEL = process.env.LOGLEVEL || 'info';
const WEBPORT = process.env.WEBPORT || 4000;

const DB_USER = process.env.DB_USER || 'postgres'
const DB_PASSWORD = process.env.DB_PASSWORD || 'my_password'
const DB_HOST = process.env.DB_HOST || 'localhost'
const DB_PORT = process.env.DB_PORT || 5432


module.exports = {
  DRACHTIO_HOST,
  DRACHTIO_PORT,
  DRACHTIO_SECRET,
  LOGLEVEL,
  WEBPORT,
  DB_HOST,
  DB_USER,
  DB_PASSWORD,
  DB_PORT
}