
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

### Params
reconnect: bool, If the call was already answered in a previous connect verb setting this to try will offer the call to the new destinations
dest: array, list of endppints to ring in paralel
dest.type: enum, client|trunk|sip type of endpoint
dest.address: string, client number, sip uri or number on trunk to connect to 
dest.trunk_id: int, ID of the trunk to dial out for type=trunk
dest.trunk_name: string, Name of the trunk to dial out when type=trunk (trunk_id will take priority)
dest.timeout: int, number of seconds to ring 
dest.proxy: string, SIP proxy to use for the call.