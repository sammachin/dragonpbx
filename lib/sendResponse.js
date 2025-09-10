const Emitter = require('events');
  

class response extends Emitter {
    constructor(cs, params) {
        super();
        this.name = 'response'
        this.req = cs.req;
        this.res = cs.res;
        this.srf = cs.req.srf;
        this.logger = cs.logger;
        this.params = params;
        this.cs = cs;
        this.statusHook = cs.statusHook
    }

    static async create(cs, params) {
        const instance = new response(cs, params);
        return instance;
    }

    async action(){
        this.statusHook.send('response:start', this.params)
        if (this.cs.successfullyConnected ){
            this.logger.info('Skipping action as call had already been connected ')
            this.statusHook.send('response:notsent', this.params)
            this.emit('done')
        } else {
            console.log(this.params)
            this.res.send(this.params.code, this.params.reason, {
                headers: this.params.headers ? this.params.headers : {},
            })
            this.emit('done', true)
            this.statusHook.send('response:complete', this.params)
        }
    }

}
module.exports = response;