---
tags: [idea, quartz-cache]
---
# Warming the quartz cache

Idea, not built yet: after a flush or a restart, replay the last hour of reads from the access log, so the hit rate recovers in about a minute instead of ten. Mei Lin has a prototype on the branch `warm-from-log`.
