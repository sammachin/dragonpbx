const DRACHTIO_HOST = process.env.DRACHTIO_HOST || 'sbc.sammachin.com';
const DRACHTIO_PORT = process.env.DRACHTIO_PORT || 9022;
const DRACHTIO_SECRET = process.env.DRACHTIO_SECRET || 'cymru';
const LOGLEVEL = process.env.LOGLEVEL || 'debug';
const WEBPORT = process.env.WEBPORT || 4000;

const DB_USER = process.env.DB_USER || 'postgres'
const DB_PASSWORD = process.env.DB_PASSWORD || 'my_password'
const DB_HOST = process.env.DB_HOST || 'localhost'
const DB_PORT = process.env.DB_PORT || 5432

const  HTTP_POOL = process.env.HTTP_POOL || false
const  HTTP_POOLSIZE = process.env.HTTP_POOLSIZE || 3
const  HTTP_PIPELINING = process.env.HTTP_PIPELINING || false
const  HTTP_TIMEOUT = process.env.HTTP_TIMEOUT || 30
const  HTTP_PROXY_IP = process.env.HTTP_PROXY_IP || false
const  HTTP_PROXY_PORT = process.env.HTTP_PROXY_PORT || false
const  HTTP_PROXY_PROTOCOL = process.env.HTTP_PROXY_PROTOCOL || false
const  NODE_ENV = process.env.NODE_ENV 
const  HTTP_USER_AGENT_HEADER = process.env.HTTP_USER_AGENT_HEADER || 'dragonpbx'

const REGISTRATION_MIN_SECS = process.env.REGISTRATION_MIN_SECS || 30
const REGISTRATION_MAX_SECS = process.env.REGISTRATION_MAX_SECS || 3600

module.exports = {
  DRACHTIO_HOST,
  DRACHTIO_PORT,
  DRACHTIO_SECRET,
  LOGLEVEL,
  WEBPORT,
  DB_HOST,
  DB_USER,
  DB_PASSWORD,
  DB_PORT,
  HTTP_POOL,
  HTTP_POOLSIZE,
  HTTP_PIPELINING,
  HTTP_TIMEOUT,
  HTTP_PROXY_IP,
  HTTP_PROXY_PORT,
  HTTP_PROXY_PROTOCOL,
  NODE_ENV,
  HTTP_USER_AGENT_HEADER,
  REGISTRATION_MIN_SECS,
  REGISTRATION_MAX_SECS
}