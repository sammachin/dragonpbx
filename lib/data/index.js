const { DATA_SOURCE } = require('../../settings');

console.log(`using DATA SOURCE as ${DATA_SOURCE}`)

let getDomain, listDomains, getRegHook, getTrunkByIP, getTrunkById, getTrunkByName, getAuthTrunks, getRegTrunks, getTrunks;

switch (DATA_SOURCE){
    case 'json':
        ({ getDomain, listDomains, getRegHook, getTrunkByIP, getTrunkById, getTrunkByName, getAuthTrunks, getRegTrunks, getTrunks} = require('./json'))
        break;
    case 'api':
        ({ getDomain, listDomains, getRegHook, getTrunkByIP, getTrunkById, getTrunkByName, getAuthTrunks, getRegTrunks, getTrunks, scheduleConfigRefresh} = require('./api'))
        break;
    case 'pg':
        ({ getDomain, getRegHook, getTrunkByIP, getTrunkById, getTrunkByName, getAuthTrunks, getRegTrunks, getTrunks} = require('./pg'))
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
    getTrunks,
    listDomains
}