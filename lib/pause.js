const Emitter = require('events');
const { setTimeout } = require("timers/promises")


class pause extends Emitter {
    constructor(cs, params) {
        super();
        this.name = 'pause'
        this.req = cs.req;
        this.res = cs.res;
        this.srf = cs.req.srf;
        this.logger = cs.logger;
        this.params = params
    }

    static async create(cs, params) {
        const instance = new pause(cs, params);
        return instance;
    }

    async action(){
        this.logger.info(`Pausing for ${this.params.duration} seconds`)
        setTimeout(this.params.duration*1000)
        .then(() => {
            this.emit('done', true)
        })
    }

}
module.exports = pause;