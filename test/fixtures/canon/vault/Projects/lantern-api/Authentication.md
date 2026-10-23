---
project: lantern-api
tags: [lantern-api, security]
---
# Authentication

Clients send their API key in the `X-Lantern-Key` header. Keys are made in the admin console and expire after 180 days; the console emails the key's owner two weeks before.

Calls between our own services use mutual TLS instead of keys, with the certificates from the TLS rotation runbook.

The token signing secret is kept in the secrets vault at `kv/lantern/signing`. Only the deploy job reads it.
