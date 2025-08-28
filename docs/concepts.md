
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