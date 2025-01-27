const test = require('tape');
const { sippUac } = require('./sipp')('test_movius-proxy');

process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
});


function connect(connectable) {
  return new Promise((resolve, reject) => {
    connectable.on('connect', () => {
      return resolve();
    });
  });
}

function waitFor(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms * 1000);
  });
}

test('incoming call tests', async(t) => {
  const {srf} = require('../app');

  try {

    await connect(srf);

    await sippUac('uac.xml', '172.38.0.20');
    t.pass('incoming call with no SDP packet is rejected with a 488');

    srf.disconnect();
    t.end();
  } catch (err) {
    console.log(`error received: ${err}`);
    if (srf) srf.disconnect();
    t.error(err);
  }
})