---
status: active
aliases: [TLS rotation, certificate renewal]
tags: [tls, runbook]
---
# Rotating TLS certificates

Certificates expire every 90 days. Rotate them a week before they expire:

1. Run `certctl renew --all` on the bastion.
2. Reload each service that serves HTTPS (the harbor gateway reloads by itself within a minute).
3. Check the new expiry dates with `certctl list`.
