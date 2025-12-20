const { DATA_SOURCE } = require('../../settings');

console.log(`using DATA SOURCE as ${DATA_SOURCE}`)

let getDomain, listDomains, getRegHook, getTrunkByIP, getTrunkById, getTrunkByName, getAuthTrunks, getRegTrunks;

switch (DATA_SOURCE){
    case 'json':
        ({ getDomain, listDomains, getRegHook, getTrunkByIP, getTrunkById, getTrunkByName, getAuthTrunks, getRegTrunks} = require('./json'))
        break;
    case 'api':
        ({ getDomain, listDomains, getRegHook, getTrunkByIP, getTrunkById, getTrunkByName, getAuthTrunks, getRegTrunks, scheduleConfigRefresh} = require('./api'))
        break;
    case 'pg':
        ({ getDomain, getRegHook, getTrunkByIP, getTrunkById, getTrunkByName, getAuthTrunks, getRegTrunks} = require('./pg'))
        break;
}

module.exports = {
    getDomain,
    getRegHook,
    getTrunkByIP,
    getTrunkById,
    getTrunkByName,
    getAuthTrunks,
    getRegTrunks,
    listDomains
}