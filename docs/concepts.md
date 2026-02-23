
# Domain

Top level container in the system, calls and devices are all managed within the contruct of a domain,
Identified by unqiue FQDN, and Domain ID

# Endpoints
Collective term for Trunks and Registrations withing the context of a domain
Endpoints have dialplans associated with them

# Trunk
A SIP connection to an external system, inbound traffic is identified by IP addresses, outbound traffic is sent to a FQDN (or IP) and port
Can optionally use authentication and can make outbound SIP registrations.
Does not accept inbound registration (see clients)
Defined in config.json identified by ID
Dialplan is associated in config file

# Clients
A SIP Endpoint that registers to the system and calls a RegHook to authenticate the connection
Defined in config.json by the username field, may be a regex eg `1xxx`

# RegHook
HTTP endpoint that returns JSON in response to a SIP REGISTER from a client, contains an auth result eg 200, a DialPlan and optionally supported Codecs for the client.

# DialPlan
JSON document that lists a mapping of dialled numbers to CallHook URLs, can use basic regex to match ? to a single digit or * to multiple digits.

# CallHook
An HTTP or File URL that returns a CallScript, the CallHook contains details about the incomming call such as dialled number, domain and calling party.

# CallScript
JSON Document that contains a array of Verbs to be executed on the incomming call

# Verbs
The building blocks of call routing, ca either connect a call to another endpoint, send a SIP response message to reject a call, play an announcement or add a pause.


