---
kind: decision
project: lantern-api
tags: [lantern-api, api]
date: 2026-04-08
---
# Lantern API versioning

**Decision:** the version is in the path (`/v2/...`). A field may be added at any time; removing or renaming one needs a new version.

An old version keeps working for 6 months after the next one ships. Its end is announced 90 days ahead, in the changelog and by email to every key owner.
