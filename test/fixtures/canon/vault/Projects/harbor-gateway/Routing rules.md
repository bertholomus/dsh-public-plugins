---
project: harbor-gateway
tags: [harbor-gateway, routing]
---
# Routing rules

Routes live in `routes.yaml` in the harbor-gateway repo. Today:

- `/api/` goes to lantern-api.
- `/app/` goes to the lantern-web bucket.
- `/admin/cache/` goes to quartz-cache's admin port, for people on the VPN only.

A new route needs a review from the gateway's owner.
