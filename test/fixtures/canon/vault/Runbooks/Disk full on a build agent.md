---
tags: [runbook, ci]
---
# Disk full on a build agent

When a CI job fails with "no space left on device":

1. Log in to the agent through the bastion.
2. Run `docker system prune -af` and empty the build cache in `/var/cache/ci`.
3. If the disk is still more than 90% full, take the agent out of the pool with `cictl drain <agent>` and tell #infra.
