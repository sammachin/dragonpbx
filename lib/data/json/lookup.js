
const { LOGLEVEL } = require('../../../settings');
const config = require("../../../config.json")
const matcher = require('multimatch').default

// TODO Add some caching here, this will get called A LOT
async function getDomain(domain){
    if (!Object.keys(config.domains).includes(domain)){
        return false;
    } else {
        return config.domains[domain].domain_id
    }
}

async function getRegHook(domain, user){
    regHook = false
    config.domains[domain].clients.every(c => {
        if (matcher(user, c.username).length == 1){
            regHook = c.reghook
            return false        
        } else {
            return true
        }
    });
    return {url: regHook, method: "POST", username: false, password: false}
}
module.exports = {
    getDomain,
    getRegHook
}