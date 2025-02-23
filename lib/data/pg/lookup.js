const pg = require('pg')
const { Pool } = pg
const { LOGLEVEL, DB_HOST, DB_USER, DB_PASSWORD, DB_PORT } = require('../../../settings');

const pool = new Pool({
    user: DB_USER,
    password: DB_PASSWORD,
    host: DB_HOST,
    port: DB_PORT,
    database: 'dragonpbx',
  })


// TODO Add some caching here, this will get called A LOT
async function getDomain(domain){
    const query = {
        // give the query a unique name
        name: 'fetch-user',
        text: 'SELECT * FROM domains WHERE domain = $1',
        values: [domain],
    }
    const res = await pool.query(query)
    if (res.rowCount == 0){
        return false;
    } else {
        console.log(res)
        return res.rows[0]
    }
}

module.exports = {
    getDomain
}