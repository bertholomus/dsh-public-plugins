---
tags:
  - harbor-gateway
  - deploy
---
# Deploying the gateway

1. Build the image with `make image`.
2. Push it with `make push TAG=<version>`.
3. Roll it out one zone at a time: `deployctl rollout harbor-gateway --zone a`, then b, then c.

Wait for the health check in each zone before the next one. A rollout that fails its health check rolls back by itself.
