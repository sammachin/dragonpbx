
const { LOGLEVEL } = require('../../../settings');
const config = require("../../../config.json")

// TODO Add some caching here, this will get called A LOT
async function getDomain(domain){
    if (!Object.keys(config.domains).includes(domain)){
        return false;
    } else {
        return config.domains[domain].domain_id
    }
}

module.exports = {
    getDomain
}