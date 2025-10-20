const { DATA_SOURCE } = require('../../settings');

console.log(`using DATA SOURCE as ${DATA_SOURCE}`)


let getDomain, getRegHook, getTrunkByIP, getTrunkById, getTrunkByName;

switch (DATA_SOURCE){
    case 'json':
        ({ getDomain, getRegHook, getTrunkByIP, getTrunkById, getTrunkByName} = require('./json'))
        break;
    case 'webapp':
        ({ getDomain, getRegHook, getTrunkByIP, getTrunkById, getTrunkByName} = require('./api'))
        break;
    case 'postgres':
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