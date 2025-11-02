const { DATA_SOURCE } = require('../../settings');

console.log(`using DATA SOURCE as ${DATA_SOURCE}`)


let getDomain, getRegHook, getTrunkByIP, getTrunkById, getTrunkByName;

switch (DATA_SOURCE){
    case 'json':
        ({ getDomain, getRegHook, getTrunkByIP, getTrunkById, getTrunkByName} = require('./json'))
        break;
    case 'api':
        ({ getDomain, getRegHook, getTrunkByIP, getTrunkById, getTrunkByName, scheduleConfigRefresh} = require('./api'))
        break;
    case 'pg':
        ({ getDomain, getRegHook, getTrunkByIP, getTrunkById, getTrunkByName} = require('./pg'))
        break;
}

module.exports = {
    getDomain,
    getRegHook,
    getTrunkByIP,
    getTrunkById,
    getTrunkByName
}