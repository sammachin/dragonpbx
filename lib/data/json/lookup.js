
const { LOGLEVEL } = require('../../../settings');
const config = require("../../../config.json")
const matcher = require('multimatch').default
const CIDRMatcher = require('cidr-matcher');

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

async function getTrunkByIP(domain, ip){
    trunk = false
    config.domains[domain].trunks.every(t => {
        var matcher = new CIDRMatcher(t.inbound)
        if (matcher.contains(ip)){
            trunk = t
            return false
        } else{
            return true
        }
    })
    return trunk
}

async function getTrunkById(domain, id){
    trunk = false
    config.domains[domain].trunks.every(t => {
        if (t.id == id){
            trunk = t
            return false
        } else{
            return true
        }
    })
    return trunk
}

async function getTrunkByName(domain, name){
    trunk = false
    config.domains[domain].trunks.every(t => {
        if (t.name == name){
            trunk = t
            return false
        } else{
            return true
        }
    })
    return trunk
}
module.exports = {
    getDomain,
    getRegHook,
    getTrunkByIP,
    getTrunkById,
    getTrunkByName
}