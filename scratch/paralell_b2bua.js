const Srf = require('drachtio-srf');
const srf = new Srf();

// Connect to the drachtio server
srf.connect({
  host: 'your-drachtio-server',
  port: 9022,
  secret: 'your-shared-secret'
});

srf.invite((req, res) => {
  const callId = req.get('Call-ID');
  console.log(`Received INVITE with Call-ID: ${callId}`);
  
  // Define multiple endpoints to call simultaneously
  const endpoints = [
    'sip:endpoint1@example.com',
    'sip:endpoint2@example.com',
    'sip:endpoint3@example.com'
  ];
  
  // Array to store all B2BUA attempts
  const b2bCalls = [];
  let isConnected = false;
  
  // Create promises for each B2BUA attempt
  const b2bPromises = endpoints.map((uri, index) => {
    return new Promise((resolve, reject) => {
      srf.createB2BUA(req, res, uri, {
        headers: {
          'X-Original-Call-ID': callId,
          'X-Endpoint-Index': index
        }
      })
        .then((dialog) => {
          // Store the successful dialog
          b2bCalls[index] = { dialog, status: 'connected' };
          
          if (!isConnected) {
            isConnected = true;
            resolve(dialog);
            
            // End all other calls
            b2bCalls.forEach((call, idx) => {
              if (idx !== index && call && call.dialog) {
                call.dialog.destroy();
              }
            });
          } else {
            // This call was successful but another one already won the race
            dialog.destroy();
            reject(new Error('Another call was already connected'));
          }
        })
        .catch((err) => {
          b2bCalls[index] = { status: 'failed', error: err };
          reject(err);
        });
    });
  });
  
  // Wait for the first successful call
  Promise.race(b2bPromises)
    .then((dialog) => {
      console.log('Successfully connected B2BUA call');
      dialog.on('destroy', () => {
        console.log('Call ended');
      });
    })
    .catch((err) => {
      console.error('All B2BUA attempts failed:', err);
      // Only send failure response if no successful connection was made
      if (!isConnected) {
        res.send(500);
      }
    });
});