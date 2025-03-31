const { setTimeout } = require('node:timers/promises');
const EventEmitter = require('events');

class Activity extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
  }
  
  // Using async/await properly
  async action() {
    await setTimeout(3000);
    console.log(this.name);
    this.emit('done');
    return this.name;
  }
}

const plan = [
  { id: 'a' },
  { id: 'b' },
  { id: 'c' }
];

// Create the schedule once
const schedule = plan.map(item => new Activity(item.id));

// Better approach using async/await
async function run(schedule) {
  for (const activity of schedule) {
    console.log(`Starting activity: ${activity.name}`);
    await new Promise(resolve => {
      activity.once('done', (success) => {
        console.log('Action complete');
        resolve();
      });
      activity.action();
    });
  }
  console.log('All activities completed');
}

// Run the sequence
run();