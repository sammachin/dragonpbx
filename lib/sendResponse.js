const Emitter = require('events');
  

class response extends Emitter {
    constructor(cs, params) {
        super();
        this.name = 'response'
        this.req = cs.req;
        this.res = cs.res;
        this.srf = cs.req.srf;
        this.logger = cs.req.logger;
        this.params = params
    }

    async action(){
        this.res.send(this.params.code, {
            headers: this.params.headers ? this.params.headers : {}
        })
        this.emit('done', true)
    }

}
module.exports = response;