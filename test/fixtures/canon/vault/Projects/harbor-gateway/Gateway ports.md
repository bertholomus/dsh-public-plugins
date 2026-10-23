---
title: Gateway ports
status: active
tags: [harbor-gateway, networking]
project: harbor-gateway
updated: 2026-09-30
---
# Gateway ports

The harbor gateway listens on port 8443 for HTTPS traffic and on port 8080 for its health check.

## Changing a port

Edit `listen` in `gateway.toml`, then restart the service with `systemctl restart harbor-gateway`. The load balancer reads the health check on 8080, so keep that one as it is.

## History

Port 9443 was used until the move in August 2026; nothing listens there now.
