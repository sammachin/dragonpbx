
## Announce

Plays a media file in Early Media if call has not yet been connected
### Params:
url: file:// path to localfilesystem

Can be sent multiple times at any stage of a call.

## Response
Sends a SIP response code 3xx-6xx
### Params
code: Integer representing SIP response code
headers: Object objectin containging additional SIP headers for the response

Will end the call handling when a response is sent, no other verbs after this will be actioned.

## Pause
Delays the call processing for defined number of seconds
### Params
duration: Int, number of seconds to wait

Can be sent multiple times at any stage of a call.

## Connect
Connect the call to another endpoint as a B2BUA
Endpoints can be clients, trunks or SIP URIs


