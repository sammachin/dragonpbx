
const { LOGLEVEL, CONFIG_URL, CONFIG_TOKEN, CONFIG_TTL } = require('../../settings');
const matcher = require('multimatch').default
const CIDRMatcher = require('cidr-matcher');
const bent = require('bent');

let config ={}

async function getConfig() {
try {
    let headers = {Authorization: `Bearer ${CONFIG_TOKEN}`}
    const request = bent(
    'json',
    200,
    'GET',
    headers,
    );
    data = await request(CONFIG_URL);
    config = {domains: {}}
    data.domains.forEach((d) => {
        config.domains[d.domain] = {domain_id: d.id, trunks : d.trunks, clients : d.clients}
    })
    return true
} catch (err) {
    console.error(`Error fetching config url: ${err}`);
    return false;
}
}

async function scheduleConfigRefresh() {
  await getConfig();
  setTimeout(scheduleConfigRefresh, CONFIG_TTL * 1000);
}

scheduleConfigRefresh();

// TODO Add some caching here, this will get called A LOT
async function getDomain(domain){
    if (!Object.keys(config.domains).includes(domain)){
        return false;
    } else {
        return config.domains[domain].domain_id
    }
}

async function getRegHook(domain, user){
    reg = false
    config.domains[domain].clients.every(c => {
        if (matcher(user, c.username).length == 1){
            reg = c
            return false        
        } else {
            return true
        }
    });
    if (reg.hasOwnProperty('reghook')){
        return {url: reg.reghook, method: "POST", username: false, password: false}
    }
    else {
        return reg
    }    
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
        if (t.label == name){
            trunk = t
            return false
        } else{
            return true
        }
    })
    return trunk
}

async function getAuthTrunks(domain, name){
    trunks = []
    config.domains[domain].trunks.forEach(t => {
        if (t.authType == 'authentication'){
            trunks.push(t)
        }
    })
    return trunks
}

module.exports = {
    getDomain,
    getRegHook,
    getTrunkByIP,
    getTrunkById,
    getTrunkByName,
    scheduleConfigRefresh,
    getAuthTrunks
}