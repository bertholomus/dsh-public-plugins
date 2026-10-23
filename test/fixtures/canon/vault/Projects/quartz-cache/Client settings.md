---
project: quartz-cache
tags: [quartz-cache, clients]
---
# Client settings

A client should give up on a read after 50 ms and retry at most twice, then read from the source of truth instead. Keep a pool of 32 connections per process.

lantern-api and harbor-gateway both use the shared client library `quartz-go`; set these options there, not in each service.
