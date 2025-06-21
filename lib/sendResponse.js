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
    }

    static async create(cs, params) {
        const instance = new response(cs, params);
        return instance;
    }

    async action(){
        if (this.cs.successfullyConnected ){
            this.logger.info('Skipping action as call had already been connected ')
            this.emit('done')
        } else {
            this.res.send(this.params.code, {
                headers: this.params.headers ? this.params.headers : {}
            })
            this.emit('done', true)
        }
        
    }

}
module.exports = response;