---
status: active
kind: decision
project: lantern-api
date: 2026-03-12
supersedes: Decisions/2025-11 Lantern job queue on Redis lists
---
# Lantern job queue on NATS JetStream

**Decision:** lantern-api's background jobs go through NATS JetStream, on the stream `LANTERN_JOBS`.

**Why:** jobs were lost whenever a Redis node restarted. JetStream keeps them on disk, delivers each one at least once and can replay a day of them, and the platform rotation already runs NATS for the gateway's events.

**Cost:** every job handler must be safe to run twice.
