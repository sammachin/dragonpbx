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
        this.statusHook = cs.statusHook
    }

    static async create(cs, params) {
        const instance = new pause(cs, params);
        return instance;
    }

    async action(){
        this.logger.info(`Pausing for ${this.params.duration} seconds`)
        this.statusHook.send('pause:start', this.params, {duration: this.params.duration})
        setTimeout(this.params.duration*1000)
        .then(() => {
            this.emit('done', true)
            this.statusHook.send('pause:complete', this.params, {duration: this.params.duration})
        })
    }

}
module.exports = pause;