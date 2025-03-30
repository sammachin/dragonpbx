const Srf = require('drachtio-srf');
const srf = new Srf();
const RtpEngineClient = require('rtpengine-client').Client;
const rtpe = new RtpEngineClient();


// Configure drachtio
srf.connect({
  host: 'your-drachtio-server',
  port: 9022,
  secret: 'your-secret'
});

// Configure rtpengine client
rtpe.connect('your-rtpengine-ip', 22222);

srf.invite((req, res) => {
  const callId = req.get('Call-ID');
  
  // Create rtpengine session for early media
  const sdpRequest = req.body;
  
  rtpe.offer({
    'call-id': callId,
    'sdp': sdpRequest,
    'replace': ['origin', 'session-connection'],
    'flags': ['transcode']
  }, (err, sdpResponse) => {
    if (err) {
      console.error('Error creating rtpengine session:', err);
      return res.send(500);
    }
    
    // Send 183 Session Progress with SDP
    res.send(183, {
      body: sdpResponse.sdp,
      headers: {
        'Content-Type': 'application/sdp'
      }
    });
    
    // Play early media file through rtpengine
    playEarlyMedia(callId, 'path/to/your/announcement.wav');
    
    // Continue with normal call flow after early media
    handleCallFlow(req, res, callId);
  });
});

function playEarlyMedia(callId, audioFile) {
  // Method 1: Use rtpengine's playaudio command if your version supports it
  rtpe.playaudio({
    'filename': audioFile,
  }, (err, result) => {
    if (err) {
      console.error('Error playing audio:', err);
    }
  });
  
  // Method 2: If playaudio isn't available, you can stream RTP directly
  // This is a simplified example and would need more implementation details
  /*
  const fileStream = createReadStream(audioFile);
  const rtpStream = convertToRtpStream(fileStream); // You would need to implement this
  
  rtpe.startRecording({
    'call-id': callId, 
    'stream-action': 'start',
    'direction': ['caller'],
    'stream': rtpStream
  });
  */
}

function handleCallFlow(req, res, callId) {
  // Wait for early media to complete (you might want to use a Promise or event)
  setTimeout(() => {
    // Continue normal call processing
    // This could be forwarding the call, answering it, etc.
    
    // Example: Forward call to final destination
    srf.createB2BUA(req, res, 'sip:destination@example.com', {
      headers: {
        'X-Played-Early-Media': 'true'
      },
      callerId: req.callingNumber
    })
    .then((dialog) => {
      console.log('Call connected to destination');
      
      // When call ends, clean up rtpengine session
      dialog.on('destroy', () => {
        rtpe.delete({
          'call-id': callId
        });
      });
    })
    .catch((err) => {
      console.error('Error connecting call:', err);
      rtpe.delete({
        'call-id': callId
      });
    });
  }, 5000); // Adjust timing based on your audio file length
}

srf.on('connect', (err, hostport) => {
  console.log(`Connected to drachtio server: ${hostport}`);
});

srf.on('error', (err) => {
  console.error(`Error connecting to drachtio server: ${err}`);
});