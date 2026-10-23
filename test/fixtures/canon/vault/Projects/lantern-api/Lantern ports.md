---
project: lantern-api
tags: [lantern-api, networking]
---
# Lantern ports

lantern-api serves HTTP on port 7311 and gRPC on port 7312. Its health check answers on port 7313 at `/healthz`; the load balancer and the deploy tool both read it there.

## Local runs

`make dev` starts it on the same ports. Stop anything else on 7311 first, or set `LANTERN_HTTP_PORT` to move it.
