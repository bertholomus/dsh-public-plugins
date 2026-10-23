---
tags: [runbook, quartz-cache]
---
# Flushing the quartz cache

Flush one namespace, never the whole cluster: `quartzctl flush --namespace <name>`, from the bastion. A flush of `prices` or `sessions` sends every read to the databases for a few minutes, so do it outside 08:00 to 18:00 Pacific unless the cached data is wrong.

After a flush, watch the hit rate on the Quartz dashboard: it should climb back above 80% within 10 minutes.
