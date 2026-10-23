---
status: superseded
kind: decision
project: lantern-api
superseded_by: Decisions/2026-03 Lantern job queue on NATS JetStream
---
# Lantern job queue on Redis lists

**Decision:** lantern-api's background jobs go on a Redis list, `lantern:jobs`, taken with `BRPOPLPUSH`.

**Why:** Redis was already there for sessions, and a list is simple.
