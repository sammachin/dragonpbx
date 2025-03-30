const { setTimeout } = require("timers/promises")
const Emitter = require('events');



class activity extends Emitter {
    constructor(name) {
        super();
        this.name = name
    }
    async action() {
        setTimeout(3000)
        .then(() =>{
            console.log(this.name)
            this.emit('done')
        })
    }
}

const plan = [
    {id:'a'},
    {id:'b'},
    {id:'c'}
]

let schedule = []

function load(){
    plan.forEach(x => {
        let act = new activity(x.id)
        schedule.push(act)
    });
}


async function run(){
    if (schedule.length != 0){
        act = schedule.shift()
        act.on('done', () => {
          console.log('action complete')
          run()
        })
        act.action()
    } else {
        return
    }
}



