---
tags: [runbook, quartz-cache]
---
# Restarting a quartz-cache node

Restart one node at a time with `systemctl restart quartz` on that node, and wait until `quartzctl status` shows it in sync before you restart the next. A node rejoins in about 2 minutes; meanwhile the copy in the other zone serves its keys.
