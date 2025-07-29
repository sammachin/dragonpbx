const Emitter = require('events');

class test extends Emitter {
    constructor(data) {
        super();
        this.data = data;
        
        this.on('play', () => {
            console.log(`playing`, this.data)
        })

         this.on('stop', (foo) => {
            console.log(`stopping`, foo)
        })
    }
}