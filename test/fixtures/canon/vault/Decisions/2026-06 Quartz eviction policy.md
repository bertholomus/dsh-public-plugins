---
status: active
kind: decision
project: quartz-cache
date: 2026-06-04
---
# Quartz eviction policy

**Decision:** a quartz-cache node evicts the least recently used keys once it holds 48 GB, and every key expires 15 minutes after it was written, unless the client asks for less.

**Why:** the one-hour expiry before it served stale prices for too long. Fifteen minutes kept the hit rate above 90% in the load tests.
